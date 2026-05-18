using Microsoft.AspNetCore.Authentication;
using Microsoft.OpenApi;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Mosaic.Backend.Data;
using Mosaic.Backend.Infrastructure;
using Mosaic.Backend.Middleware;
using Mosaic.Backend.Services;
using Mosaic.Backend.SidecarSignaling;
using Scalar.AspNetCore;
using tusdotnet;
using tusdotnet.Stores;
using System.Data.Common;
using System.Security.Cryptography;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using Mosaic.Backend.Crypto;

var builder = WebApplication.CreateBuilder(args);

// Database - use SQLite for development, PostgreSQL for production
var connectionString = builder.Configuration.GetConnectionString("Default");
var useSqlite = connectionString?.StartsWith("Data Source=", StringComparison.OrdinalIgnoreCase) ?? false;

builder.Services.AddDbContext<MosaicDbContext>(options =>
{
    if (useSqlite)
    {
        options.UseSqlite(connectionString);
        // Add interceptor to configure SQLite pragmas on connection open
        options.AddInterceptors(new SqlitePragmaInterceptor());
    }
    else
    {
        options.UseNpgsql(connectionString);
    }

    // Suppress the PendingModelChangesWarning - we handle migrations manually
    // This warning is new in EF Core 9 and can trigger false positives when the model
    // snapshot was generated with a different provider than the runtime provider
    options.ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning));
});

// Services
builder.Services.AddScoped<IStorageService, LocalStorageService>();
builder.Services.AddScoped<IQuotaSettingsService, QuotaSettingsService>();
builder.Services.AddScoped<ICurrentUserService, CurrentUserService>();
builder.Services.AddScoped<IEpochKeyRotationService, EpochKeyRotationService>();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<MosaicMetrics>();
builder.Services.AddOptions<IdempotencyOptions>()
    .Bind(builder.Configuration.GetSection("Idempotency"))
    .ValidateOnStart();
builder.Services.AddSingleton<IValidateOptions<IdempotencyOptions>, IdempotencyOptionsValidator>();
builder.Services.AddScoped<IAlbumExpirationService, AlbumExpirationService>();
builder.Services.AddScoped<IAuditLogService, AuditLogService>();
builder.Services.AddScoped<IUserErasureService, UserErasureService>();
builder.Services.AddSingleton<RustCoreHost>();
builder.Services.AddMemoryCache(options => options.SizeLimit = 10_000);
builder.Services.Configure<GcOptions>(builder.Configuration.GetSection("Gc"));
builder.Services.AddHostedService<GarbageCollectionService>();
builder.Services.AddHostedService<IdempotencyRecordCleanupHostedService>();
builder.Services.Configure<SessionCleanupOptions>(
    builder.Configuration.GetSection("Session:Cleanup"));
builder.Services.AddHostedService<SessionCleanupHostedService>();
builder.Services.Configure<AuthChallengeCleanupOptions>(
    builder.Configuration.GetSection("AuthChallenge:Cleanup"));
builder.Services.AddHostedService<AuthChallengeCleanupHostedService>();
builder.Services.AddExceptionHandler<DatabaseExceptionHandler>();
builder.Services.AddProblemDetails();

// v1.0.1 s29: localization for ProblemDetails titles/details and
// ValidationProblemDetails error messages. The ProblemDetailsLocalizationFilter
// translates English strings (used as resource keys) to the request's culture.
builder.Services.AddLocalization(opts => opts.ResourcesPath = "Resources");
builder.Services.Configure<Microsoft.AspNetCore.Builder.RequestLocalizationOptions>(opts =>
{
    var supported = new[]
    {
        new System.Globalization.CultureInfo("en"),
        new System.Globalization.CultureInfo("cs"),
    };
    opts.DefaultRequestCulture =
        new Microsoft.AspNetCore.Localization.RequestCulture("en");
    opts.SupportedCultures = supported;
    opts.SupportedUICultures = supported;
});
builder.Services.AddScoped<Mosaic.Backend.Localization.ProblemDetailsLocalizationFilter>();

// Sidecar Beacon: in-memory WebSocket signaling relay (no DB persistence, no auth).
builder.Services.Configure<SidecarSignalingOptions>(
    builder.Configuration.GetSection("SidecarSignaling"));
builder.Services.AddSingleton<RoomManager>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<RoomManager>());
builder.Services.AddSingleton<SidecarRateLimiter>();

// Controllers with camelCase JSON to match JavaScript conventions
builder.Services.AddControllers(options =>
    {
        // v1.0.1 s29: rewrite ProblemDetails.Title/Detail and
        // ValidationProblemDetails.Errors values via IStringLocalizer when an
        // Accept-Language header maps to a supported culture (currently en, cs).
        options.Filters.AddService<Mosaic.Backend.Localization.ProblemDetailsLocalizationFilter>();
    })
    .AddJsonOptions(options =>
    {
        options.JsonSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
        options.JsonSerializerOptions.PropertyNameCaseInsensitive = true;
        // Strict deserialization: unknown JSON properties become 400s rather than
        // being silently dropped. Matches the SidecarTelemetryEndpoint policy so
        // the whole API has one consistent contract-drift detection story
        // (v1.0.1 s23). Catches client/server schema drift early — especially
        // important post-API-versioning.
        options.JsonSerializerOptions.UnmappedMemberHandling =
            System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow;
    });

// Configure model validation to log errors (helpful for debugging)
builder.Services.Configure<Microsoft.AspNetCore.Mvc.ApiBehaviorOptions>(options =>
{
    var builtInFactory = options.InvalidModelStateResponseFactory;
    options.InvalidModelStateResponseFactory = context =>
    {
        var errors = context.ModelState
            .Where(x => x.Value?.Errors.Count > 0)
            .ToDictionary(
                kvp => kvp.Key,
                kvp => kvp.Value!.Errors.Select(e => e.ErrorMessage).ToArray()
            );

        var logger = context.HttpContext.RequestServices.GetRequiredService<ILoggerFactory>()
            .CreateLogger("ModelValidation");
        logger.LogWarning("Model validation failed for {Path}: {@Errors}", context.HttpContext.Request.Path, errors);

        return builtInFactory(context);
    };
});

builder.Services.AddOpenApi();

// Global rate limiting - relaxed in E2E Testing because Playwright runs many
// isolated users in parallel from localhost.
var globalRateLimitPermitLimit = builder.Environment.IsEnvironment("Testing") ? 10_000 : 100;
builder.Services.AddRateLimiter(options =>
{
    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
    {
        var remoteIp = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        return RateLimitPartition.GetFixedWindowLimiter(remoteIp, _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = globalRateLimitPermitLimit,
            Window = TimeSpan.FromMinutes(1),
            QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
            QueueLimit = 5
        });
    });

    options.OnRejected = async (context, token) =>
    {
        context.HttpContext.Response.StatusCode = 429;
        context.HttpContext.Response.Headers.RetryAfter = "60";
        context.HttpContext.Response.ContentType = "application/problem+json";
        var problem = new ProblemDetails
        {
            Status = StatusCodes.Status429TooManyRequests,
            Title = "Too many requests",
            Detail = "Too many requests. Please try again later."
        };
        problem.Extensions["correlationId"] = context.HttpContext.GetCorrelationId() ?? context.HttpContext.TraceIdentifier;
        await context.HttpContext.Response.WriteAsJsonAsync(problem, cancellationToken: token);
    };
});

// Add authentication handler for Forbid() support
// The actual authentication is done by CombinedAuthMiddleware, this just provides
// a scheme for the Forbid() calls in controllers to work properly
builder.Services.AddAuthentication(PassThroughAuthenticationHandler.SchemeName)
    .AddScheme<AuthenticationSchemeOptions, PassThroughAuthenticationHandler>(
        PassThroughAuthenticationHandler.SchemeName, null);

var authConfiguration = AuthConfigurationResolver.Resolve(builder.Configuration);
AuthConfigurationResolver.ValidateForStartup(builder.Configuration, builder.Environment, authConfiguration);

// NOTE: AllowedHosts is "*" in development but restricted in appsettings.Production.json.
// For production, set the environment variable AllowedHosts to your domain (e.g. "mosaic.example.com").

// Configure forwarded headers for reverse proxy support
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    var trustedProxies = builder.Configuration.GetSection("Auth:TrustedProxies").Get<string[]>() ?? [];

    // Always clear ASP.NET Core's built-in defaults (127.0.0.0/8 and ::1/128).
    // Only the explicitly-configured proxy list should be trusted — never implicit loopback defaults.
    // This ensures X-Forwarded-For spoofing cannot occur from connections that happen to originate
    // on loopback but are not part of our intended reverse-proxy topology.
    options.KnownIPNetworks.Clear();  // clears all network-range entries (new .NET 8+ API)
    options.KnownProxies.Clear();     // clears loopback IPs added by the ASP.NET Core defaults

    if (trustedProxies.Length == 0)
    {
        // No proxies configured: disable forwarded header processing entirely.
        // Without a known upstream proxy there is no basis for trusting any X-Forwarded-* header.
        options.ForwardedHeaders = ForwardedHeaders.None;
    }
    else
    {
        options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;

        foreach (var cidr in trustedProxies)
        {
            if (System.Net.IPNetwork.TryParse(cidr, out var network))
            {
                options.KnownIPNetworks.Add(network);
            }
        }
    }
});

// Ensure Auth:ServerSecret is set - generate a random one only for Development.
// Non-Development environments never reach the fallback path because ValidateForStartup fails fast.
var serverSecretMissing = string.IsNullOrWhiteSpace(builder.Configuration["Auth:ServerSecret"]);
if (serverSecretMissing)
{
    var secret = RandomNumberGenerator.GetBytes(32);
    builder.Configuration["Auth:ServerSecret"] = Convert.ToBase64String(secret);
}

var app = builder.Build();

if (serverSecretMissing)
{
    app.Logger.LogInformation("Auth:ServerSecret not configured - using auto-generated random secret for this session");
}

// Validate proxy trust configuration in Production.
// Broad catch-all CIDRs (0.0.0.0/0 or ::/0) are only appropriate for test environments.
// If they appear in Production the entire X-Forwarded-For trust model is broken, enabling
// rate-limit bypass and auth spoofing via a spoofed X-Forwarded-For header.
if (app.Environment.IsProduction())
{
    var productionProxies = app.Configuration.GetSection("Auth:TrustedProxies").Get<string[]>() ?? [];
    var broadCidrs = productionProxies.Where(c => c is "0.0.0.0/0" or "::/0").ToList();
    if (broadCidrs.Count > 0)
    {
        app.Logger.LogCritical(
            "⛔ SECURITY MISCONFIGURATION: Auth:TrustedProxies contains {Cidrs} in Production. " +
            "This trusts ALL IP addresses to set X-Forwarded-For, enabling rate-limit bypass " +
            "and auth spoofing. Restrict TrustedProxies to your actual reverse proxy addresses.",
            string.Join(", ", broadCidrs));
    }
}

// Security environment validation
if (app.Environment.IsDevelopment() || app.Environment.IsEnvironment("Testing"))
{
    app.Logger.LogWarning(
        "⚠️  SECURITY WARNING: Running in {Environment} mode. " +
        "Rate limiting and some security protections are DISABLED. " +
        "DO NOT use this configuration in production!",
        app.Environment.EnvironmentName);
}
else
{
    app.Logger.LogInformation(
        "Running in {Environment} mode with full security protections enabled",
        app.Environment.EnvironmentName);
}

if (authConfiguration.UsesLegacyMode)
{
    app.Logger.LogWarning(
        "Using legacy Auth:Mode configuration. Consider migrating to Auth:LocalAuthEnabled and Auth:ProxyAuthEnabled");
}

// Middleware order matters:
// 0. ForwardedHeaders - process X-Forwarded-* headers from reverse proxy (must be first)
// 1. RateLimiter - global rate limiting (100 req/min per IP)
// 2. ExceptionHandler - handle database concurrency exceptions gracefully
// 3. GlobalExceptionMiddleware - catch all other errors
// 4. CorrelationIdMiddleware - generate/extract correlation ID
// 5. LogScopeMiddleware - create logging scope with request context
// 6. RequestTimingMiddleware - log request timing
// 7. Auth middleware - authenticate user
app.UseForwardedHeaders();
// v1.0.1 s29: select request culture from Accept-Language so that
// ProblemDetailsLocalizationFilter can translate error titles/details.
app.UseRequestLocalization(app.Services
    .GetRequiredService<IOptions<Microsoft.AspNetCore.Builder.RequestLocalizationOptions>>().Value);
app.UseRateLimiter();
app.UseWebSockets();
app.UseExceptionHandler();
// D2 (batch 7, audit observability D-2): make framework-returned status
// codes (401/403/404/etc. from routing or auth pipeline that have no
// response body) carry an RFC 7807 ProblemDetails JSON body. Action-
// method returns from controllers that already use `Problem(...)` are
// unchanged. Combined with AddProblemDetails() (Program.cs) this means
// EVERY error response from the API is now ProblemDetails-shaped.
app.UseStatusCodePages();
app.UseMiddleware<GlobalExceptionMiddleware>();
app.UseMiddleware<CorrelationIdMiddleware>();
app.UseLogScope();
app.UseMiddleware<RequestTimingMiddleware>();

// Reject cross-origin state-changing requests. Runs BEFORE auth so the
// rejection happens regardless of whether cookies (LocalAuth) or
// ProxyAuth headers would have authenticated the request. See
// `Middleware/OriginValidationMiddleware.cs` for the rationale and the
// exempt-path list. Audit "threat-model C-1".
app.UseMiddleware<OriginValidationMiddleware>();

// Use combined auth middleware (supports both LocalAuth and ProxyAuth independently)
app.Logger.LogInformation(
    "Auth configuration: LocalAuth={LocalAuth}, ProxyAuth={ProxyAuth}",
    authConfiguration.LocalAuthEnabled, authConfiguration.ProxyAuthEnabled);
app.UseMiddleware<CombinedAuthMiddleware>();

// Add authentication/authorization middleware for Forbid() support
app.UseAuthentication();
app.UseAuthorization();

// Admin auth must come after regular auth
app.UseAdminAuth();

// Idempotency-Key replay cache for authenticated state-changing requests.
// Tus PATCH chunks intentionally bypass replay caching; Tus POST upload init is cached.
app.UseMiddleware<IdempotencyMiddleware>();

// Tus 2.0 client rejection (v1.0.1 s23). Returns 412 + Tus-Version: 1.0.0 for
// requests to /api/v1/files carrying Tus-Resumable: 2.0.0 (or any non-1.0.0
// version) per the Tus 1.0 spec. Runs before MapTus so the rejection is
// authoritative.
app.UseMiddleware<TusVersionMiddleware>();

// RFC 8594 Deprecation/Sunset header emission (v1.0.1 s23). Reads
// [DeprecatedRoute] metadata from the matched endpoint; no routes are
// deprecated today but future deprecations are mechanical — just decorate the
// action with [DeprecatedRoute(SunsetDate = "...", DeprecationDate = "...",
// Link = "...")] and the headers flow automatically.
app.UseMiddleware<DeprecationHeadersMiddleware>();

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference(options =>
    {
        options.WithTitle("Mosaic API");
        options.WithTheme(ScalarTheme.BluePlanet);
        options.WithDefaultHttpClient(ScalarTarget.CSharp, ScalarClient.HttpClient);
    });
}

// v1.0.1 s23 — OpenAPI schema export CLI for the CI drift gate.
//
// Invocation:
//   dotnet run --project apps/backend/Mosaic.Backend -- --export-openapi <path>
//
// Generates the OpenAPI document via the framework-registered
// OpenAPI document provider and exits before Kestrel binds a socket or
// migrations run. The CI workflow re-exports on each PR and
// `git diff --exit-code`s against docs/openapi.json so undeclared API
// drift fails the build instead of silently shipping. The schema is
// intentionally NOT exposed at /openapi/v1.json in Production — operators
// consume the committed file from the repo.
{
    var exportIdx = Array.IndexOf(args, "--export-openapi");
    if (exportIdx >= 0 && exportIdx < args.Length - 1)
    {
        var exportPath = args[exportIdx + 1];
        var provider = app.Services.GetRequiredKeyedService<Microsoft.AspNetCore.OpenApi.IOpenApiDocumentProvider>("v1");
        var document = await provider.GetOpenApiDocumentAsync();
        var dir = Path.GetDirectoryName(Path.GetFullPath(exportPath));
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }
        await using (var fs = File.Create(exportPath))
        await using (var writer = new StreamWriter(fs))
        {
            document.SerializeAsV3(new Microsoft.OpenApi.OpenApiJsonWriter(writer));
        }
        Console.WriteLine($"OpenAPI document exported to {exportPath}");
        return;
    }
}

// Tus endpoint for uploads
var storagePath = builder.Configuration["Storage:Path"] ?? "./data/blobs";
Directory.CreateDirectory(storagePath);

app.MapTus("/api/v1/files", async httpContext => new tusdotnet.Models.DefaultTusConfiguration
{
    Store = new TusDiskStore(storagePath),
    // Max upload size: 100 MB per shard
    // Note: Server cannot process images (resize, convert to WebP) because all content
    // is end-to-end encrypted. Image optimization must happen client-side before encryption.
    MaxAllowedUploadSizeInBytes = 100 * 1024 * 1024,
    Events = new()
    {
        OnAuthorizeAsync = async ctx =>
        {
            await TusEventHandlers.OnAuthorizeAsync(ctx, app.Services);
        },
        OnBeforeCreateAsync = async ctx =>
        {
            await TusEventHandlers.OnBeforeCreateAsync(ctx, app.Services);
        },
        OnCreateCompleteAsync = async ctx =>
        {
            await TusEventHandlers.OnCreateCompleteAsync(ctx, app.Services);
        },
        OnFileCompleteAsync = async ctx =>
        {
            await TusEventHandlers.OnFileCompleteAsync(ctx, app.Services);
        },
        OnDeleteCompleteAsync = async ctx =>
        {
            await TusEventHandlers.OnDeleteCompleteAsync(ctx, app.Services);
        }
    }
});

app.MapSidecarSignaling();
app.MapSidecarTelemetry();
app.MapControllers();

// Localhost-only Prometheus-text metrics endpoint (v1.0.1 s25).
// Operational surface, intentionally NOT under /api/v1/* — never exposed
// externally. The loopback guard belt-and-suspenders rejects any request
// whose connection origin isn't 127.0.0.1 / ::1; reverse proxies must
// terminate before forwarding here. Forwarded-headers are NOT consulted
// (RemoteIpAddress reflects the real socket peer after UseForwardedHeaders
// rewrites it, so a spoofed X-Forwarded-For from an untrusted source
// cannot bypass the check — KnownProxies is the gate).
app.MapGet("/metrics", (HttpContext ctx, MosaicMetrics metrics) =>
{
    var remoteIp = ctx.Connection.RemoteIpAddress;
    // Permit:
    //   * null (in-process call — TestServer / WebApplicationFactory)
    //   * any loopback address (127.0.0.0/8, ::1)
    //   * the IPv4/IPv6 "unspecified" sentinel (0.0.0.0, ::) which some
    //     in-process hosts and Kestrel-on-AnyIP synthesize for local
    //     connections before forwarded-headers fixes it.
    // Externally-routable requests are rejected with 403 — there is no
    // auth in front of /metrics, so the IP gate is the only access
    // control. Real Kestrel populates RemoteIpAddress with the real
    // socket peer, so a public-internet caller cannot reach this branch.
    if (remoteIp is not null
        && !System.Net.IPAddress.IsLoopback(remoteIp)
        && !remoteIp.Equals(System.Net.IPAddress.Any)
        && !remoteIp.Equals(System.Net.IPAddress.IPv6Any))
    {
        return Results.StatusCode(StatusCodes.Status403Forbidden);
    }

    return Results.Text(metrics.RenderPrometheusText(), "text/plain; version=0.0.4; charset=utf-8");
});

// Apply migrations on startup (dev mode or RUN_MIGRATIONS=true)
var runMigrations = app.Environment.IsDevelopment() ||
    string.Equals(builder.Configuration["RUN_MIGRATIONS"], "true", StringComparison.OrdinalIgnoreCase);

if (runMigrations)
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();

    // SQLite uses EnsureCreated (simpler for dev), PostgreSQL uses migrations
    // Note: SQLite pragmas (WAL mode, busy timeout) are configured via SqlitePragmaInterceptor
    if (useSqlite)
    {
        await db.Database.EnsureCreatedAsync();
        app.Logger.LogInformation("SQLite database initialized (pragmas configured via interceptor)");
    }
    else
    {
        await db.Database.MigrateAsync();
        app.Logger.LogInformation("PostgreSQL migrations applied");
    }
}

app.Run();

public partial class Program;


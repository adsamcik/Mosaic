using Microsoft.AspNetCore.Authentication;
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
builder.Services.AddScoped<IAlbumExpirationService, AlbumExpirationService>();
builder.Services.AddMemoryCache();
builder.Services.AddHostedService<GarbageCollectionService>();
builder.Services.AddExceptionHandler<DatabaseExceptionHandler>();
builder.Services.AddProblemDetails();

// Sidecar Beacon: in-memory WebSocket signaling relay (no DB persistence, no auth).
builder.Services.Configure<SidecarSignalingOptions>(
    builder.Configuration.GetSection("SidecarSignaling"));
builder.Services.AddSingleton<RoomManager>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<RoomManager>());
builder.Services.AddSingleton<SidecarRateLimiter>();

// Controllers with camelCase JSON to match JavaScript conventions
builder.Services.AddControllers()
    .AddJsonOptions(options =>
    {
        options.JsonSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
        options.JsonSerializerOptions.PropertyNameCaseInsensitive = true;
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
        await context.HttpContext.Response.WriteAsync(
            "Too many requests. Please try again later.", token);
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

// Ensure Auth:ServerSecret is set - generate random one if missing outside Production.
// Production never reaches the fallback path because ValidateForStartup above fails fast.
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
app.UseRateLimiter();
app.UseWebSockets();
app.UseExceptionHandler();
app.UseMiddleware<GlobalExceptionMiddleware>();
app.UseMiddleware<CorrelationIdMiddleware>();
app.UseLogScope();
app.UseMiddleware<RequestTimingMiddleware>();

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

// Tus endpoint for uploads
var storagePath = builder.Configuration["Storage:Path"] ?? "./data/blobs";
Directory.CreateDirectory(storagePath);

app.MapTus("/api/files", async httpContext => new tusdotnet.Models.DefaultTusConfiguration
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
app.MapControllers();

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

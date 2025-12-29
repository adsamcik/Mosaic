using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Mosaic.Backend.Data;
using Mosaic.Backend.Middleware;
using Mosaic.Backend.Services;
using Scalar.AspNetCore;
using tusdotnet;
using tusdotnet.Stores;

var builder = WebApplication.CreateBuilder(args);

// Database - use SQLite for development, PostgreSQL for production
var connectionString = builder.Configuration.GetConnectionString("Default");
var useSqlite = connectionString?.StartsWith("Data Source=", StringComparison.OrdinalIgnoreCase) ?? false;

builder.Services.AddDbContext<MosaicDbContext>(options =>
{
    if (useSqlite)
    {
        options.UseSqlite(connectionString);
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
builder.Services.AddMemoryCache();
builder.Services.AddHostedService<GarbageCollectionService>();

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

var app = builder.Build();

// Determine auth mode from configuration
var authMode = builder.Configuration["Auth:Mode"] ?? "ProxyAuth";
var isLocalAuth = authMode.Equals("LocalAuth", StringComparison.OrdinalIgnoreCase);

// Middleware order matters:
// 1. GlobalExceptionMiddleware - catch all errors first
// 2. CorrelationIdMiddleware - generate/extract correlation ID
// 3. LogScopeMiddleware - create logging scope with request context
// 4. RequestTimingMiddleware - log request timing
// 5. Auth middleware - authenticate user
app.UseMiddleware<GlobalExceptionMiddleware>();
app.UseMiddleware<CorrelationIdMiddleware>();
app.UseLogScope();
app.UseMiddleware<RequestTimingMiddleware>();

// Use appropriate auth middleware based on configuration
if (isLocalAuth)
{
    app.Logger.LogInformation("Using LocalAuth mode - session-based authentication");
    app.UseMiddleware<LocalAuthMiddleware>();
}
else
{
    app.Logger.LogInformation("Using ProxyAuth mode - trusting Remote-User header from proxy");
    app.UseMiddleware<TrustedProxyMiddleware>();
}

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
        OnBeforeCreateAsync = async ctx =>
        {
            await TusEventHandlers.OnBeforeCreate(ctx, app.Services);
        },
        OnFileCompleteAsync = async ctx =>
        {
            await TusEventHandlers.OnFileComplete(ctx, app.Services);
        }
    }
});

app.MapControllers();

// Apply migrations on startup (dev mode or RUN_MIGRATIONS=true)
var runMigrations = app.Environment.IsDevelopment() ||
    string.Equals(builder.Configuration["RUN_MIGRATIONS"], "true", StringComparison.OrdinalIgnoreCase);

if (runMigrations)
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
    
    // SQLite uses EnsureCreated (simpler for dev), PostgreSQL uses migrations
    if (useSqlite)
    {
        await db.Database.EnsureCreatedAsync();
        app.Logger.LogInformation("SQLite database initialized");
    }
    else
    {
        await db.Database.MigrateAsync();
        app.Logger.LogInformation("PostgreSQL migrations applied");
    }
}

app.Run();

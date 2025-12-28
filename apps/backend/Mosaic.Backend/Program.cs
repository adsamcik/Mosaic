using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Middleware;
using Mosaic.Backend.Services;
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
});

// Services
builder.Services.AddScoped<IStorageService, LocalStorageService>();
builder.Services.AddScoped<IQuotaSettingsService, QuotaSettingsService>();
builder.Services.AddMemoryCache();
builder.Services.AddHostedService<GarbageCollectionService>();

// Controllers
builder.Services.AddControllers();
builder.Services.AddOpenApi();

var app = builder.Build();

// Determine auth mode from configuration
var authMode = builder.Configuration["Auth:Mode"] ?? "ProxyAuth";
var isLocalAuth = authMode.Equals("LocalAuth", StringComparison.OrdinalIgnoreCase);

// Middleware order matters - exception handler must be first to catch all errors
app.UseMiddleware<GlobalExceptionMiddleware>();
app.UseMiddleware<CorrelationIdMiddleware>();
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
}

// Tus endpoint for uploads
var storagePath = builder.Configuration["Storage:Path"] ?? "./data/blobs";
Directory.CreateDirectory(storagePath);

app.MapTus("/api/files", async httpContext => new tusdotnet.Models.DefaultTusConfiguration
{
    Store = new TusDiskStore(storagePath),
    MaxAllowedUploadSizeInBytes = 6 * 1024 * 1024, // 6 MB max shard size
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

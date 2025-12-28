using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Middleware;
using Mosaic.Backend.Services;
using tusdotnet;
using tusdotnet.Stores;

var builder = WebApplication.CreateBuilder(args);

// Database
builder.Services.AddDbContext<MosaicDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Default")));

// Services
builder.Services.AddScoped<IStorageService, LocalStorageService>();
builder.Services.AddHostedService<GarbageCollectionService>();

// Controllers
builder.Services.AddControllers();
builder.Services.AddOpenApi();

var app = builder.Build();

// Determine auth mode from configuration
var authMode = builder.Configuration["Auth:Mode"] ?? "ProxyAuth";
var isLocalAuth = authMode.Equals("LocalAuth", StringComparison.OrdinalIgnoreCase);

// Middleware order matters
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
    await db.Database.MigrateAsync();
}

app.Run();

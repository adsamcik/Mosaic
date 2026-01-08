# Stream B: Backend + Database Implementation

**Duration:** 2 weeks  
**Depends On:** Phase 0 (OpenAPI spec + schema)  
**Parallel With:** Stream A (Crypto), Stream C (Frontend)  
**Deliverable:** `apps/backend/` - .NET 10 ASP.NET Core API

> **Parent:** `.github/copilot-instructions.md`

---

## 🚨 Non-Interactive Commands (CRITICAL)

**ALL terminal commands MUST be non-interactive.** Commands that wait for user input will hang indefinitely.

| Task | ❌ NEVER USE | ✅ ALWAYS USE |
|------|--------------|---------------|
| Run tests | — | `dotnet test apps/backend/Mosaic.Backend.Tests` |
| Build | — | `dotnet build apps/backend/Mosaic.Backend` |
| Run server | `dotnet watch run` | `dotnet run` with `isBackground=true` |
| Create project | `dotnet new webapi` (prompts) | `dotnet new webapi -n Name -o path` |
| Add package | — | `dotnet add package <name>` |
| Add migration | — | `dotnet ef migrations add <name>` |
| Update database | — | `dotnet ef database update` |

### Full Command Examples

```powershell
# ✅ Create new project (non-interactive)
dotnet new webapi -n Mosaic.Backend -o apps/backend

# ✅ Add packages (non-interactive)
dotnet add package Npgsql.EntityFrameworkCore.PostgreSQL

# ✅ Build backend
dotnet build apps/backend/Mosaic.Backend

# ✅ Run tests (non-interactive)
dotnet test apps/backend/Mosaic.Backend.Tests
```

### Output Capture Pattern

```powershell
# ✅ CORRECT - Capture output to file first
dotnet test 2>&1 | Out-File -FilePath "dotnet-test-output.txt" -Encoding utf8
Get-Content "dotnet-test-output.txt" | Select-String -Pattern "Passed|Failed"
```

---

## Context

You are implementing the "dumb server" backend for Mosaic. The server:
- NEVER sees plaintext content
- Stores encrypted blobs and metadata
- Trusts the upstream proxy for authentication (`Remote-User` header)
- Validates signatures using plaintext public keys (stored in `epoch_keys.sign_pubkey`)
- Manages storage quotas and garbage collection

---

## Technology Stack

- .NET 10 (ASP.NET Core Minimal APIs or Controllers)
- Entity Framework Core 9 with PostgreSQL 17
- tusdotnet for resumable uploads
- Npgsql for PostgreSQL driver

---

## Project Structure

```
apps/backend/
├── Mosaic.Backend.csproj
├── Program.cs
├── appsettings.json
├── appsettings.Development.json
├── Middleware/
│   ├── TrustedProxyMiddleware.cs
│   └── RequestTimingMiddleware.cs
├── Controllers/
│   ├── HealthController.cs
│   ├── UsersController.cs
│   ├── AlbumsController.cs
│   ├── ManifestsController.cs
│   ├── EpochKeysController.cs
│   └── ShardsController.cs
├── Services/
│   ├── IStorageService.cs
│   ├── LocalStorageService.cs
│   └── GarbageCollectionService.cs
├── Data/
│   ├── MosaicDbContext.cs
│   ├── Entities/
│   │   ├── User.cs
│   │   ├── Album.cs
│   │   ├── AlbumMember.cs
│   │   ├── EpochKey.cs
│   │   ├── Manifest.cs
│   │   ├── Shard.cs
│   │   ├── ManifestShard.cs
│   │   └── UserQuota.cs
│   └── Migrations/
├── Models/
│   ├── Requests/
│   └── Responses/
└── Extensions/
    └── ServiceCollectionExtensions.cs
```

---

## Task 1: Project Setup

### Create Project

```bash
dotnet new webapi -n Mosaic.Backend -o apps/backend
cd apps/backend
dotnet add package Npgsql.EntityFrameworkCore.PostgreSQL
dotnet add package tusdotnet
dotnet add package System.Linq.Async
```

### File: `appsettings.json`

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning"
    }
  },
  "ConnectionStrings": {
    "Default": "Host=localhost;Database=mosaic;Username=mosaic;Password=dev"
  },
  "Storage": {
    "Path": "./data/blobs"
  },
  "Auth": {
    "TrustedProxies": ["127.0.0.1", "::1", "172.16.0.0/12", "10.0.0.0/8"]
  },
  "Quota": {
    "DefaultMaxBytes": 10737418240
  }
}
```

### File: `Program.cs`

```csharp
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Middleware;
using Mosaic.Backend.Services;
using tusdotnet;

var builder = WebApplication.CreateBuilder(args);

// Database
builder.Services.AddDbContext<MosaicDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Default")));

// Services
builder.Services.AddScoped<IStorageService, LocalStorageService>();
builder.Services.AddHostedService<GarbageCollectionService>();

// Controllers
builder.Services.AddControllers();

var app = builder.Build();

// Middleware order matters
app.UseMiddleware<RequestTimingMiddleware>();
app.UseMiddleware<TrustedProxyMiddleware>();

// Tus endpoint for uploads
app.MapTus("/api/files", async ctx => new tusdotnet.Models.Configuration.DefaultTusConfiguration
{
    Store = new tusdotnet.Stores.TusDiskStore(
        builder.Configuration["Storage:Path"]!
    ),
    MaxAllowedUploadSizeInBytes = 6 * 1024 * 1024,
    Events = new()
    {
        OnFileCompleteAsync = async eventContext =>
        {
            await TusEventHandlers.OnFileComplete(eventContext, app.Services);
        }
    }
});

app.MapControllers();

// Apply migrations on startup (dev only)
if (app.Environment.IsDevelopment())
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
    await db.Database.MigrateAsync();
}

app.Run();
```

---

## Task 2: Database Entities and Context

### File: `Data/Entities/User.cs`

```csharp
namespace Mosaic.Backend.Data.Entities;

public class User
{
    public Guid Id { get; set; }
    public required string AuthSub { get; set; }
    public required string IdentityPubkey { get; set; }  // Base64 Ed25519
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    
    // Navigation
    public ICollection<Album> OwnedAlbums { get; set; } = [];
    public ICollection<AlbumMember> Memberships { get; set; } = [];
    public ICollection<EpochKey> EpochKeys { get; set; } = [];
    public UserQuota? Quota { get; set; }
}
```

### File: `Data/Entities/Album.cs`

```csharp
namespace Mosaic.Backend.Data.Entities;

public class Album
{
    public Guid Id { get; set; }
    public Guid OwnerId { get; set; }
    public long CurrentVersion { get; set; } = 1;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    
    // Navigation
    public User Owner { get; set; } = null!;
    public ICollection<AlbumMember> Members { get; set; } = [];
    public ICollection<Manifest> Manifests { get; set; } = [];
    public ICollection<EpochKey> EpochKeys { get; set; } = [];
}
```

### File: `Data/Entities/AlbumMember.cs`

```csharp
namespace Mosaic.Backend.Data.Entities;

public class AlbumMember
{
    public Guid AlbumId { get; set; }
    public Guid UserId { get; set; }
    public required string Role { get; set; }  // "owner", "editor", "viewer"
    public Guid? InvitedBy { get; set; }
    public DateTime JoinedAt { get; set; } = DateTime.UtcNow;
    public DateTime? RevokedAt { get; set; }
    
    // Navigation
    public Album Album { get; set; } = null!;
    public User User { get; set; } = null!;
    public User? Inviter { get; set; }
}
```

### File: `Data/Entities/EpochKey.cs`

```csharp
namespace Mosaic.Backend.Data.Entities;

public class EpochKey
{
    public Guid Id { get; set; }
    public Guid AlbumId { get; set; }
    public Guid RecipientId { get; set; }
    public int EpochId { get; set; }
    public required byte[] EncryptedKeyBundle { get; set; }
    public required byte[] OwnerSignature { get; set; }
    public required byte[] SharerPubkey { get; set; }
    public required byte[] SignPubkey { get; set; }  // Plaintext for server verification
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    
    // Navigation
    public Album Album { get; set; } = null!;
    public User Recipient { get; set; } = null!;
}
```

### File: `Data/Entities/Manifest.cs`

```csharp
namespace Mosaic.Backend.Data.Entities;

public class Manifest
{
    public Guid Id { get; set; }
    public Guid AlbumId { get; set; }
    public long VersionCreated { get; set; }
    public bool IsDeleted { get; set; }
    public required byte[] EncryptedMeta { get; set; }
    public required string Signature { get; set; }
    public required string SignerPubkey { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    
    // Navigation
    public Album Album { get; set; } = null!;
    public ICollection<ManifestShard> ManifestShards { get; set; } = [];
}
```

### File: `Data/Entities/Shard.cs`

```csharp
namespace Mosaic.Backend.Data.Entities;

public enum ShardStatus
{
    PENDING,
    ACTIVE,
    TRASHED
}

public class Shard
{
    public Guid Id { get; set; }
    public Guid? UploaderId { get; set; }
    public required string StorageKey { get; set; }
    public long SizeBytes { get; set; }
    public ShardStatus Status { get; set; } = ShardStatus.PENDING;
    public DateTime StatusUpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? PendingExpiresAt { get; set; }
    
    // Navigation
    public User? Uploader { get; set; }
    public ICollection<ManifestShard> ManifestShards { get; set; } = [];
}
```

### File: `Data/Entities/ManifestShard.cs`

```csharp
namespace Mosaic.Backend.Data.Entities;

public class ManifestShard
{
    public Guid ManifestId { get; set; }
    public Guid ShardId { get; set; }
    public int ChunkIndex { get; set; }
    
    // Navigation
    public Manifest Manifest { get; set; } = null!;
    public Shard Shard { get; set; } = null!;
}
```

### File: `Data/Entities/UserQuota.cs`

```csharp
namespace Mosaic.Backend.Data.Entities;

public class UserQuota
{
    public Guid UserId { get; set; }
    public long MaxStorageBytes { get; set; }
    public long UsedStorageBytes { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    
    // Navigation
    public User User { get; set; } = null!;
}
```

### File: `Data/MosaicDbContext.cs`

```csharp
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data.Entities;

namespace Mosaic.Backend.Data;

public class MosaicDbContext : DbContext
{
    public MosaicDbContext(DbContextOptions<MosaicDbContext> options) : base(options) { }
    
    public DbSet<User> Users => Set<User>();
    public DbSet<Album> Albums => Set<Album>();
    public DbSet<AlbumMember> AlbumMembers => Set<AlbumMember>();
    public DbSet<EpochKey> EpochKeys => Set<EpochKey>();
    public DbSet<Manifest> Manifests => Set<Manifest>();
    public DbSet<Shard> Shards => Set<Shard>();
    public DbSet<ManifestShard> ManifestShards => Set<ManifestShard>();
    public DbSet<UserQuota> UserQuotas => Set<UserQuota>();
    
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // User
        modelBuilder.Entity<User>(e =>
        {
            e.HasIndex(u => u.AuthSub).IsUnique();
        });
        
        // Album
        modelBuilder.Entity<Album>(e =>
        {
            e.HasOne(a => a.Owner)
                .WithMany(u => u.OwnedAlbums)
                .HasForeignKey(a => a.OwnerId)
                .OnDelete(DeleteBehavior.Cascade);
            
            e.HasIndex(a => a.OwnerId);
        });
        
        // AlbumMember
        modelBuilder.Entity<AlbumMember>(e =>
        {
            e.HasKey(am => new { am.AlbumId, am.UserId });
            
            e.HasIndex(am => am.UserId);
            e.HasIndex(am => am.AlbumId)
                .HasFilter("revoked_at IS NULL");
        });
        
        // EpochKey
        modelBuilder.Entity<EpochKey>(e =>
        {
            e.HasIndex(ek => new { ek.AlbumId, ek.RecipientId, ek.EpochId }).IsUnique();
            e.HasIndex(ek => new { ek.RecipientId, ek.AlbumId });
        });
        
        // Manifest
        modelBuilder.Entity<Manifest>(e =>
        {
            e.HasIndex(m => new { m.AlbumId, m.VersionCreated });
        });
        
        // Shard
        modelBuilder.Entity<Shard>(e =>
        {
            e.HasIndex(s => s.PendingExpiresAt)
                .HasFilter("status = 'PENDING'");
            
            e.Property(s => s.Status)
                .HasConversion<string>();
        });
        
        // ManifestShard
        modelBuilder.Entity<ManifestShard>(e =>
        {
            e.HasKey(ms => new { ms.ManifestId, ms.ShardId });
            e.HasIndex(ms => ms.ShardId);
            
            e.HasOne(ms => ms.Shard)
                .WithMany(s => s.ManifestShards)
                .OnDelete(DeleteBehavior.Restrict);
        });
        
        // UserQuota
        modelBuilder.Entity<UserQuota>(e =>
        {
            e.HasKey(q => q.UserId);
            e.HasOne(q => q.User)
                .WithOne(u => u.Quota)
                .HasForeignKey<UserQuota>(q => q.UserId);
        });
        
        // Use snake_case for PostgreSQL
        foreach (var entity in modelBuilder.Model.GetEntityTypes())
        {
            entity.SetTableName(ToSnakeCase(entity.GetTableName()!));
            foreach (var property in entity.GetProperties())
            {
                property.SetColumnName(ToSnakeCase(property.Name));
            }
        }
    }
    
    private static string ToSnakeCase(string name) =>
        string.Concat(name.Select((c, i) => 
            i > 0 && char.IsUpper(c) ? "_" + char.ToLower(c) : char.ToLower(c).ToString()));
}
```

---

## Task 3: Authentication Middleware

### File: `Middleware/TrustedProxyMiddleware.cs`

```csharp
using System.Net;
using System.Text.RegularExpressions;

namespace Mosaic.Backend.Middleware;

public class TrustedProxyMiddleware
{
    private readonly RequestDelegate _next;
    private readonly List<IPNetwork> _trustedNetworks;
    private readonly ILogger<TrustedProxyMiddleware> _logger;
    private static readonly Regex ValidUserPattern = new(@"^[a-zA-Z0-9_\-@.]+$", RegexOptions.Compiled);

    public TrustedProxyMiddleware(
        RequestDelegate next,
        IConfiguration config,
        ILogger<TrustedProxyMiddleware> logger)
    {
        _next = next;
        _logger = logger;
        
        var cidrs = config.GetSection("Auth:TrustedProxies").Get<string[]>() ?? [];
        _trustedNetworks = cidrs.Select(cidr => IPNetwork.Parse(cidr)).ToList();
    }

    public async Task InvokeAsync(HttpContext context)
    {
        // Health endpoint is always public
        if (context.Request.Path.StartsWithSegments("/health"))
        {
            await _next(context);
            return;
        }
        
        var remoteIp = context.Connection.RemoteIpAddress;
        if (remoteIp == null)
        {
            context.Response.StatusCode = 401;
            return;
        }
        
        // Check if request is from trusted proxy
        var isTrusted = _trustedNetworks.Any(network => network.Contains(remoteIp));
        
        if (!isTrusted)
        {
            _logger.LogWarning("Request from untrusted IP: {IP}", remoteIp);
            context.Request.Headers.Remove("Remote-User");
            context.Response.StatusCode = 401;
            return;
        }
        
        // Extract and validate Remote-User header
        var remoteUser = context.Request.Headers["Remote-User"].FirstOrDefault();
        
        if (string.IsNullOrEmpty(remoteUser))
        {
            context.Response.StatusCode = 401;
            await context.Response.WriteAsJsonAsync(new { error = "Missing Remote-User header" });
            return;
        }
        
        if (!ValidUserPattern.IsMatch(remoteUser))
        {
            context.Response.StatusCode = 400;
            await context.Response.WriteAsJsonAsync(new { error = "Invalid Remote-User format" });
            return;
        }
        
        // Store in HttpContext for controllers
        context.Items["AuthSub"] = remoteUser;
        
        await _next(context);
    }
}
```

---

## Task 4: Controllers

### File: `Controllers/HealthController.cs`

```csharp
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("health")]
public class HealthController : ControllerBase
{
    private readonly MosaicDbContext _db;

    public HealthController(MosaicDbContext db) => _db = db;

    [HttpGet]
    public async Task<IActionResult> Get()
    {
        try
        {
            await _db.Database.ExecuteSqlRawAsync("SELECT 1");
            return Ok(new { status = "healthy", timestamp = DateTime.UtcNow });
        }
        catch
        {
            return StatusCode(503, new { status = "unhealthy" });
        }
    }
}
```

### File: `Controllers/AlbumsController.cs`

```csharp
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/albums")]
public class AlbumsController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IConfiguration _config;

    public AlbumsController(MosaicDbContext db, IConfiguration config)
    {
        _db = db;
        _config = config;
    }

    private async Task<User> GetOrCreateUser()
    {
        var authSub = HttpContext.Items["AuthSub"] as string 
            ?? throw new UnauthorizedAccessException();
        
        var user = await _db.Users.FirstOrDefaultAsync(u => u.AuthSub == authSub);
        if (user == null)
        {
            user = new User
            {
                Id = Guid.NewGuid(),
                AuthSub = authSub,
                IdentityPubkey = ""  // Set on first key upload
            };
            _db.Users.Add(user);
            
            // Create quota
            _db.UserQuotas.Add(new UserQuota
            {
                UserId = user.Id,
                MaxStorageBytes = _config.GetValue<long>("Quota:DefaultMaxBytes")
            });
            
            await _db.SaveChangesAsync();
        }
        return user;
    }

    [HttpGet]
    public async Task<IActionResult> List()
    {
        var user = await GetOrCreateUser();
        
        var albums = await _db.AlbumMembers
            .Where(am => am.UserId == user.Id && am.RevokedAt == null)
            .Select(am => new
            {
                am.Album.Id,
                am.Album.OwnerId,
                am.Album.CurrentVersion,
                am.Album.CreatedAt,
                am.Role
            })
            .ToListAsync();
        
        return Ok(albums);
    }

    [HttpPost]
    public async Task<IActionResult> Create()
    {
        var user = await GetOrCreateUser();
        
        var album = new Album
        {
            Id = Guid.NewGuid(),
            OwnerId = user.Id
        };
        _db.Albums.Add(album);
        
        // Add owner as member
        _db.AlbumMembers.Add(new AlbumMember
        {
            AlbumId = album.Id,
            UserId = user.Id,
            Role = "owner"
        });
        
        await _db.SaveChangesAsync();
        
        return Created($"/api/albums/{album.Id}", new
        {
            album.Id,
            album.OwnerId,
            album.CurrentVersion,
            album.CreatedAt
        });
    }

    [HttpGet("{albumId}")]
    public async Task<IActionResult> Get(Guid albumId)
    {
        var user = await GetOrCreateUser();
        
        var membership = await _db.AlbumMembers
            .Where(am => am.AlbumId == albumId && am.UserId == user.Id && am.RevokedAt == null)
            .FirstOrDefaultAsync();
        
        if (membership == null) return Forbid();
        
        var album = await _db.Albums.FindAsync(albumId);
        if (album == null) return NotFound();
        
        return Ok(new
        {
            album.Id,
            album.OwnerId,
            album.CurrentVersion,
            album.CreatedAt,
            membership.Role
        });
    }

    [HttpGet("{albumId}/sync")]
    public async Task<IActionResult> Sync(Guid albumId, [FromQuery] long since)
    {
        var user = await GetOrCreateUser();
        
        // Verify access
        var hasAccess = await _db.AlbumMembers
            .AnyAsync(am => am.AlbumId == albumId && am.UserId == user.Id && am.RevokedAt == null);
        
        if (!hasAccess) return Forbid();
        
        var manifests = await _db.Manifests
            .Where(m => m.AlbumId == albumId && m.VersionCreated > since)
            .OrderBy(m => m.VersionCreated)
            .Take(100)
            .Select(m => new
            {
                m.Id,
                m.VersionCreated,
                m.IsDeleted,
                m.EncryptedMeta,
                m.Signature,
                m.SignerPubkey,
                ShardIds = m.ManifestShards
                    .OrderBy(ms => ms.ChunkIndex)
                    .Select(ms => ms.ShardId)
            })
            .ToListAsync();
        
        var album = await _db.Albums.FindAsync(albumId);
        
        return Ok(new
        {
            Manifests = manifests,
            AlbumVersion = album!.CurrentVersion,
            HasMore = manifests.Count == 100
        });
    }
}
```

### File: `Controllers/ManifestsController.cs`

```csharp
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/manifests")]
public class ManifestsController : ControllerBase
{
    private readonly MosaicDbContext _db;

    public ManifestsController(MosaicDbContext db) => _db = db;

    public record CreateManifestRequest(
        Guid AlbumId,
        byte[] EncryptedMeta,
        string Signature,
        string SignerPubkey,
        List<Guid> ShardIds
    );

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateManifestRequest request)
    {
        var authSub = HttpContext.Items["AuthSub"] as string!;
        var user = await _db.Users.FirstOrDefaultAsync(u => u.AuthSub == authSub);
        if (user == null) return Unauthorized();
        
        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            // 1. Lock album row
            var album = await _db.Albums
                .FromSqlRaw("SELECT * FROM albums WHERE id = {0} FOR UPDATE", request.AlbumId)
                .FirstOrDefaultAsync();
            
            if (album == null) return NotFound("Album not found");
            
            // 2. Verify membership
            var membership = await _db.AlbumMembers
                .FirstOrDefaultAsync(am => 
                    am.AlbumId == album.Id && 
                    am.UserId == user.Id && 
                    am.RevokedAt == null);
            
            if (membership == null) return Forbid();
            if (membership.Role == "viewer") return Forbid("Viewers cannot upload");
            
            // 3. Validate shards
            var shards = await _db.Shards
                .Where(s => request.ShardIds.Contains(s.Id))
                .ToListAsync();
            
            if (shards.Count != request.ShardIds.Count)
                return BadRequest("Some shards not found");
            
            if (shards.Any(s => s.UploaderId != user.Id))
                return Forbid("Shard ownership mismatch");
            
            if (shards.Any(s => s.Status != ShardStatus.PENDING))
                return BadRequest("Some shards already linked to a manifest");
            
            // 4. Create manifest
            album.CurrentVersion++;
            album.UpdatedAt = DateTime.UtcNow;
            
            var manifest = new Manifest
            {
                Id = Guid.NewGuid(),
                AlbumId = album.Id,
                VersionCreated = album.CurrentVersion,
                EncryptedMeta = request.EncryptedMeta,
                Signature = request.Signature,
                SignerPubkey = request.SignerPubkey
            };
            _db.Manifests.Add(manifest);
            
            // 5. Link shards and mark ACTIVE
            for (int i = 0; i < request.ShardIds.Count; i++)
            {
                var shard = shards.First(s => s.Id == request.ShardIds[i]);
                shard.Status = ShardStatus.ACTIVE;
                shard.StatusUpdatedAt = DateTime.UtcNow;
                shard.PendingExpiresAt = null;
                
                _db.ManifestShards.Add(new ManifestShard
                {
                    ManifestId = manifest.Id,
                    ShardId = shard.Id,
                    ChunkIndex = i
                });
            }
            
            await _db.SaveChangesAsync();
            await tx.CommitAsync();
            
            return Created($"/api/manifests/{manifest.Id}", new
            {
                manifest.Id,
                Version = album.CurrentVersion
            });
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
    }
}
```

### File: `Controllers/ShardsController.cs`

```csharp
using Microsoft.AspNetCore.Mvc;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/shards")]
public class ShardsController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IStorageService _storage;

    public ShardsController(MosaicDbContext db, IStorageService storage)
    {
        _db = db;
        _storage = storage;
    }

    [HttpGet("{shardId}")]
    public async Task<IActionResult> Download(Guid shardId)
    {
        var shard = await _db.Shards.FindAsync(shardId);
        if (shard == null) return NotFound();
        if (shard.Status != ShardStatus.ACTIVE) return NotFound();
        
        // TODO: Verify user has access to album containing this shard
        // For now, rely on shard IDs being unguessable (UUIDv7)
        
        var stream = await _storage.OpenReadAsync(shard.StorageKey);
        return File(stream, "application/octet-stream");
    }
}
```

---

## Task 5: Tus Upload Handlers

### File: `Services/TusEventHandlers.cs`

```csharp
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using tusdotnet.Interfaces;
using tusdotnet.Models;

namespace Mosaic.Backend.Services;

public static class TusEventHandlers
{
    public static async Task OnBeforeCreate(
        BeforeCreateContext context, 
        IServiceProvider services)
    {
        var httpContext = context.HttpContext;
        var authSub = httpContext.Items["AuthSub"] as string;
        
        if (string.IsNullOrEmpty(authSub))
        {
            context.FailRequest("Unauthorized");
            return;
        }
        
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        
        var user = await db.Users.FirstOrDefaultAsync(u => u.AuthSub == authSub);
        if (user == null)
        {
            context.FailRequest("User not found");
            return;
        }
        
        // Check quota
        var quota = await db.UserQuotas.FindAsync(user.Id);
        if (quota == null || quota.UsedStorageBytes + context.UploadLength > quota.MaxStorageBytes)
        {
            context.FailRequest("Storage quota exceeded");
            return;
        }
    }
    
    public static async Task OnFileComplete(
        FileCompleteContext context,
        IServiceProvider services)
    {
        var httpContext = context.HttpContext;
        var authSub = httpContext.Items["AuthSub"] as string!;
        var fileId = context.FileId;
        var fileSize = context.Store is ITusReadableStore readable
            ? (await readable.GetFileAsync(fileId, context.CancellationToken))?.Length ?? 0
            : 0;
        
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        
        await using var tx = await db.Database.BeginTransactionAsync();
        
        var user = await db.Users.FirstOrDefaultAsync(u => u.AuthSub == authSub);
        
        // Create PENDING shard
        db.Shards.Add(new Shard
        {
            Id = Guid.Parse(fileId),
            UploaderId = user!.Id,
            StorageKey = $"blobs/{fileId}",
            SizeBytes = fileSize,
            Status = ShardStatus.PENDING,
            PendingExpiresAt = DateTime.UtcNow.AddHours(24)
        });
        
        // Update quota
        await db.Database.ExecuteSqlRawAsync(
            "UPDATE user_quotas SET used_storage_bytes = used_storage_bytes + {0}, updated_at = NOW() WHERE user_id = {1}",
            fileSize, user.Id);
        
        await db.SaveChangesAsync();
        await tx.CommitAsync();
    }
}
```

---

## Task 6: Garbage Collection Service

### File: `Services/GarbageCollectionService.cs`

```csharp
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;

namespace Mosaic.Backend.Services;

public class GarbageCollectionService : BackgroundService
{
    private readonly IServiceProvider _services;
    private readonly ILogger<GarbageCollectionService> _logger;

    public GarbageCollectionService(
        IServiceProvider services,
        ILogger<GarbageCollectionService> logger)
    {
        _services = services;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await CleanExpiredPendingShards();
                await CleanTrashedShards();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "GC cycle failed");
            }
            
            await Task.Delay(TimeSpan.FromHours(1), stoppingToken);
        }
    }

    private async Task CleanExpiredPendingShards()
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        
        var count = await db.Database.ExecuteSqlRawAsync(@"
            UPDATE shards 
            SET status = 'TRASHED', status_updated_at = NOW() 
            WHERE status = 'PENDING' AND pending_expires_at < NOW()");
        
        if (count > 0)
        {
            _logger.LogInformation("Marked {Count} expired PENDING shards as TRASHED", count);
        }
    }

    private async Task CleanTrashedShards()
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var storage = scope.ServiceProvider.GetRequiredService<IStorageService>();
        
        var toDelete = await db.Shards
            .Where(s => s.Status == ShardStatus.TRASHED
                     && s.StatusUpdatedAt < DateTime.UtcNow.AddDays(-7))
            .Take(100)  // Batch to avoid long transactions
            .ToListAsync();
        
        foreach (var shard in toDelete)
        {
            try
            {
                await storage.DeleteAsync(shard.StorageKey);
                
                // Reclaim quota
                if (shard.UploaderId.HasValue)
                {
                    await db.Database.ExecuteSqlRawAsync(
                        "UPDATE user_quotas SET used_storage_bytes = used_storage_bytes - {0}, updated_at = NOW() WHERE user_id = {1}",
                        shard.SizeBytes, shard.UploaderId.Value);
                }
                
                db.Shards.Remove(shard);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to delete shard {ShardId}", shard.Id);
            }
        }
        
        await db.SaveChangesAsync();
        
        if (toDelete.Count > 0)
        {
            _logger.LogInformation("Deleted {Count} TRASHED shards", toDelete.Count);
        }
    }
}
```

---

## Task 7: Storage Service

### File: `Services/IStorageService.cs`

```csharp
namespace Mosaic.Backend.Services;

public interface IStorageService
{
    Task<Stream> OpenReadAsync(string key);
    Task DeleteAsync(string key);
}
```

### File: `Services/LocalStorageService.cs`

```csharp
namespace Mosaic.Backend.Services;

public class LocalStorageService : IStorageService
{
    private readonly string _basePath;

    public LocalStorageService(IConfiguration config)
    {
        _basePath = config["Storage:Path"] 
            ?? throw new InvalidOperationException("Storage:Path not configured");
        
        Directory.CreateDirectory(_basePath);
    }

    public Task<Stream> OpenReadAsync(string key)
    {
        var path = Path.Combine(_basePath, key);
        return Task.FromResult<Stream>(File.OpenRead(path));
    }

    public Task DeleteAsync(string key)
    {
        var path = Path.Combine(_basePath, key);
        if (File.Exists(path))
        {
            File.Delete(path);
        }
        return Task.CompletedTask;
    }
}
```

---

## Exit Criteria

- [ ] All entities and DbContext implemented
- [ ] Migrations generated and tested
- [ ] All controllers implemented per OpenAPI spec
- [ ] Tus upload working with quota enforcement
- [ ] GC service cleaning expired shards
- [ ] Authentication middleware validating trusted proxies
- [ ] Unit tests for critical paths (manifest creation, sync)
- [ ] Integration tests with PostgreSQL testcontainer

---

## Handoff

Once complete:
1. API ready for integration with frontend
2. OpenAPI spec validated against implementation
3. Database schema finalized and migrated

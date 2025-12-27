namespace Mosaic.Backend.Tests.Helpers;

/// <summary>
/// Test helper for creating in-memory database context
/// </summary>
public static class TestDbContextFactory
{
    public static MosaicDbContext Create(string? name = null)
    {
        var options = new DbContextOptionsBuilder<MosaicDbContext>()
            .UseInMemoryDatabase(databaseName: name ?? Guid.NewGuid().ToString())
            .Options;

        return new MosaicDbContext(options);
    }

    public static MosaicDbContext CreateWithData(Action<MosaicDbContext> seedAction, string? name = null)
    {
        var db = Create(name);
        seedAction(db);
        db.SaveChanges();
        return db;
    }
}

/// <summary>
/// Test helper for creating mock IConfiguration
/// </summary>
public static class TestConfigurationFactory
{
    public static IConfiguration Create(Dictionary<string, string?>? settings = null)
    {
        var defaultSettings = new Dictionary<string, string?>
        {
            ["Quota:DefaultMaxBytes"] = "10737418240", // 10GB
            ["Storage:Path"] = "/tmp/mosaic-test",
            ["Auth:TrustedProxies:0"] = "127.0.0.0/8",
            ["Auth:TrustedProxies:1"] = "::1/128"
        };

        if (settings != null)
        {
            foreach (var kvp in settings)
            {
                defaultSettings[kvp.Key] = kvp.Value;
            }
        }

        return new ConfigurationBuilder()
            .AddInMemoryCollection(defaultSettings)
            .Build();
    }
}

/// <summary>
/// Test helper for creating controllers with mock HttpContext
/// </summary>
public static class TestControllerFactory
{
    public static T CreateController<T>(
        MosaicDbContext db, 
        IConfiguration? config = null,
        string? authSub = null) 
        where T : ControllerBase
    {
        config ??= TestConfigurationFactory.Create();
        
        var httpContext = new DefaultHttpContext();
        if (authSub != null)
        {
            httpContext.Items["AuthSub"] = authSub;
        }

        T controller;
        
        if (typeof(T) == typeof(AlbumsController))
        {
            controller = (T)(ControllerBase)new AlbumsController(db, config);
        }
        else if (typeof(T) == typeof(UsersController))
        {
            controller = (T)(ControllerBase)new UsersController(db, config);
        }
        else if (typeof(T) == typeof(MembersController))
        {
            controller = (T)(ControllerBase)new MembersController(db, config);
        }
        else if (typeof(T) == typeof(EpochKeysController))
        {
            controller = (T)(ControllerBase)new EpochKeysController(db, config);
        }
        else if (typeof(T) == typeof(ManifestsController))
        {
            controller = (T)(ControllerBase)new ManifestsController(db, config);
        }
        else if (typeof(T) == typeof(HealthController))
        {
            controller = (T)(ControllerBase)new HealthController(db);
        }
        else
        {
            throw new NotSupportedException($"Controller type {typeof(T).Name} not supported");
        }
        
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = httpContext
        };
        
        return controller;
    }

    public static ShardsController CreateShardsController(
        MosaicDbContext db,
        IStorageService? storage = null,
        string? authSub = null)
    {
        storage ??= Mock.Of<IStorageService>();
        
        var httpContext = new DefaultHttpContext();
        if (authSub != null)
        {
            httpContext.Items["AuthSub"] = authSub;
        }

        var controller = new ShardsController(db, storage)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = httpContext
            }
        };
        
        return controller;
    }
}

/// <summary>
/// Test data generator
/// </summary>
public static class TestDataFactory
{
    public static User CreateUser(string authSub = "test-user", string? identityPubkey = null)
    {
        return new User
        {
            Id = Guid.NewGuid(),
            AuthSub = authSub,
            IdentityPubkey = identityPubkey ?? Convert.ToBase64String(new byte[32])
        };
    }

    public static Album CreateAlbum(User owner)
    {
        return new Album
        {
            Id = Guid.NewGuid(),
            OwnerId = owner.Id,
            CurrentEpochId = 1,
            CurrentVersion = 1
        };
    }

    public static AlbumMember CreateMember(Album album, User user, string role = "viewer", Guid? invitedBy = null)
    {
        return new AlbumMember
        {
            AlbumId = album.Id,
            UserId = user.Id,
            Role = role,
            InvitedBy = invitedBy
        };
    }

    public static EpochKey CreateEpochKey(Album album, User recipient, int epochId = 1)
    {
        return new EpochKey
        {
            Id = Guid.NewGuid(),
            AlbumId = album.Id,
            RecipientId = recipient.Id,
            EpochId = epochId,
            EncryptedKeyBundle = new byte[64],
            OwnerSignature = new byte[64],
            SharerPubkey = new byte[32],
            SignPubkey = new byte[32]
        };
    }

    public static Shard CreateShard(User? uploader = null, ShardStatus status = ShardStatus.PENDING)
    {
        return new Shard
        {
            Id = Guid.NewGuid(),
            UploaderId = uploader?.Id,
            StorageKey = $"shards/{Guid.NewGuid()}",
            SizeBytes = 1024,
            Status = status,
            PendingExpiresAt = status == ShardStatus.PENDING ? DateTime.UtcNow.AddHours(24) : null
        };
    }

    public static Manifest CreateManifest(Album album, List<Shard>? shards = null)
    {
        return new Manifest
        {
            Id = Guid.NewGuid(),
            AlbumId = album.Id,
            VersionCreated = album.CurrentVersion,
            EncryptedMeta = new byte[128],
            Signature = Convert.ToBase64String(new byte[64]),
            SignerPubkey = Convert.ToBase64String(new byte[32])
        };
    }

    public static UserQuota CreateQuota(User user, long maxBytes = 10737418240, long usedBytes = 0)
    {
        return new UserQuota
        {
            UserId = user.Id,
            MaxStorageBytes = maxBytes,
            UsedStorageBytes = usedBytes
        };
    }

    public static byte[] RandomBytes(int length) => 
        Enumerable.Range(0, length).Select(_ => (byte)Random.Shared.Next(256)).ToArray();
}

using Microsoft.AspNetCore.Mvc;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Tests.Helpers;
using Xunit;
using Mosaic.Backend.Tests.TestHelpers;


namespace Mosaic.Backend.Tests.Controllers;

public class AlbumsControllerTests
{
    private const string TestAuthSub = "test-user-123";

    [Fact]
    public async Task List_ReturnsEmptyList_WhenNoAlbums()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.List();

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var albums = Assert.IsAssignableFrom<IEnumerable<object>>(okResult.Value);
        Assert.Empty(albums);
    }

    [Fact]
    public async Task List_ReturnsUserAlbums_WhenUserHasMembership()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var user = await builder.CreateUserAsync(TestAuthSub);
        var album1 = await builder.CreateAlbumAsync(user);
        var album2 = await builder.CreateAlbumAsync(user);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.List();

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var albums = Assert.IsAssignableFrom<IEnumerable<object>>(okResult.Value);
        Assert.Equal(2, albums.Count());
    }

    [Fact]
    public async Task List_ExcludesRevokedMemberships()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync("owner-user");
        var member = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        // Add member with revoked membership
        var membership = await builder.AddMemberAsync(album, member, "viewer", owner);
        membership.RevokedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.List();

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var albums = Assert.IsAssignableFrom<IEnumerable<object>>(okResult.Value);
        Assert.Empty(albums);
    }

    [Fact]
    public async Task Create_CreatesAlbumWithInitialEpochKey()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new CreateAlbumRequest
        {
            InitialEpochKey = new InitialEpochKeyRequest
            {
                EncryptedKeyBundle = new byte[32],
                OwnerSignature = new byte[64],
                SharerPubkey = new byte[32],
                SignPubkey = new byte[32]
            }
        };

        // Act
        var result = await controller.Create(request);

        // Assert
        var createdResult = Assert.IsType<CreatedResult>(result);
        Assert.NotNull(createdResult.Value);

        // Verify album was created
        Assert.Single(db.Albums);
        Assert.Single(db.AlbumMembers);
        Assert.Single(db.EpochKeys);
    }

    [Fact]
    public async Task Create_ReturnsBadRequest_WhenInitialEpochKeyMissing()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new CreateAlbumRequest
        {
            InitialEpochKey = null!
        };

        // Act
        var result = await controller.Create(request);

        // Assert
        var badRequestResult = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("initialEpochKey", ProblemDetailsAssertions.GetDetail(badRequestResult));
    }

    [Fact]
    public async Task Create_ReturnsBadRequest_WhenEncryptedKeyBundleEmpty()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new CreateAlbumRequest
        {
            InitialEpochKey = new InitialEpochKeyRequest
            {
                EncryptedKeyBundle = Array.Empty<byte>(),
                OwnerSignature = new byte[64],
                SharerPubkey = new byte[32],
                SignPubkey = new byte[32]
            }
        };

        // Act
        var result = await controller.Create(request);

        // Assert
        var badRequestResult = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("encryptedKeyBundle", ProblemDetailsAssertions.GetDetail(badRequestResult));
    }

    [Fact]
    public async Task Get_ReturnsAlbum_WhenUserIsMember()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.Get(album.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);
    }

    [Fact]
    public async Task Get_ReturnsForbid_WhenUserIsNotMember()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync("owner-user");
        var album = await builder.CreateAlbumAsync(owner);
        await builder.CreateUserAsync(TestAuthSub); // Create test user without membership

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.Get(album.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Get_ReturnsForbid_WhenMembershipRevoked()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync("owner-user");
        var member = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var membership = await builder.AddMemberAsync(album, member, "viewer", owner);
        membership.RevokedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.Get(album.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Sync_ReturnsManifestsSinceVersion()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user, currentVersion: 5);
        var shard = await builder.CreateShardAsync(user, Data.Entities.ShardStatus.ACTIVE);
        await builder.CreateManifestAsync(album, [shard]);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.Sync(album.Id, 0);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);
    }

    [Fact]
    public async Task Sync_ReturnsForbid_WhenUserNotMember()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync("owner-user");
        var album = await builder.CreateAlbumAsync(owner);
        await builder.CreateUserAsync(TestAuthSub);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.Sync(album.Id, 0);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Sync_Returns410ForExpiredAlbum()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);
        album.ExpiresAt = DateTimeOffset.UtcNow.AddHours(-1);
        await db.SaveChangesAsync();

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.Sync(album.Id, 0);

        // Assert
        var statusResult = Assert.IsType<StatusCodeResult>(result);
        Assert.Equal(410, statusResult.StatusCode);
    }

    [Fact]
    public async Task Delete_DeletesAlbum_WhenOwner()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.Delete(album.Id);

        // Assert
        Assert.IsType<NoContentResult>(result);
        Assert.Empty(db.Albums);
    }

    [Fact]
    public async Task Delete_ReturnsForbid_WhenNotOwner()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync("owner-user");
        var member = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, member, "editor", owner);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.Delete(album.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Delete_ReturnsNotFound_WhenAlbumDoesNotExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        await new TestDataBuilder(db).CreateUserAsync(TestAuthSub);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.Delete(Guid.NewGuid());

        // Assert
        Assert.IsType<NotFoundResult>(result);
    }

    [Fact]
    public async Task Create_StoresEncryptedName_WhenProvided()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        const string encryptedName = "base64-encrypted-album-name";
        var request = new CreateAlbumRequest
        {
            InitialEpochKey = new InitialEpochKeyRequest
            {
                EncryptedKeyBundle = new byte[32],
                OwnerSignature = new byte[64],
                SharerPubkey = new byte[32],
                SignPubkey = new byte[32]
            },
            EncryptedName = encryptedName
        };

        // Act
        var result = await controller.Create(request);

        // Assert
        var createdResult = Assert.IsType<CreatedResult>(result);
        Assert.NotNull(createdResult.Value);

        // Verify encrypted name was stored
        var album = db.Albums.Single();
        Assert.Equal(encryptedName, album.EncryptedName);
    }

    [Fact]
    public async Task Create_ReturnsEncryptedName_InResponse()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        const string encryptedName = "base64-encrypted-album-name";
        var request = new CreateAlbumRequest
        {
            InitialEpochKey = new InitialEpochKeyRequest
            {
                EncryptedKeyBundle = new byte[32],
                OwnerSignature = new byte[64],
                SharerPubkey = new byte[32],
                SignPubkey = new byte[32]
            },
            EncryptedName = encryptedName
        };

        // Act
        var result = await controller.Create(request);

        // Assert
        var createdResult = Assert.IsType<CreatedResult>(result);
        var responseJson = System.Text.Json.JsonSerializer.Serialize(createdResult.Value);
        Assert.Contains("EncryptedName", responseJson);
        Assert.Contains(encryptedName, responseJson);
    }

    [Fact]
    public async Task List_ReturnsEncryptedName_WhenAvailable()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var user = await builder.CreateUserAsync(TestAuthSub);
        const string encryptedName = "encrypted-album-name-1";
        await builder.CreateAlbumAsync(user, encryptedName: encryptedName);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.List();

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var responseJson = System.Text.Json.JsonSerializer.Serialize(okResult.Value);
        Assert.Contains("EncryptedName", responseJson);
        Assert.Contains(encryptedName, responseJson);
    }

    [Fact]
    public async Task Get_ReturnsEncryptedName_WhenAvailable()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var user = await builder.CreateUserAsync(TestAuthSub);
        const string encryptedName = "encrypted-album-name-test";
        var album = await builder.CreateAlbumAsync(user, encryptedName: encryptedName);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.Get(album.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var responseJson = System.Text.Json.JsonSerializer.Serialize(okResult.Value);
        Assert.Contains("EncryptedName", responseJson);
        Assert.Contains(encryptedName, responseJson);
    }

    [Fact]
    public async Task Create_AllowsNullEncryptedName()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new CreateAlbumRequest
        {
            InitialEpochKey = new InitialEpochKeyRequest
            {
                EncryptedKeyBundle = new byte[32],
                OwnerSignature = new byte[64],
                SharerPubkey = new byte[32],
                SignPubkey = new byte[32]
            }
            // EncryptedName not provided (null)
        };

        // Act
        var result = await controller.Create(request);

        // Assert
        var createdResult = Assert.IsType<CreatedResult>(result);
        Assert.NotNull(createdResult.Value);

        // Verify album was created with null encrypted name
        var album = db.Albums.Single();
        Assert.Null(album.EncryptedName);
    }

    [Fact]
    public async Task Create_SetsExpirationFields_WhenProvided()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var futureDate = DateTimeOffset.UtcNow.AddDays(30);
        var request = new CreateAlbumRequest
        {
            InitialEpochKey = new InitialEpochKeyRequest
            {
                EncryptedKeyBundle = new byte[32],
                OwnerSignature = new byte[64],
                SharerPubkey = new byte[32],
                SignPubkey = new byte[32]
            },
            ExpiresAt = futureDate,
            ExpirationWarningDays = 14
        };

        // Act
        var result = await controller.Create(request);

        // Assert
        var createdResult = Assert.IsType<CreatedResult>(result);
        Assert.NotNull(createdResult.Value);

        var album = db.Albums.Single();
        Assert.Equal(futureDate, album.ExpiresAt);
        Assert.Equal(14, album.ExpirationWarningDays);
    }

    [Fact]
    public async Task Create_UsesDefaultWarningDays_WhenNotProvided()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var futureDate = DateTimeOffset.UtcNow.AddDays(30);
        var request = new CreateAlbumRequest
        {
            InitialEpochKey = new InitialEpochKeyRequest
            {
                EncryptedKeyBundle = new byte[32],
                OwnerSignature = new byte[64],
                SharerPubkey = new byte[32],
                SignPubkey = new byte[32]
            },
            ExpiresAt = futureDate
            // ExpirationWarningDays not provided
        };

        // Act
        var result = await controller.Create(request);

        // Assert
        var createdResult = Assert.IsType<CreatedResult>(result);

        var album = db.Albums.Single();
        Assert.Equal(futureDate, album.ExpiresAt);
        Assert.Equal(7, album.ExpirationWarningDays); // Default value
    }

    [Fact]
    public async Task Create_ReturnsBadRequest_WhenExpiresAtInPast()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new CreateAlbumRequest
        {
            InitialEpochKey = new InitialEpochKeyRequest
            {
                EncryptedKeyBundle = new byte[32],
                OwnerSignature = new byte[64],
                SharerPubkey = new byte[32],
                SignPubkey = new byte[32]
            },
            ExpiresAt = DateTimeOffset.UtcNow.AddDays(-1) // Past date
        };

        // Act
        var result = await controller.Create(request);

        // Assert
        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("future", ProblemDetailsAssertions.GetDetail(badRequest) ?? "");
    }

    [Fact]
    public async Task Create_ReturnsBadRequest_WhenWarningDaysNegative()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new CreateAlbumRequest
        {
            InitialEpochKey = new InitialEpochKeyRequest
            {
                EncryptedKeyBundle = new byte[32],
                OwnerSignature = new byte[64],
                SharerPubkey = new byte[32],
                SignPubkey = new byte[32]
            },
            ExpirationWarningDays = -5
        };

        // Act
        var result = await controller.Create(request);

        // Assert
        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("non-negative", ProblemDetailsAssertions.GetDetail(badRequest) ?? "");
    }

    [Fact]
    public async Task UpdateExpiration_UpdatesAlbumExpiration()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var futureDate = DateTimeOffset.UtcNow.AddDays(60);
        var request = new UpdateExpirationRequest(futureDate, 21);

        // Act
        var result = await controller.UpdateExpiration(album.Id, request);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);

        // Verify album was updated
        await db.Entry(album).ReloadAsync();
        Assert.Equal(futureDate, album.ExpiresAt);
        Assert.Equal(21, album.ExpirationWarningDays);
    }

    [Fact]
    public async Task UpdateExpiration_RemovesExpiration_WhenExpiresAtNull()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);
        album.ExpiresAt = DateTimeOffset.UtcNow.AddDays(30);
        await db.SaveChangesAsync();

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new UpdateExpirationRequest(null, null);

        // Act
        var result = await controller.UpdateExpiration(album.Id, request);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);

        await db.Entry(album).ReloadAsync();
        Assert.Null(album.ExpiresAt);
    }

    [Fact]
    public async Task UpdateExpiration_ReturnsNotFound_WhenAlbumDoesNotExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new UpdateExpirationRequest(DateTimeOffset.UtcNow.AddDays(30), null);

        // Act
        var result = await controller.UpdateExpiration(Guid.NewGuid(), request);

        // Assert
        Assert.IsType<NotFoundResult>(result);
    }

    [Fact]
    public async Task UpdateExpiration_ReturnsForbid_WhenNotOwner()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync("owner-123");
        var album = await builder.CreateAlbumAsync(owner);
        var member = await builder.CreateUserAsync(TestAuthSub);
        await builder.AddMemberAsync(album, member, "viewer", owner);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new UpdateExpirationRequest(DateTimeOffset.UtcNow.AddDays(30), null);

        // Act
        var result = await controller.UpdateExpiration(album.Id, request);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task UpdateExpiration_ReturnsBadRequest_WhenExpiresAtInPast()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new UpdateExpirationRequest(DateTimeOffset.UtcNow.AddDays(-1), null);

        // Act
        var result = await controller.UpdateExpiration(album.Id, request);

        // Assert
        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("future", ProblemDetailsAssertions.GetDetail(badRequest) ?? "");
    }

    [Fact]
    public async Task UpdateExpiration_ReturnsBadRequest_WhenWarningDaysNegative()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new UpdateExpirationRequest(null, -5);

        // Act
        var result = await controller.UpdateExpiration(album.Id, request);

        // Assert
        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("non-negative", ProblemDetailsAssertions.GetDetail(badRequest) ?? "");
    }

    [Fact]
    public async Task List_IncludesExpirationFields()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);
        album.ExpiresAt = DateTimeOffset.UtcNow.AddDays(30);
        album.ExpirationWarningDays = 14;
        await db.SaveChangesAsync();

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.List();

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var albums = Assert.IsAssignableFrom<IEnumerable<object>>(okResult.Value);
        var albumObj = albums.First();
        var props = albumObj.GetType().GetProperties();

        Assert.Contains(props, p => p.Name == "ExpiresAt");
        Assert.Contains(props, p => p.Name == "ExpirationWarningDays");
    }

    [Fact]
    public async Task Get_IncludesExpirationFields()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);
        album.ExpiresAt = DateTimeOffset.UtcNow.AddDays(30);
        album.ExpirationWarningDays = 14;
        await db.SaveChangesAsync();

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.Get(album.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var albumObj = okResult.Value!;
        var props = albumObj.GetType().GetProperties();

        Assert.Contains(props, p => p.Name == "ExpiresAt");
        Assert.Contains(props, p => p.Name == "ExpirationWarningDays");
    }

    // =========================================================================
    // Rename Tests
    // =========================================================================

    [Fact]
    public async Task Rename_UpdatesEncryptedName_WhenOwner()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user, encryptedName: "old-encrypted-name");

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new RenameAlbumRequest("new-encrypted-name");

        // Act
        var result = await controller.Rename(album.Id, request);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);

        // Verify album was updated
        var updatedAlbum = db.Albums.First();
        Assert.Equal("new-encrypted-name", updatedAlbum.EncryptedName);
    }

    [Fact]
    public async Task Rename_UpdatesEncryptedName_WhenEditor()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync("owner-user");
        var editor = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(owner, encryptedName: "old-encrypted-name");
        await builder.AddMemberAsync(album, editor, "editor", owner);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new RenameAlbumRequest("new-encrypted-name");

        // Act
        var result = await controller.Rename(album.Id, request);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);

        // Verify album was updated
        var updatedAlbum = db.Albums.First();
        Assert.Equal("new-encrypted-name", updatedAlbum.EncryptedName);
    }

    [Fact]
    public async Task Rename_ReturnsForbid_WhenViewer()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync("owner-user");
        var viewer = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, viewer, "viewer", owner);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new RenameAlbumRequest("new-encrypted-name");

        // Act
        var result = await controller.Rename(album.Id, request);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Rename_ReturnsForbid_WhenNotMember()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync("owner-user");
        var album = await builder.CreateAlbumAsync(owner);
        await builder.CreateUserAsync(TestAuthSub); // Not a member

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new RenameAlbumRequest("new-encrypted-name");

        // Act
        var result = await controller.Rename(album.Id, request);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Rename_ReturnsNotFound_WhenAlbumDoesNotExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        await new TestDataBuilder(db).CreateUserAsync(TestAuthSub);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new RenameAlbumRequest("new-encrypted-name");

        // Act
        var result = await controller.Rename(Guid.NewGuid(), request);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Rename_ReturnsBadRequest_WhenEncryptedNameEmpty()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new RenameAlbumRequest("");

        // Act
        var result = await controller.Rename(album.Id, request);

        // Assert
        var badRequestResult = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("encryptedName", ProblemDetailsAssertions.GetDetail(badRequestResult)!);
    }

    [Fact]
    public async Task UpdateExpiration_UpdatesOnlyExpiresAt_WhenWarningDaysNull()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);

        // Album starts with default ExpirationWarningDays = 7
        Assert.Equal(7, album.ExpirationWarningDays);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var futureDate = DateTimeOffset.UtcNow.AddDays(90);
        var request = new UpdateExpirationRequest(futureDate, null);

        // Act
        var result = await controller.UpdateExpiration(album.Id, request);

        // Assert
        Assert.IsType<OkObjectResult>(result);

        await db.Entry(album).ReloadAsync();
        Assert.Equal(futureDate, album.ExpiresAt);
        Assert.Equal(7, album.ExpirationWarningDays); // unchanged from default
    }

    [Fact]
    public async Task UpdateExpiration_AcceptsZeroWarningDays()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var futureDate = DateTimeOffset.UtcNow.AddDays(30);
        var request = new UpdateExpirationRequest(futureDate, 0);

        // Act
        var result = await controller.UpdateExpiration(album.Id, request);

        // Assert
        Assert.IsType<OkObjectResult>(result);

        await db.Entry(album).ReloadAsync();
        Assert.Equal(futureDate, album.ExpiresAt);
        Assert.Equal(0, album.ExpirationWarningDays);
    }
}

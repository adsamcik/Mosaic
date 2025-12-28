using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Tests.Helpers;
using Xunit;

namespace Mosaic.Backend.Tests;

/// <summary>
/// Security-focused tests verifying critical access control and data isolation.
/// These tests verify the application's security invariants:
/// - Users can only access their own resources or resources shared with them
/// - Resource isolation between users is enforced
/// - Authorization is checked at all API endpoints
/// - Revoked access is properly enforced
/// - Role-based permissions are respected
/// </summary>
public class SecurityTests
{
    private const string UserA = "user-a";
    private const string UserB = "user-b";
    private const string UserC = "user-c";

    #region Album Access Control

    [Fact]
    public async Task Security_Albums_UserCannotAccessUnsharedAlbum()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(UserA);
        await builder.CreateUserAsync(UserB);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserB)
            }
        };

        // Act
        var result = await controller.Get(album.Id);

        // Assert - UserB cannot access UserA's unshared album
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Security_Albums_NonexistentAlbumReturnsUnauthorizedToPreventEnumeration()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        await new TestDataBuilder(db).CreateUserAsync(UserA);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserA)
            }
        };

        // Act
        var result = await controller.Get(Guid.NewGuid());

        // Assert - Returns Forbid for non-existent albums to prevent enumeration attacks.
        // An attacker cannot distinguish between "doesn't exist" and "not authorized".
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Security_Albums_RevokedMemberCannotAccessAlbum()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(UserA);
        var member = await builder.CreateUserAsync(UserB);
        var album = await builder.CreateAlbumAsync(owner);
        var membership = await builder.AddMemberAsync(album, member, "viewer", owner);
        
        // Revoke membership
        membership.RevokedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserB)
            }
        };

        // Act
        var result = await controller.Get(album.Id);

        // Assert - Revoked member cannot access
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Security_Albums_SharedMemberCanAccessAlbum()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(UserA);
        var member = await builder.CreateUserAsync(UserB);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, member, "viewer", owner);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserB)
            }
        };

        // Act
        var result = await controller.Get(album.Id);

        // Assert - Shared member can access
        Assert.IsType<OkObjectResult>(result);
    }

    [Fact]
    public async Task Security_Albums_ListExcludesUnsharedAlbums()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var userA = await builder.CreateUserAsync(UserA);
        var userB = await builder.CreateUserAsync(UserB);
        
        // UserA creates 3 albums
        await builder.CreateAlbumAsync(userA);
        await builder.CreateAlbumAsync(userA);
        await builder.CreateAlbumAsync(userA);
        
        // UserB creates 1 album
        await builder.CreateAlbumAsync(userB);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserB)
            }
        };

        // Act
        var result = await controller.List();

        // Assert - UserB should only see their own album
        var okResult = Assert.IsType<OkObjectResult>(result);
        var albums = Assert.IsAssignableFrom<IEnumerable<object>>(okResult.Value);
        Assert.Single(albums);
    }

    #endregion

    #region Member Management Authorization

    [Fact]
    public async Task Security_Members_NonOwnerCannotInviteMembers()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(UserA);
        var member = await builder.CreateUserAsync(UserB);
        var invitee = await builder.CreateUserAsync(UserC);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, member, "viewer", owner);

        var controller = new MembersController(db, config, NullLoggerFactory.CreateNullLogger<MembersController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserB) // Non-owner
            }
        };

        var request = new MembersController.InviteRequest(
            RecipientId: invitee.Id,
            Role: "viewer",
            EpochKeys: [
                new MembersController.EpochKeyCreate(
                    EpochId: 1,
                    EncryptedKeyBundle: Convert.ToBase64String(new byte[32]),
                    OwnerSignature: Convert.ToBase64String(new byte[64]),
                    SharerPubkey: Convert.ToBase64String(new byte[32]),
                    SignPubkey: Convert.ToBase64String(new byte[32])
                )
            ]
        );

        // Act
        var result = await controller.Invite(album.Id, request);

        // Assert - Only owner can invite
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Security_Members_NonOwnerCannotRemoveMembers()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(UserA);
        var memberB = await builder.CreateUserAsync(UserB);
        var memberC = await builder.CreateUserAsync(UserC);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, memberB, "viewer", owner);
        await builder.AddMemberAsync(album, memberC, "viewer", owner);

        var controller = new MembersController(db, config, NullLoggerFactory.CreateNullLogger<MembersController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserB) // Non-owner
            }
        };

        // Act - UserB tries to remove UserC
        var result = await controller.Remove(album.Id, memberC.Id);

        // Assert - Only owner can remove members
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Security_Members_OwnerCannotBeRemoved()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(UserA);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new MembersController(db, config, NullLoggerFactory.CreateNullLogger<MembersController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserA)
            }
        };

        // Act - Owner tries to remove themselves
        var result = await controller.Remove(album.Id, owner.Id);

        // Assert - Owner cannot be removed
        var badRequest = Assert.IsType<BadRequestObjectResult>(result);
        Assert.Contains("owner", badRequest.Value?.ToString()?.ToLower() ?? "");
    }

    [Fact]
    public async Task Security_Members_NonMemberCannotListMembers()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(UserA);
        await builder.CreateUserAsync(UserB);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new MembersController(db, config, NullLoggerFactory.CreateNullLogger<MembersController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserB)
            }
        };

        // Act
        var result = await controller.List(album.Id);

        // Assert - Non-member cannot see member list
        Assert.IsType<ForbidResult>(result);
    }

    #endregion

    #region Manifest Access Control

    // Note: Manifest Create tests require PostgreSQL due to row locking (FOR UPDATE).
    // These tests are covered in integration tests with a real PostgreSQL database.
    // The authorization logic is tested indirectly through Get endpoint tests.
    
    [Fact(Skip = "Requires PostgreSQL - uses FOR UPDATE row locking")]
    public async Task Security_Manifests_NonMemberCannotCreateManifest()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(UserA);
        await builder.CreateUserAsync(UserB);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new ManifestsController(db, config, new MockQuotaSettingsService(), NullLoggerFactory.CreateNullLogger<ManifestsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserB)
            }
        };

        var request = new ManifestsController.CreateManifestRequest(
            AlbumId: album.Id,
            EncryptedMeta: new byte[100],
            Signature: Convert.ToBase64String(new byte[64]),
            SignerPubkey: Convert.ToBase64String(new byte[32]),
            ShardIds: new List<Guid>()
        );

        // Act
        var result = await controller.Create(request);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact(Skip = "Requires PostgreSQL - uses FOR UPDATE row locking")]
    public async Task Security_Manifests_ViewerCannotCreateManifest()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(UserA);
        var viewer = await builder.CreateUserAsync(UserB);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, viewer, "viewer", owner);

        var controller = new ManifestsController(db, config, new MockQuotaSettingsService(), NullLoggerFactory.CreateNullLogger<ManifestsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserB)
            }
        };

        var request = new ManifestsController.CreateManifestRequest(
            AlbumId: album.Id,
            EncryptedMeta: new byte[100],
            Signature: Convert.ToBase64String(new byte[64]),
            SignerPubkey: Convert.ToBase64String(new byte[32]),
            ShardIds: new List<Guid>()
        );

        // Act
        var result = await controller.Create(request);

        // Assert - Viewers cannot create manifests (only contributors and owners)
        Assert.IsType<ForbidResult>(result);
    }

    [Fact(Skip = "Requires PostgreSQL - uses FOR UPDATE row locking")]
    public async Task Security_Manifests_RevokedMemberCannotCreateManifest()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(UserA);
        var member = await builder.CreateUserAsync(UserB);
        var album = await builder.CreateAlbumAsync(owner);
        var membership = await builder.AddMemberAsync(album, member, "contributor", owner);
        
        // Revoke membership
        membership.RevokedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();

        var controller = new ManifestsController(db, config, new MockQuotaSettingsService(), NullLoggerFactory.CreateNullLogger<ManifestsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserB)
            }
        };

        var request = new ManifestsController.CreateManifestRequest(
            AlbumId: album.Id,
            EncryptedMeta: new byte[100],
            Signature: Convert.ToBase64String(new byte[64]),
            SignerPubkey: Convert.ToBase64String(new byte[32]),
            ShardIds: new List<Guid>()
        );

        // Act
        var result = await controller.Create(request);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Security_Manifests_NonMemberCannotGetManifest()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(UserA);
        await builder.CreateUserAsync(UserB);
        var album = await builder.CreateAlbumAsync(owner);
        var manifest = await builder.CreateManifestAsync(album, new List<Mosaic.Backend.Data.Entities.Shard>());

        var controller = new ManifestsController(db, config, new MockQuotaSettingsService(), NullLoggerFactory.CreateNullLogger<ManifestsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserB)
            }
        };

        // Act
        var result = await controller.Get(manifest.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    #endregion

    #region Epoch Key Access Control

    [Fact]
    public async Task Security_EpochKeys_NonMemberCannotGetEpochKeys()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(UserA);
        await builder.CreateUserAsync(UserB);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new EpochKeysController(db, config)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserB)
            }
        };

        // Act
        var result = await controller.List(album.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Security_EpochKeys_RevokedMemberCannotAccessEpochKeysEndpoint()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(UserA);
        var member = await builder.CreateUserAsync(UserB);
        var album = await builder.CreateAlbumAsync(owner, currentEpochId: 2);
        var membership = await builder.AddMemberAsync(album, member, "viewer", owner);
        
        // Create epoch key for epoch 1 that member received
        await builder.CreateEpochKeyAsync(album, member, 1);
        
        // Revoke membership
        membership.RevokedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();

        var controller = new EpochKeysController(db, config)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserB)
            }
        };

        // Act
        var result = await controller.List(album.Id);

        // Assert - Current implementation denies access once membership is revoked
        // Historical keys are already stored client-side
        Assert.IsType<ForbidResult>(result);
    }

    #endregion

    #region Cross-User Data Isolation

    [Fact]
    public async Task Security_DataIsolation_UsersCannotSeeOtherUsersAlbums()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        // Create multiple users with distinct data
        var userA = await builder.CreateUserAsync(UserA);
        var userB = await builder.CreateUserAsync(UserB);
        var userC = await builder.CreateUserAsync(UserC);

        // Each user has their own albums
        await builder.CreateAlbumAsync(userA);
        await builder.CreateAlbumAsync(userA);
        await builder.CreateAlbumAsync(userB);
        await builder.CreateAlbumAsync(userC);
        await builder.CreateAlbumAsync(userC);
        await builder.CreateAlbumAsync(userC);

        // Get albums for each user
        async Task<int> GetAlbumCount(string authSub)
        {
            var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), NullLoggerFactory.CreateNullLogger<AlbumsController>())
            {
                ControllerContext = new ControllerContext
                {
                    HttpContext = TestHttpContext.Create(authSub)
                }
            };
            var result = await controller.List();
            var okResult = Assert.IsType<OkObjectResult>(result);
            return Assert.IsAssignableFrom<IEnumerable<object>>(okResult.Value).Count();
        }

        // Assert - Each user sees only their own albums
        Assert.Equal(2, await GetAlbumCount(UserA));
        Assert.Equal(1, await GetAlbumCount(UserB));
        Assert.Equal(3, await GetAlbumCount(UserC));
    }

    [Fact]
    public async Task Security_DataIsolation_KnowingGUIDDoesNotGrantAccess()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(UserA);
        await builder.CreateUserAsync(UserB);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserB)
            }
        };

        // Act - Try to access album by its ID (simulating attacker knowing/guessing GUID)
        var result = await controller.Get(album.Id);

        // Assert - Even if attacker knows the GUID, they can't access it
        Assert.IsType<ForbidResult>(result);
    }

    #endregion

    #region Share Link Security

    [Fact]
    public async Task Security_ShareLinks_NonOwnerCannotCreateShareLinks()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(UserA);
        var member = await builder.CreateUserAsync(UserB);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, member, "viewer", owner);

        var controller = new ShareLinksController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserB) // Not owner
            }
        };

        var request = new CreateShareLinkRequest
        {
            AccessTier = 1,
            ExpiresAt = null,
            MaxUses = null,
            LinkId = new byte[16],
            WrappedKeys = new List<WrappedKeyRequest>
            {
                new WrappedKeyRequest
                {
                    EpochId = 1,
                    Tier = 1,
                    Nonce = new byte[24],
                    EncryptedKey = new byte[48]
                }
            }
        };

        // Act
        var result = await controller.Create(album.Id, request);

        // Assert - Only owner can create share links
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Security_ShareLinks_RevokedLinkCannotBeAccessed()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(UserA);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, isRevoked: true);

        var controller = new ShareLinksController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserA)
            }
        };

        // Convert linkId to base64url string as the API expects
        var linkIdBase64 = Convert.ToBase64String(shareLink.LinkId)
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');

        // Act
        var result = await controller.Access(linkIdBase64);

        // Assert - Revoked links return 410 Gone
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status410Gone, objectResult.StatusCode);
    }

    [Fact]
    public async Task Security_ShareLinks_ExpiredLinkCannotBeAccessed()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(UserA);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(
            album, 
            expiresAt: DateTimeOffset.UtcNow.AddDays(-1)); // Expired

        var controller = new ShareLinksController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserA)
            }
        };

        var linkIdBase64 = Convert.ToBase64String(shareLink.LinkId)
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');

        // Act
        var result = await controller.Access(linkIdBase64);

        // Assert - Expired links return 410 Gone
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status410Gone, objectResult.StatusCode);
    }

    [Fact]
    public async Task Security_ShareLinks_MaxUsesEnforced()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(UserA);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(
            album,
            maxUses: 5,
            useCount: 5); // Already at max

        var controller = new ShareLinksController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserA)
            }
        };

        var linkIdBase64 = Convert.ToBase64String(shareLink.LinkId)
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');

        // Act
        var result = await controller.Access(linkIdBase64);

        // Assert - Links at max uses return 410 Gone
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status410Gone, objectResult.StatusCode);
    }

    #endregion

    #region Input Validation Security

    [Fact]
    public async Task Security_Validation_RejectsEmptyEpochKeyBundle()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        await new TestDataBuilder(db).CreateUserAsync(UserA);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserA)
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
        Assert.IsType<BadRequestObjectResult>(result);
    }

    [Fact]
    public async Task Security_Validation_RejectsMissingInitialEpochKey()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        await new TestDataBuilder(db).CreateUserAsync(UserA);

        var controller = new AlbumsController(db, config, new MockQuotaSettingsService(), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UserA)
            }
        };

        var request = new CreateAlbumRequest
        {
            InitialEpochKey = null!
        };

        // Act
        var result = await controller.Create(request);

        // Assert
        Assert.IsType<BadRequestObjectResult>(result);
    }

    #endregion
}


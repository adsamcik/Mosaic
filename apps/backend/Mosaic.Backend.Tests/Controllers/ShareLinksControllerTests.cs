using Microsoft.AspNetCore.Mvc;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Models.ShareLinks;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Tests.Helpers;
using Xunit;
using Mosaic.Backend.Tests.TestHelpers;


namespace Mosaic.Backend.Tests.Controllers;

public class ShareLinksControllerTests
{
    private const string OwnerAuthSub = "owner-user-123";
    private const string OtherAuthSub = "other-user-456";

    #region Helper Methods

    private static string ToBase64Url(byte[] bytes)
    {
        return Convert.ToBase64String(bytes)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');
    }

    private static CreateShareLinkRequest CreateValidRequest(byte[]? linkId = null)
    {
        return new CreateShareLinkRequest
        {
            AccessTier = 3,
            LinkId = linkId ?? TestDataBuilder.GenerateRandomBytes(16),
            WrappedKeys = new List<WrappedKeyRequest>
            {
                new WrappedKeyRequest
                {
                    EpochId = 1,
                    Tier = 3,
                    Nonce = TestDataBuilder.GenerateRandomBytes(24),
                    EncryptedKey = TestDataBuilder.GenerateRandomBytes(48)
                }
            }
        };
    }

    #endregion

    #region POST /api/albums/{albumId}/share-links

    [Fact]
    public async Task Create_ReturnsCreated_WhenOwnerCreatesValidLink()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = CreateValidRequest();

        // Act
        var result = await controller.Create(album.Id, request);

        // Assert
        var createdResult = Assert.IsType<CreatedResult>(result);
        var response = Assert.IsType<ShareLinkResponse>(createdResult.Value);
        Assert.Equal(3, response.AccessTier);
        Assert.False(response.IsRevoked);
        Assert.Equal(0, response.UseCount);
        Assert.Null(response.ExpiresAt);
        Assert.Null(response.MaxUses);

        // Verify database state
        Assert.Single(db.ShareLinks);
        Assert.Single(db.LinkEpochKeys);
    }

    [Fact]
    public async Task Create_CreatesMultipleEpochKeys_WhenMultipleProvided()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentEpochId: 2);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new CreateShareLinkRequest
        {
            AccessTier = 2,
            LinkId = TestDataBuilder.GenerateRandomBytes(16),
            WrappedKeys = new List<WrappedKeyRequest>
            {
                new() { EpochId = 1, Tier = 2, Nonce = TestDataBuilder.GenerateRandomBytes(24), EncryptedKey = TestDataBuilder.GenerateRandomBytes(48) },
                new() { EpochId = 1, Tier = 1, Nonce = TestDataBuilder.GenerateRandomBytes(24), EncryptedKey = TestDataBuilder.GenerateRandomBytes(48) },
                new() { EpochId = 2, Tier = 2, Nonce = TestDataBuilder.GenerateRandomBytes(24), EncryptedKey = TestDataBuilder.GenerateRandomBytes(48) },
                new() { EpochId = 2, Tier = 1, Nonce = TestDataBuilder.GenerateRandomBytes(24), EncryptedKey = TestDataBuilder.GenerateRandomBytes(48) }
            }
        };

        // Act
        var result = await controller.Create(album.Id, request);

        // Assert
        Assert.IsType<CreatedResult>(result);
        Assert.Equal(4, db.LinkEpochKeys.Count());
    }

    [Fact]
    public async Task Create_SetsExpirationAndMaxUses_WhenProvided()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var expiresAt = DateTimeOffset.UtcNow.AddDays(7);
        var request = CreateValidRequest();
        request.ExpiresAt = expiresAt;
        request.MaxUses = 10;

        // Act
        var result = await controller.Create(album.Id, request);

        // Assert
        var createdResult = Assert.IsType<CreatedResult>(result);
        var response = Assert.IsType<ShareLinkResponse>(createdResult.Value);
        Assert.NotNull(response.ExpiresAt);
        Assert.Equal(10, response.MaxUses);
    }

    [Fact]
    public async Task Create_ReturnsNotFound_WhenAlbumDoesNotExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        await builder.CreateUserAsync(OwnerAuthSub);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = CreateValidRequest();

        // Act
        var result = await controller.Create(Guid.NewGuid(), request);

        // Assert
        ProblemDetailsAssertions.AssertNotFound(result);
    }

    [Fact]
    public async Task Create_ReturnsForbid_WhenUserIsNotOwner()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var other = await builder.CreateUserAsync(OtherAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, other, "viewer", owner);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OtherAuthSub)
            }
        };

        var request = CreateValidRequest();

        // Act
        var result = await controller.Create(album.Id, request);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Create_ReturnsBadRequest_WhenAccessTierInvalid()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = CreateValidRequest();
        request.AccessTier = 5;

        // Act
        var result = await controller.Create(album.Id, request);

        // Assert
        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("accessTier", ProblemDetailsAssertions.GetDetail(badRequest));
    }

    [Fact]
    public async Task Create_ReturnsBadRequest_WhenLinkIdWrongLength()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = CreateValidRequest(linkId: new byte[8]); // Wrong length

        // Act
        var result = await controller.Create(album.Id, request);

        // Assert
        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("linkId", ProblemDetailsAssertions.GetDetail(badRequest));
    }

    [Fact]
    public async Task Create_ReturnsBadRequest_WhenNonceWrongLength()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new CreateShareLinkRequest
        {
            AccessTier = 3,
            LinkId = TestDataBuilder.GenerateRandomBytes(16),
            WrappedKeys = new List<WrappedKeyRequest>
            {
                new WrappedKeyRequest
                {
                    EpochId = 1,
                    Tier = 3,
                    Nonce = new byte[12], // Wrong length, should be 24
                    EncryptedKey = TestDataBuilder.GenerateRandomBytes(48)
                }
            }
        };

        // Act
        var result = await controller.Create(album.Id, request);

        // Assert
        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("nonce", ProblemDetailsAssertions.GetDetail(badRequest));
    }

    [Fact]
    public async Task Create_ReturnsBadRequest_WhenExpiresAtInPast()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = CreateValidRequest();
        request.ExpiresAt = DateTimeOffset.UtcNow.AddDays(-1);

        // Act
        var result = await controller.Create(album.Id, request);

        // Assert
        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("expiresAt", ProblemDetailsAssertions.GetDetail(badRequest));
    }

    [Fact]
    public async Task Create_ReturnsBadRequest_WhenMaxUsesNotPositive()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = CreateValidRequest();
        request.MaxUses = 0;

        // Act
        var result = await controller.Create(album.Id, request);

        // Assert
        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("maxUses", ProblemDetailsAssertions.GetDetail(badRequest));
    }

    [Fact]
    public async Task Create_ReturnsConflict_WhenLinkIdAlreadyExists()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var existingLinkId = TestDataBuilder.GenerateRandomBytes(16);
        await builder.CreateShareLinkAsync(album, linkId: existingLinkId);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = CreateValidRequest(linkId: existingLinkId);

        // Act
        var result = await controller.Create(album.Id, request);

        // Assert
        ProblemDetailsAssertions.AssertConflict(result);
    }

    #endregion

    #region GET /api/albums/{albumId}/share-links

    [Fact]
    public async Task List_ReturnsEmptyList_WhenNoLinksExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        // Act
        var result = await controller.List(album.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var links = Assert.IsAssignableFrom<List<ShareLinkResponse>>(okResult.Value);
        Assert.Empty(links);
    }

    [Fact]
    public async Task List_ReturnsAllLinks_WhenLinksExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.CreateShareLinkAsync(album, accessTier: 1);
        await builder.CreateShareLinkAsync(album, accessTier: 2);
        await builder.CreateShareLinkAsync(album, accessTier: 3);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        // Act
        var result = await controller.List(album.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var links = Assert.IsAssignableFrom<List<ShareLinkResponse>>(okResult.Value);
        Assert.Equal(3, links.Count);
    }

    [Fact]
    public async Task List_ReturnsNotFound_WhenAlbumDoesNotExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        await builder.CreateUserAsync(OwnerAuthSub);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        // Act
        var result = await controller.List(Guid.NewGuid());

        // Assert
        ProblemDetailsAssertions.AssertNotFound(result);
    }

    [Fact]
    public async Task List_ReturnsForbid_WhenUserIsNotOwner()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var other = await builder.CreateUserAsync(OtherAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, other, "editor", owner);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OtherAuthSub)
            }
        };

        // Act
        var result = await controller.List(album.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    #endregion

    #region GET /api/albums/{albumId}/share-links/with-secrets

    [Fact]
    public async Task ListWithSecrets_ReturnsActiveLinksWithSecrets()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        // Create a link with owner-encrypted secret
        var ownerSecret = TestDataBuilder.GenerateRandomBytes(40); // nonce + ciphertext
        var shareLink = await builder.CreateShareLinkAsync(album, ownerEncryptedSecret: ownerSecret);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        // Act
        var result = await controller.ListWithSecrets(album.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var links = Assert.IsAssignableFrom<List<ShareLinkWithSecretResponse>>(okResult.Value);
        Assert.Single(links);
        Assert.Equal(shareLink.Id, links[0].Id);
        Assert.NotNull(links[0].OwnerEncryptedSecret);
    }

    [Fact]
    public async Task ListWithSecrets_ExcludesRevokedLinks()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var ownerSecret = TestDataBuilder.GenerateRandomBytes(40);
        await builder.CreateShareLinkAsync(album, isRevoked: true, ownerEncryptedSecret: ownerSecret);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        // Act
        var result = await controller.ListWithSecrets(album.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var links = Assert.IsAssignableFrom<List<ShareLinkWithSecretResponse>>(okResult.Value);
        Assert.Empty(links);
    }

    [Fact]
    public async Task ListWithSecrets_ExcludesExpiredLinks()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var ownerSecret = TestDataBuilder.GenerateRandomBytes(40);
        await builder.CreateShareLinkAsync(album, expiresAt: DateTimeOffset.UtcNow.AddDays(-1), ownerEncryptedSecret: ownerSecret);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        // Act
        var result = await controller.ListWithSecrets(album.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var links = Assert.IsAssignableFrom<List<ShareLinkWithSecretResponse>>(okResult.Value);
        Assert.Empty(links);
    }

    [Fact]
    public async Task ListWithSecrets_ExcludesLinksWithoutSecret()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        // Create a link without owner-encrypted secret
        await builder.CreateShareLinkAsync(album);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        // Act
        var result = await controller.ListWithSecrets(album.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var links = Assert.IsAssignableFrom<List<ShareLinkWithSecretResponse>>(okResult.Value);
        Assert.Empty(links);
    }

    [Fact]
    public async Task ListWithSecrets_ReturnsNotFound_WhenAlbumDoesNotExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        await builder.CreateUserAsync(OwnerAuthSub);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        // Act
        var result = await controller.ListWithSecrets(Guid.NewGuid());

        // Assert
        ProblemDetailsAssertions.AssertNotFound(result);
    }

    [Fact]
    public async Task ListWithSecrets_ReturnsForbid_WhenUserIsNotOwner()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var other = await builder.CreateUserAsync(OtherAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OtherAuthSub)
            }
        };

        // Act
        var result = await controller.ListWithSecrets(album.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    #endregion

    #region DELETE /api/share-links/{id}

    [Fact]
    public async Task Revoke_ReturnsNoContent_WhenOwnerRevokesLink()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        // Act
        var result = await controller.Revoke(shareLink.Id);

        // Assert
        Assert.IsType<NoContentResult>(result);

        // Verify link is revoked
        var updatedLink = db.ShareLinks.First(sl => sl.Id == shareLink.Id);
        Assert.True(updatedLink.IsRevoked);
    }

    [Fact]
    public async Task Revoke_ReturnsNotFound_WhenLinkDoesNotExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        await builder.CreateUserAsync(OwnerAuthSub);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        // Act
        var result = await controller.Revoke(Guid.NewGuid());

        // Assert
        ProblemDetailsAssertions.AssertNotFound(result);
    }

    [Fact]
    public async Task Revoke_ReturnsForbid_WhenUserIsNotOwner()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var other = await builder.CreateUserAsync(OtherAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OtherAuthSub)
            }
        };

        // Act
        var result = await controller.Revoke(shareLink.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    #endregion

    #region POST /api/share-links/{id}/keys

    [Fact]
    public async Task AddEpochKeys_ReturnsOk_WhenOwnerAddsKeys()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, accessTier: 3);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new AddEpochKeysRequest
        {
            EpochKeys = new List<EpochKeyDto>
            {
                new EpochKeyDto { EpochId = 2, Tier = 3, Nonce = TestDataBuilder.GenerateRandomBytes(24), EncryptedKey = TestDataBuilder.GenerateRandomBytes(48) },
                new EpochKeyDto { EpochId = 2, Tier = 2, Nonce = TestDataBuilder.GenerateRandomBytes(24), EncryptedKey = TestDataBuilder.GenerateRandomBytes(48) },
                new EpochKeyDto { EpochId = 2, Tier = 1, Nonce = TestDataBuilder.GenerateRandomBytes(24), EncryptedKey = TestDataBuilder.GenerateRandomBytes(48) }
            }
        };

        // Act
        var result = await controller.AddEpochKeys(shareLink.Id, request);

        // Assert
        Assert.IsType<OkObjectResult>(result);
        Assert.Equal(3, db.LinkEpochKeys.Count(k => k.ShareLinkId == shareLink.Id && k.EpochId == 2));
    }

    [Fact]
    public async Task AddEpochKeys_UpdatesExistingKeys_WhenSameEpochAndTier()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, accessTier: 3);
        await builder.CreateLinkEpochKeyAsync(shareLink, 1, 3);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var newNonce = TestDataBuilder.GenerateRandomBytes(24);
        var newEncryptedKey = TestDataBuilder.GenerateRandomBytes(48);
        var request = new AddEpochKeysRequest
        {
            EpochKeys = new List<EpochKeyDto>
            {
                new EpochKeyDto { EpochId = 1, Tier = 3, Nonce = newNonce, EncryptedKey = newEncryptedKey }
            }
        };

        // Act
        var result = await controller.AddEpochKeys(shareLink.Id, request);

        // Assert
        Assert.IsType<OkObjectResult>(result);
        var updatedKey = db.LinkEpochKeys.First(k => k.ShareLinkId == shareLink.Id && k.EpochId == 1 && k.Tier == 3);
        Assert.Equal(newNonce, updatedKey.WrappedNonce);
        Assert.Equal(newEncryptedKey, updatedKey.WrappedKey);
    }

    [Fact]
    public async Task AddEpochKeys_ReturnsNotFound_WhenLinkDoesNotExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        await builder.CreateUserAsync(OwnerAuthSub);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new AddEpochKeysRequest
        {
            EpochKeys = new List<EpochKeyDto>
            {
                new EpochKeyDto { EpochId = 1, Tier = 3, Nonce = TestDataBuilder.GenerateRandomBytes(24), EncryptedKey = TestDataBuilder.GenerateRandomBytes(48) }
            }
        };

        // Act
        var result = await controller.AddEpochKeys(Guid.NewGuid(), request);

        // Assert
        ProblemDetailsAssertions.AssertNotFound(result);
    }

    [Fact]
    public async Task AddEpochKeys_ReturnsForbid_WhenUserIsNotOwner()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var other = await builder.CreateUserAsync(OtherAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OtherAuthSub)
            }
        };

        var request = new AddEpochKeysRequest
        {
            EpochKeys = new List<EpochKeyDto>
            {
                new EpochKeyDto { EpochId = 1, Tier = 3, Nonce = TestDataBuilder.GenerateRandomBytes(24), EncryptedKey = TestDataBuilder.GenerateRandomBytes(48) }
            }
        };

        // Act
        var result = await controller.AddEpochKeys(shareLink.Id, request);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task AddEpochKeys_ReturnsBadRequest_WhenLinkIsRevoked()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, isRevoked: true);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new AddEpochKeysRequest
        {
            EpochKeys = new List<EpochKeyDto>
            {
                new EpochKeyDto { EpochId = 1, Tier = 3, Nonce = TestDataBuilder.GenerateRandomBytes(24), EncryptedKey = TestDataBuilder.GenerateRandomBytes(48) }
            }
        };

        // Act
        var result = await controller.AddEpochKeys(shareLink.Id, request);

        // Assert
        var badRequestResult = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("revoked", ProblemDetailsAssertions.GetDetail(badRequestResult)?.ToLower());
    }

    [Fact]
    public async Task AddEpochKeys_ReturnsBadRequest_WhenNonceInvalid()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new AddEpochKeysRequest
        {
            EpochKeys = new List<EpochKeyDto>
            {
                new EpochKeyDto { EpochId = 1, Tier = 3, Nonce = TestDataBuilder.GenerateRandomBytes(16), EncryptedKey = TestDataBuilder.GenerateRandomBytes(48) }  // Invalid: 16 bytes instead of 24
            }
        };

        // Act
        var result = await controller.AddEpochKeys(shareLink.Id, request);

        // Assert
        var badRequestResult = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("24-byte", ProblemDetailsAssertions.GetDetail(badRequestResult)?.ToLower());
    }

    [Fact]
    public async Task AddEpochKeys_ReturnsBadRequest_WhenTierInvalid()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new AddEpochKeysRequest
        {
            EpochKeys = new List<EpochKeyDto>
            {
                new EpochKeyDto { EpochId = 1, Tier = 5, Nonce = TestDataBuilder.GenerateRandomBytes(24), EncryptedKey = TestDataBuilder.GenerateRandomBytes(48) }  // Invalid: tier must be 1-3
            }
        };

        // Act
        var result = await controller.AddEpochKeys(shareLink.Id, request);

        // Assert
        var badRequestResult = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("tier", ProblemDetailsAssertions.GetDetail(badRequestResult)?.ToLower());
    }

    [Fact]
    public async Task AddEpochKeys_ReturnsBadRequest_WhenEpochKeysEmpty()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new AddEpochKeysRequest
        {
            EpochKeys = new List<EpochKeyDto>()  // Empty list
        };

        // Act
        var result = await controller.AddEpochKeys(shareLink.Id, request);

        // Assert
        var badRequestResult = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("required", ProblemDetailsAssertions.GetDetail(badRequestResult)?.ToLower());
    }

    #endregion

    #region GET /api/s/{linkId}

    [Fact]
    public async Task Access_ReturnsOk_WhenLinkIsValid()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, accessTier: 2);
        await builder.CreateLinkEpochKeyAsync(shareLink, 1, 2);
        await builder.CreateLinkEpochKeyAsync(shareLink, 1, 1);

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        // Act
        var result = await controller.Access(linkIdBase64);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var response = Assert.IsType<LinkAccessResponse>(okResult.Value);
        Assert.Equal(album.Id, response.AlbumId);
        Assert.Equal(2, response.AccessTier);
        Assert.Equal(1, response.EpochCount); // Two keys but same epoch
    }

    [Fact]
    public async Task Access_IncrementsUseCount()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, useCount: 5);

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        // Act
        await controller.Access(linkIdBase64);

        // Assert
        var updatedLink = db.ShareLinks.First(sl => sl.Id == shareLink.Id);
        Assert.Equal(6, updatedLink.UseCount);
    }

    [Fact]
    public async Task Access_ReturnsNotFound_WhenLinkDoesNotExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(TestDataBuilder.GenerateRandomBytes(16));

        // Act
        var result = await controller.Access(linkIdBase64);

        // Assert
        ProblemDetailsAssertions.AssertNotFound(result);
    }

    [Fact]
    public async Task Access_ReturnsBadRequest_WhenLinkIdInvalidFormat()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        // Act
        var result = await controller.Access("invalid!!!base64");

        // Assert
        ProblemDetailsAssertions.AssertBadRequest(result);
    }

    [Fact]
    public async Task Access_ReturnsGone_WhenLinkIsRevoked()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, isRevoked: true);

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        // Act
        var result = await controller.Access(linkIdBase64);

        // Assert
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(410, objectResult.StatusCode);
    }

    [Fact]
    public async Task Access_ReturnsGone_WhenLinkIsExpired()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, expiresAt: DateTimeOffset.UtcNow.AddDays(-1));

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        // Act
        var result = await controller.Access(linkIdBase64);

        // Assert
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(410, objectResult.StatusCode);
    }

    [Fact]
    public async Task Access_ReturnsGone_WhenMaxUsesReached()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, maxUses: 5, useCount: 5);

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        // Act
        var result = await controller.Access(linkIdBase64);

        // Assert
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(410, objectResult.StatusCode);
    }

    #endregion

    #region GET /api/s/{linkId}/keys

    [Fact]
    public async Task GetKeys_ReturnsAllKeys_WhenLinkIsValid()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentEpochId: 2);
        await builder.CreateEpochKeyAsync(album, owner, epochId: 1);
        await builder.CreateEpochKeyAsync(album, owner, epochId: 2);

        var shareLink = await builder.CreateShareLinkAsync(album, accessTier: 3);
        await builder.CreateLinkEpochKeyAsync(shareLink, 1, 3);
        await builder.CreateLinkEpochKeyAsync(shareLink, 1, 2);
        await builder.CreateLinkEpochKeyAsync(shareLink, 2, 3);
        await builder.CreateLinkEpochKeyAsync(shareLink, 2, 2);

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        // Act
        var result = await controller.GetKeys(linkIdBase64);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var keys = Assert.IsAssignableFrom<List<LinkEpochKeyResponse>>(okResult.Value);
        Assert.Equal(4, keys.Count);
        Assert.All(keys, k => Assert.NotNull(k.Nonce));
        Assert.All(keys, k => Assert.NotNull(k.EncryptedKey));
    }

    [Fact]
    public async Task GetKeys_ReturnsNotFound_WhenLinkDoesNotExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(TestDataBuilder.GenerateRandomBytes(16));

        // Act
        var result = await controller.GetKeys(linkIdBase64);

        // Assert
        ProblemDetailsAssertions.AssertNotFound(result);
    }

    [Fact]
    public async Task GetKeys_ReturnsGone_WhenLinkIsRevoked()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, isRevoked: true);

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        // Act
        var result = await controller.GetKeys(linkIdBase64);

        // Assert
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(410, objectResult.StatusCode);
    }

    #endregion

    #region GET /api/s/{linkId}/photos

    [Fact]
    public async Task GetPhotos_ReturnsPhotos_WhenLinkIsValid()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var shard1 = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var shard2 = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        await builder.CreateManifestAsync(album, new List<Data.Entities.Shard> { shard1 });
        await builder.CreateManifestAsync(album, new List<Data.Entities.Shard> { shard2 });

        var shareLink = await builder.CreateShareLinkAsync(album, accessTier: 3);

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        // Act
        var result = await controller.GetPhotos(linkIdBase64);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var photos = Assert.IsAssignableFrom<List<ShareLinkPhotoResponse>>(okResult.Value);
        Assert.Equal(2, photos.Count);
        Assert.All(photos, p => Assert.Single(p.ShardIds));
    }

    [Fact]
    public async Task GetPhotos_ExcludesDeletedPhotos()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var shard1 = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var shard2 = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        await builder.CreateManifestAsync(album, new List<Data.Entities.Shard> { shard1 });
        await builder.CreateManifestAsync(album, new List<Data.Entities.Shard> { shard2 }, isDeleted: true);

        var shareLink = await builder.CreateShareLinkAsync(album, accessTier: 3);

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        // Act
        var result = await controller.GetPhotos(linkIdBase64);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var photos = Assert.IsAssignableFrom<List<ShareLinkPhotoResponse>>(okResult.Value);
        Assert.Single(photos);
    }

    [Fact]
    public async Task GetPhotos_ReturnsNotFound_WhenLinkDoesNotExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(TestDataBuilder.GenerateRandomBytes(16));

        // Act
        var result = await controller.GetPhotos(linkIdBase64);

        // Assert
        ProblemDetailsAssertions.AssertNotFound(result);
    }

    [Fact]
    public async Task GetPhotos_ReturnsGone_WhenLinkIsExpired()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, expiresAt: DateTimeOffset.UtcNow.AddDays(-1));

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        // Act
        var result = await controller.GetPhotos(linkIdBase64);

        // Assert
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(410, objectResult.StatusCode);
    }

    #endregion

    #region GET /api/s/{linkId}/shards/{shardId}

    [Fact]
    public async Task DownloadShard_ReturnsShard_WhenLinkIsValidAndShardBelongsToAlbum()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        storage.AddFile(shard.StorageKey, new byte[] { 0xDE, 0xAD, 0xBE, 0xEF });
        await builder.CreateManifestAsync(album, new List<Data.Entities.Shard> { shard });

        var shareLink = await builder.CreateShareLinkAsync(album, accessTier: 3);

        var controller = new ShareLinkAccessController(db, config, storage)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        // Act
        var result = await controller.DownloadShard(linkIdBase64, shard.Id);

        // Assert
        var fileResult = Assert.IsType<FileStreamResult>(result);
        Assert.Equal("application/octet-stream", fileResult.ContentType);

        using var ms = new MemoryStream();
        await fileResult.FileStream.CopyToAsync(ms);
        var content = ms.ToArray();
        Assert.Equal(new byte[] { 0xDE, 0xAD, 0xBE, 0xEF }, content);
    }

    [Fact]
    public async Task DownloadShard_ReturnsNotFound_WhenLinkDoesNotExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);

        var controller = new ShareLinkAccessController(db, config, storage)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(TestDataBuilder.GenerateRandomBytes(16));

        // Act
        var result = await controller.DownloadShard(linkIdBase64, Guid.NewGuid());

        // Assert
        ProblemDetailsAssertions.AssertNotFound(result);
    }

    [Fact]
    public async Task DownloadShard_ReturnsNotFound_WhenShardDoesNotExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, accessTier: 3);

        var controller = new ShareLinkAccessController(db, config, storage)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        // Act
        var result = await controller.DownloadShard(linkIdBase64, Guid.NewGuid());

        // Assert
        var notFound = ProblemDetailsAssertions.AssertNotFound(result);
        Assert.NotNull(notFound.Value);
        var json = System.Text.Json.JsonSerializer.Serialize(notFound.Value);
        Assert.Contains("Shard not found", json);
    }

    [Fact]
    public async Task DownloadShard_ReturnsNotFound_WhenShardIsNotActive()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var shard = await builder.CreateShardAsync(owner, ShardStatus.TRASHED);
        await builder.CreateManifestAsync(album, new List<Data.Entities.Shard> { shard });

        var shareLink = await builder.CreateShareLinkAsync(album, accessTier: 3);

        var controller = new ShareLinkAccessController(db, config, storage)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        // Act
        var result = await controller.DownloadShard(linkIdBase64, shard.Id);

        // Assert
        var notFound = ProblemDetailsAssertions.AssertNotFound(result);
        Assert.NotNull(notFound.Value);
        var json = System.Text.Json.JsonSerializer.Serialize(notFound.Value);
        Assert.Contains("Shard not available", json);
    }

    [Fact]
    public async Task DownloadShard_ReturnsForbidden_WhenShardNotInLinkedAlbum()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album1 = await builder.CreateAlbumAsync(owner);
        var album2 = await builder.CreateAlbumAsync(owner);

        // Shard belongs to album2
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        storage.AddFile(shard.StorageKey);
        await builder.CreateManifestAsync(album2, new List<Data.Entities.Shard> { shard });

        // Share link is for album1
        var shareLink = await builder.CreateShareLinkAsync(album1, accessTier: 3);

        var controller = new ShareLinkAccessController(db, config, storage)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        // Act
        var result = await controller.DownloadShard(linkIdBase64, shard.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task DownloadShard_ReturnsGone_WhenLinkIsRevoked()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        await builder.CreateManifestAsync(album, new List<Data.Entities.Shard> { shard });

        var shareLink = await builder.CreateShareLinkAsync(album, isRevoked: true);

        var controller = new ShareLinkAccessController(db, config, storage)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        // Act
        var result = await controller.DownloadShard(linkIdBase64, shard.Id);

        // Assert
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(410, objectResult.StatusCode);
    }

    [Fact]
    public async Task DownloadShard_ReturnsGone_WhenLinkIsExpired()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        await builder.CreateManifestAsync(album, new List<Data.Entities.Shard> { shard });

        var shareLink = await builder.CreateShareLinkAsync(album, expiresAt: DateTimeOffset.UtcNow.AddDays(-1));

        var controller = new ShareLinkAccessController(db, config, storage)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        // Act
        var result = await controller.DownloadShard(linkIdBase64, shard.Id);

        // Assert
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(410, objectResult.StatusCode);
    }

    [Fact]
    public async Task DownloadShard_ReturnsUnauthorized_WhenLinkHasMaxUsesAndNoGrantProvided()
    {
        // Regression: previously returned 410 Gone via ValidateShareLink MaxUses check,
        // which was broken because it blocked the last legitimate caller.
        // Now returns 401 Unauthorized when no grant token is presented for a limited-use link.
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        await builder.CreateManifestAsync(album, new List<Data.Entities.Shard> { shard });

        var shareLink = await builder.CreateShareLinkAsync(album, maxUses: 5, useCount: 5);

        var controller = new ShareLinkAccessController(db, config, storage)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        // Act
        var result = await controller.DownloadShard(linkIdBase64, shard.Id);

        // Assert
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(401, objectResult.StatusCode);
    }

    [Fact]
    public async Task DownloadShard_ReturnsForbidden_WhenShardInDeletedManifest()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        storage.AddFile(shard.StorageKey);
        await builder.CreateManifestAsync(album, new List<Data.Entities.Shard> { shard }, isDeleted: true);

        var shareLink = await builder.CreateShareLinkAsync(album, accessTier: 3);

        var controller = new ShareLinkAccessController(db, config, storage)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        // Act
        var result = await controller.DownloadShard(linkIdBase64, shard.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task DownloadShard_ReturnsBadRequest_WhenLinkIdInvalid()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var storage = new MockStorageService();

        var controller = new ShareLinkAccessController(db, config, storage)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        // Act
        var result = await controller.DownloadShard("!!!invalid!!!", Guid.NewGuid());

        // Assert
        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.NotNull(badRequest.Value);
        var json = System.Text.Json.JsonSerializer.Serialize(badRequest.Value);
        Assert.Contains("Invalid link ID format", json);
    }

    #endregion

    #region PATCH /api/albums/{albumId}/share-links/{linkId}/expiration

    [Fact]
    public async Task UpdateLinkExpiration_ReturnsOk_WhenOwnerUpdatesExpiration()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, accessTier: 3);
        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var newExpiresAt = DateTimeOffset.UtcNow.AddDays(30);
        var request = new UpdateLinkExpirationRequest(newExpiresAt, 50);

        // Act
        var result = await controller.UpdateLinkExpiration(album.Id, linkIdBase64, request);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var response = Assert.IsType<ShareLinkResponse>(okResult.Value);
        Assert.NotNull(response.ExpiresAt);
        Assert.True(Math.Abs((newExpiresAt - response.ExpiresAt.Value).TotalSeconds) < 1);
        Assert.Equal(50, response.MaxUses);

        // Verify database state
        var updated = db.ShareLinks.First(sl => sl.Id == shareLink.Id);
        Assert.Equal(50, updated.MaxUses);
    }

    [Fact]
    public async Task UpdateLinkExpiration_RemovesExpiration_WhenExpiresAtIsNull()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, accessTier: 3);
        shareLink.ExpiresAt = DateTimeOffset.UtcNow.AddDays(7);
        shareLink.MaxUses = 10;
        await db.SaveChangesAsync();

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new UpdateLinkExpirationRequest(null, null);

        // Act
        var result = await controller.UpdateLinkExpiration(album.Id, linkIdBase64, request);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var response = Assert.IsType<ShareLinkResponse>(okResult.Value);
        Assert.Null(response.ExpiresAt);
        Assert.Null(response.MaxUses);
    }

    [Fact]
    public async Task UpdateLinkExpiration_ReturnsNotFound_WhenAlbumDoesNotExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        await builder.CreateUserAsync(OwnerAuthSub);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new UpdateLinkExpirationRequest(DateTimeOffset.UtcNow.AddDays(30), null);

        // Act
        var result = await controller.UpdateLinkExpiration(Guid.NewGuid(), "validBase64Url", request);

        // Assert
        var notFound = ProblemDetailsAssertions.AssertNotFound(result);
        var json = System.Text.Json.JsonSerializer.Serialize(notFound.Value);
        Assert.Contains("Album not found", json);
    }

    [Fact]
    public async Task UpdateLinkExpiration_ReturnsForbid_WhenUserIsNotOwner()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        await builder.CreateUserAsync(OtherAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, accessTier: 3);
        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OtherAuthSub)
            }
        };

        var request = new UpdateLinkExpirationRequest(DateTimeOffset.UtcNow.AddDays(30), null);

        // Act
        var result = await controller.UpdateLinkExpiration(album.Id, linkIdBase64, request);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task UpdateLinkExpiration_ReturnsNotFound_WhenLinkDoesNotExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var fakeLinkId = ToBase64Url(TestDataBuilder.GenerateRandomBytes(16));

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new UpdateLinkExpirationRequest(DateTimeOffset.UtcNow.AddDays(30), null);

        // Act
        var result = await controller.UpdateLinkExpiration(album.Id, fakeLinkId, request);

        // Assert
        var notFound = ProblemDetailsAssertions.AssertNotFound(result);
        var json = System.Text.Json.JsonSerializer.Serialize(notFound.Value);
        Assert.Contains("Share link not found", json);
    }

    [Fact]
    public async Task UpdateLinkExpiration_ReturnsBadRequest_WhenLinkIsRevoked()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, accessTier: 3);
        shareLink.IsRevoked = true;
        await db.SaveChangesAsync();

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new UpdateLinkExpirationRequest(DateTimeOffset.UtcNow.AddDays(30), null);

        // Act
        var result = await controller.UpdateLinkExpiration(album.Id, linkIdBase64, request);

        // Assert
        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        var json = System.Text.Json.JsonSerializer.Serialize(badRequest.Value);
        Assert.Contains("Cannot update a revoked link", json);
    }

    [Fact]
    public async Task UpdateLinkExpiration_ReturnsBadRequest_WhenExpiresAtIsInPast()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, accessTier: 3);
        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new UpdateLinkExpirationRequest(DateTimeOffset.UtcNow.AddDays(-1), null);

        // Act
        var result = await controller.UpdateLinkExpiration(album.Id, linkIdBase64, request);

        // Assert
        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        var json = System.Text.Json.JsonSerializer.Serialize(badRequest.Value);
        Assert.Contains("expiresAt must be in the future", json);
    }

    [Fact]
    public async Task UpdateLinkExpiration_ReturnsBadRequest_WhenMaxUsesIsNotPositive()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, accessTier: 3);
        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new UpdateLinkExpirationRequest(null, 0);

        // Act
        var result = await controller.UpdateLinkExpiration(album.Id, linkIdBase64, request);

        // Assert
        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        var json = System.Text.Json.JsonSerializer.Serialize(badRequest.Value);
        Assert.Contains("maxUses must be positive", json);
    }

    [Fact]
    public async Task UpdateLinkExpiration_ReturnsBadRequest_WhenLinkIdIsInvalidFormat()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new UpdateLinkExpirationRequest(DateTimeOffset.UtcNow.AddDays(30), null);

        // Act
        var result = await controller.UpdateLinkExpiration(album.Id, "!!!invalid!!!", request);

        // Assert
        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        var json = System.Text.Json.JsonSerializer.Serialize(badRequest.Value);
        Assert.Contains("Invalid linkId format", json);
    }

    [Fact]
    public async Task UpdateLinkExpiration_ReturnsNotFound_WhenLinkBelongsToDifferentAlbum()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album1 = await builder.CreateAlbumAsync(owner);
        var album2 = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album1, accessTier: 3);
        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new UpdateLinkExpirationRequest(DateTimeOffset.UtcNow.AddDays(30), null);

        // Act - try to update with album2's ID but link belongs to album1
        var result = await controller.UpdateLinkExpiration(album2.Id, linkIdBase64, request);

        // Assert
        var notFound = ProblemDetailsAssertions.AssertNotFound(result);
        var json = System.Text.Json.JsonSerializer.Serialize(notFound.Value);
        Assert.Contains("Share link not found", json);
    }

    #endregion

    #region Album Expiration — Share Links

    [Fact]
    public async Task Create_Returns410_WhenAlbumExpired()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        album.ExpiresAt = DateTimeOffset.UtcNow.AddHours(-1);
        await db.SaveChangesAsync();

        var controller = new ShareLinksController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = CreateValidRequest();

        // Act
        var result = await controller.Create(album.Id, request);

        // Assert
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(410, objectResult.StatusCode);
    }

    [Fact]
    public async Task Access_Returns410_WhenAlbumExpired()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album);

        // Expire the album after link creation
        album.ExpiresAt = DateTimeOffset.UtcNow.AddHours(-1);
        await db.SaveChangesAsync();

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        // Act
        var result = await controller.Access(linkIdBase64);

        // Assert
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(410, objectResult.StatusCode);
    }

    [Fact]
    public async Task GetKeys_ReturnsGone_WhenAlbumExpired()
    {
        // Regression: GetKeys previously bypassed album expiry because it did not include Album
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album);

        album.ExpiresAt = DateTimeOffset.UtcNow.AddHours(-1);
        await db.SaveChangesAsync();

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        // Act
        var result = await controller.GetKeys(ToBase64Url(shareLink.LinkId));

        // Assert
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(410, objectResult.StatusCode);
    }

    [Fact]
    public async Task GetPhotos_ReturnsGone_WhenAlbumExpired()
    {
        // Regression: GetPhotos previously bypassed album expiry because it did not include Album
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album);

        album.ExpiresAt = DateTimeOffset.UtcNow.AddHours(-1);
        await db.SaveChangesAsync();

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        // Act
        var result = await controller.GetPhotos(ToBase64Url(shareLink.LinkId));

        // Assert
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(410, objectResult.StatusCode);
    }

    [Fact]
    public async Task DownloadShard_ReturnsGone_WhenAlbumExpired()
    {
        // Regression: DownloadShard previously bypassed album expiry because it did not include Album
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album);

        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        storage.AddFile(shard.StorageKey);
        await builder.CreateManifestAsync(album, new List<Data.Entities.Shard> { shard });

        album.ExpiresAt = DateTimeOffset.UtcNow.AddHours(-1);
        await db.SaveChangesAsync();

        var controller = new ShareLinkAccessController(db, config, storage)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        // Act
        var result = await controller.DownloadShard(ToBase64Url(shareLink.LinkId), shard.Id);

        // Assert
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(410, objectResult.StatusCode);
    }

    #endregion

    #region Grant Token — MaxUses Enforcement

    [Fact]
    public async Task Access_ReturnsGrantToken_WhenLinkIsValid()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, maxUses: 10);
        await builder.CreateLinkEpochKeyAsync(shareLink, 1, 3);

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        // Act
        var result = await controller.Access(ToBase64Url(shareLink.LinkId));

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var response = Assert.IsType<LinkAccessResponse>(okResult.Value);
        Assert.NotNull(response.GrantToken);
        Assert.NotEmpty(response.GrantToken);
    }

    [Fact]
    public async Task GetKeys_ReturnsUnauthorized_WhenMaxUsesSetAndNoGrantProvided()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, maxUses: 5);
        await builder.CreateLinkEpochKeyAsync(shareLink, 1, 3);

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        // Act — no grant header
        var result = await controller.GetKeys(ToBase64Url(shareLink.LinkId));

        // Assert
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(401, objectResult.StatusCode);
    }

    [Fact]
    public async Task GetKeys_ReturnsOk_WhenMaxUsesSetAndGrantIsValid()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentEpochId: 1);
        await builder.CreateEpochKeyAsync(album, owner, epochId: 1);
        var shareLink = await builder.CreateShareLinkAsync(album, maxUses: 5);
        await builder.CreateLinkEpochKeyAsync(shareLink, 1, 3);

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext { HttpContext = TestHttpContext.CreateUnauthenticated() }
        };

        var accessResult = await controller.Access(linkIdBase64);
        var accessOk = Assert.IsType<OkObjectResult>(accessResult);
        var accessResp = Assert.IsType<LinkAccessResponse>(accessOk.Value);

        // Inject the grant into the same controller's HttpContext
        controller.HttpContext.Request.Headers["X-Share-Grant"] = accessResp.GrantToken!;

        // Act
        var result = await controller.GetKeys(linkIdBase64);

        // Assert
        Assert.IsType<OkObjectResult>(result);
    }

    [Fact]
    public async Task GetKeys_ReturnsOk_WhenGrantIsUsedAcrossControllerInstances()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentEpochId: 1);
        await builder.CreateEpochKeyAsync(album, owner, epochId: 1);
        var shareLink = await builder.CreateShareLinkAsync(album, maxUses: 5);
        await builder.CreateLinkEpochKeyAsync(shareLink, 1, 3);

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        var accessController = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        var accessResult = await accessController.Access(linkIdBase64);
        var accessOk = Assert.IsType<OkObjectResult>(accessResult);
        var accessResp = Assert.IsType<LinkAccessResponse>(accessOk.Value);

        var keysController = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };
        keysController.HttpContext.Request.Headers["X-Share-Grant"] = accessResp.GrantToken!;

        // Act
        var result = await keysController.GetKeys(linkIdBase64);

        // Assert
        Assert.IsType<OkObjectResult>(result);
    }

    [Fact]
    public async Task GetPhotos_ReturnsUnauthorized_WhenMaxUsesSetAndNoGrantProvided()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, maxUses: 5);

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        // Act — no grant header
        var result = await controller.GetPhotos(ToBase64Url(shareLink.LinkId));

        // Assert
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(401, objectResult.StatusCode);
    }

    [Fact]
    public async Task GetPhotos_ReturnsOk_WhenMaxUsesSetAndGrantIsValid()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, maxUses: 5);
        await builder.CreateLinkEpochKeyAsync(shareLink, 1, 3);

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        var controller = new ShareLinkAccessController(db, config, new MockStorageService())
        {
            ControllerContext = new ControllerContext { HttpContext = TestHttpContext.CreateUnauthenticated() }
        };

        var accessResult = await controller.Access(linkIdBase64);
        var accessOk = Assert.IsType<OkObjectResult>(accessResult);
        var accessResp = Assert.IsType<LinkAccessResponse>(accessOk.Value);

        controller.HttpContext.Request.Headers["X-Share-Grant"] = accessResp.GrantToken!;

        // Act
        var result = await controller.GetPhotos(linkIdBase64);

        // Assert
        Assert.IsType<OkObjectResult>(result);
    }

    [Fact]
    public async Task DownloadShard_ReturnsUnauthorized_WhenMaxUsesSetAndNoGrantProvided()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, maxUses: 5);

        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        await builder.CreateManifestAsync(album, new List<Data.Entities.Shard> { shard });

        var controller = new ShareLinkAccessController(db, config, storage)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        // Act — no grant header
        var result = await controller.DownloadShard(ToBase64Url(shareLink.LinkId), shard.Id);

        // Assert
        var objectResult = Assert.IsType<ObjectResult>(result);
        Assert.Equal(401, objectResult.StatusCode);
    }

    [Fact]
    public async Task DownloadShard_ReturnsFile_WhenMaxUsesSetAndGrantIsValid()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, maxUses: 5, accessTier: 3);
        await builder.CreateLinkEpochKeyAsync(shareLink, 1, 3);

        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        storage.AddFile(shard.StorageKey);
        await builder.CreateManifestAsync(album, new List<Data.Entities.Shard> { shard });

        var linkIdBase64 = ToBase64Url(shareLink.LinkId);

        var controller = new ShareLinkAccessController(db, config, storage)
        {
            ControllerContext = new ControllerContext { HttpContext = TestHttpContext.CreateUnauthenticated() }
        };

        var accessResult = await controller.Access(linkIdBase64);
        var accessOk = Assert.IsType<OkObjectResult>(accessResult);
        var accessResp = Assert.IsType<LinkAccessResponse>(accessOk.Value);

        controller.HttpContext.Request.Headers["X-Share-Grant"] = accessResp.GrantToken!;

        // Act
        var result = await controller.DownloadShard(linkIdBase64, shard.Id);

        // Assert
        Assert.IsType<FileStreamResult>(result);
    }

    #endregion
}
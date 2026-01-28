using Microsoft.AspNetCore.Mvc;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Tests.Helpers;
using Xunit;
using Mosaic.Backend.Tests.TestHelpers;


namespace Mosaic.Backend.Tests.Controllers;

public class EpochKeysControllerTests
{
    private const string OwnerAuthSub = "owner-user";
    private const string MemberAuthSub = "member-user";

    [Fact]
    public async Task List_ReturnsEpochKeys_WhenUserHasAccess()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();

        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.CreateEpochKeyAsync(album, owner, epochId: 1);
        await builder.CreateEpochKeyAsync(album, owner, epochId: 2);

        var controller = new EpochKeysController(db, new MockCurrentUserService(db))
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
        var keys = Assert.IsAssignableFrom<IEnumerable<object>>(okResult.Value);
        Assert.Equal(2, keys.Count());
    }

    [Fact]
    public async Task List_ReturnsForbid_WhenUserNotMember()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();

        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new EpochKeysController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(MemberAuthSub)
            }
        };

        // Act
        var result = await controller.List(album.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Create_CreatesEpochKey_WhenOwnerCreates()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();

        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var recipient = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, recipient, "viewer", owner);

        var controller = new EpochKeysController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new EpochKeysController.CreateEpochKeyRequest(
            RecipientId: recipient.Id,
            EpochId: 1,
            EncryptedKeyBundle: new byte[32],
            OwnerSignature: new byte[64],
            SharerPubkey: new byte[32],
            SignPubkey: new byte[32]
        );

        // Act
        var result = await controller.Create(album.Id, request);

        // Assert
        Assert.IsType<CreatedResult>(result);
        Assert.Single(db.EpochKeys.Where(ek => ek.RecipientId == recipient.Id));
    }

    [Fact]
    public async Task Create_CreatesEpochKey_WhenEditorCreates()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();

        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var editor = await builder.CreateUserAsync("editor-user");
        var recipient = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, editor, "editor", owner);
        await builder.AddMemberAsync(album, recipient, "viewer", owner);

        var controller = new EpochKeysController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create("editor-user")
            }
        };

        var request = new EpochKeysController.CreateEpochKeyRequest(
            RecipientId: recipient.Id,
            EpochId: 1,
            EncryptedKeyBundle: new byte[32],
            OwnerSignature: new byte[64],
            SharerPubkey: new byte[32],
            SignPubkey: new byte[32]
        );

        // Act
        var result = await controller.Create(album.Id, request);

        // Assert
        Assert.IsType<CreatedResult>(result);
    }

    [Fact]
    public async Task Create_ReturnsForbid_WhenViewerTries()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();

        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var viewer = await builder.CreateUserAsync("viewer-user");
        var recipient = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, viewer, "viewer", owner);
        await builder.AddMemberAsync(album, recipient, "viewer", owner);

        var controller = new EpochKeysController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create("viewer-user")
            }
        };

        var request = new EpochKeysController.CreateEpochKeyRequest(
            RecipientId: recipient.Id,
            EpochId: 1,
            EncryptedKeyBundle: new byte[32],
            OwnerSignature: new byte[64],
            SharerPubkey: new byte[32],
            SignPubkey: new byte[32]
        );

        // Act
        var result = await controller.Create(album.Id, request);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Create_ReturnsNotFound_WhenRecipientNotExists()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();

        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new EpochKeysController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new EpochKeysController.CreateEpochKeyRequest(
            RecipientId: Guid.NewGuid(),
            EpochId: 1,
            EncryptedKeyBundle: new byte[32],
            OwnerSignature: new byte[64],
            SharerPubkey: new byte[32],
            SignPubkey: new byte[32]
        );

        // Act
        var result = await controller.Create(album.Id, request);

        // Assert
        ProblemDetailsAssertions.AssertNotFound(result);
    }

    [Fact]
    public async Task Create_ReturnsConflict_WhenEpochKeyExists()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();

        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var recipient = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, recipient, "viewer", owner);
        await builder.CreateEpochKeyAsync(album, recipient, epochId: 1);

        var controller = new EpochKeysController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new EpochKeysController.CreateEpochKeyRequest(
            RecipientId: recipient.Id,
            EpochId: 1, // Same epoch
            EncryptedKeyBundle: new byte[32],
            OwnerSignature: new byte[64],
            SharerPubkey: new byte[32],
            SignPubkey: new byte[32]
        );

        // Act
        var result = await controller.Create(album.Id, request);

        // Assert
        ProblemDetailsAssertions.AssertConflict(result);
    }

    [Fact]
    public async Task Get_ReturnsEpochKey_WhenRecipientRequests()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();

        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var epochKey = await builder.CreateEpochKeyAsync(album, owner, epochId: 1);

        var controller = new EpochKeysController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        // Act
        var result = await controller.Get(album.Id, epochKey.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);
    }

    [Fact]
    public async Task Get_ReturnsForbid_WhenNonRecipientRequests()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();

        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var member = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, member, "viewer", owner);
        var epochKey = await builder.CreateEpochKeyAsync(album, owner, epochId: 1);

        var controller = new EpochKeysController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(MemberAuthSub)
            }
        };

        // Act
        var result = await controller.Get(album.Id, epochKey.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Get_ReturnsNotFound_WhenKeyNotExists()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();

        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new EpochKeysController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        // Act
        var result = await controller.Get(album.Id, Guid.NewGuid());

        // Assert
        Assert.IsType<NotFoundResult>(result);
    }

    [Fact]
    public async Task Rotate_RotatesEpoch_WhenOwnerRotates()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();

        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var member = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentEpochId: 1);
        await builder.AddMemberAsync(album, member, "viewer", owner);

        var controller = new EpochKeysController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new EpochKeysController.RotateEpochRequest([
            new EpochKeysController.CreateEpochKeyRequest(
                RecipientId: owner.Id,
                EpochId: 2,
                EncryptedKeyBundle: new byte[32],
                OwnerSignature: new byte[64],
                SharerPubkey: new byte[32],
                SignPubkey: new byte[32]
            ),
            new EpochKeysController.CreateEpochKeyRequest(
                RecipientId: member.Id,
                EpochId: 2,
                EncryptedKeyBundle: new byte[32],
                OwnerSignature: new byte[64],
                SharerPubkey: new byte[32],
                SignPubkey: new byte[32]
            )
        ]);

        // Act
        var result = await controller.Rotate(album.Id, 2, request);

        // Assert
        Assert.IsType<CreatedResult>(result);

        // Verify album epoch was updated
        var updatedAlbum = db.Albums.First(a => a.Id == album.Id);
        Assert.Equal(2, updatedAlbum.CurrentEpochId);

        // Verify epoch keys were created
        Assert.Equal(2, db.EpochKeys.Count(ek => ek.EpochId == 2));
    }

    [Fact]
    public async Task Rotate_ReturnsForbid_WhenNonOwnerTries()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();

        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var editor = await builder.CreateUserAsync("editor-user");
        var album = await builder.CreateAlbumAsync(owner, currentEpochId: 1);
        await builder.AddMemberAsync(album, editor, "editor", owner);

        var controller = new EpochKeysController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create("editor-user")
            }
        };

        var request = new EpochKeysController.RotateEpochRequest([
            new EpochKeysController.CreateEpochKeyRequest(
                RecipientId: owner.Id,
                EpochId: 2,
                EncryptedKeyBundle: new byte[32],
                OwnerSignature: new byte[64],
                SharerPubkey: new byte[32],
                SignPubkey: new byte[32]
            )
        ]);

        // Act
        var result = await controller.Rotate(album.Id, 2, request);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Rotate_ReturnsBadRequest_WhenEpochNotGreater()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();

        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentEpochId: 5);

        var controller = new EpochKeysController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new EpochKeysController.RotateEpochRequest([
            new EpochKeysController.CreateEpochKeyRequest(
                RecipientId: owner.Id,
                EpochId: 3, // Less than current (5)
                EncryptedKeyBundle: new byte[32],
                OwnerSignature: new byte[64],
                SharerPubkey: new byte[32],
                SignPubkey: new byte[32]
            )
        ]);

        // Act
        var result = await controller.Rotate(album.Id, 3, request);

        // Assert
        ProblemDetailsAssertions.AssertBadRequest(result);
    }

    [Fact]
    public async Task Rotate_ReturnsBadRequest_WhenRecipientNotMember()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();

        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var nonMember = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentEpochId: 1);

        var controller = new EpochKeysController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new EpochKeysController.RotateEpochRequest([
            new EpochKeysController.CreateEpochKeyRequest(
                RecipientId: nonMember.Id, // Not a member
                EpochId: 2,
                EncryptedKeyBundle: new byte[32],
                OwnerSignature: new byte[64],
                SharerPubkey: new byte[32],
                SignPubkey: new byte[32]
            )
        ]);

        // Act
        var result = await controller.Rotate(album.Id, 2, request);

        // Assert
        ProblemDetailsAssertions.AssertBadRequest(result);
    }

    [Fact]
    public async Task Rotate_ReturnsNotFound_WhenAlbumNotExists()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();

        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);

        var controller = new EpochKeysController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new EpochKeysController.RotateEpochRequest([
            new EpochKeysController.CreateEpochKeyRequest(
                RecipientId: owner.Id,
                EpochId: 2,
                EncryptedKeyBundle: new byte[32],
                OwnerSignature: new byte[64],
                SharerPubkey: new byte[32],
                SignPubkey: new byte[32]
            )
        ]);

        // Act
        var result = await controller.Rotate(Guid.NewGuid(), 2, request);

        // Assert
        Assert.IsType<NotFoundResult>(result);
    }
}

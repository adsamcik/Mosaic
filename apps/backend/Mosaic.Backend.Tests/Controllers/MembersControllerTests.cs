using Microsoft.AspNetCore.Mvc;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Models.Members;
using Mosaic.Backend.Tests.Helpers;
using Xunit;
using Mosaic.Backend.Tests.TestHelpers;


namespace Mosaic.Backend.Tests.Controllers;

public class MembersControllerTests
{
    private const string OwnerAuthSub = "owner-user";
    private const string MemberAuthSub = "member-user";

    [Fact]
    public async Task List_ReturnsMembers_WhenUserHasAccess()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var member = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, member, "viewer", owner);

        var controller = new MembersController(db, config, new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<MembersController>())
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
        var members = Assert.IsAssignableFrom<IEnumerable<object>>(okResult.Value);
        Assert.Equal(2, members.Count()); // owner + member
    }

    [Fact]
    public async Task List_ReturnsForbid_WhenUserNotMember()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new MembersController(db, config, new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<MembersController>())
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
    public async Task Invite_AddsMember_WhenOwnerInvites()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var invitee = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new MembersController(db, config, new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<MembersController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new InviteRequest(
            RecipientId: invitee.Id,
            Role: "viewer",
            EpochKeys: [
                new EpochKeyCreate(
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

        // Assert
        var createdResult = Assert.IsType<CreatedResult>(result);
        Assert.NotNull(createdResult.Value);
        Assert.Equal(2, db.AlbumMembers.Count()); // owner + invitee
        Assert.Single(db.EpochKeys.Where(ek => ek.RecipientId == invitee.Id));
    }

    [Fact]
    public async Task Invite_ReturnsForbid_WhenEditorTriesToInvite()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var editor = await builder.CreateUserAsync("editor-user");
        var invitee = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, editor, "editor", owner);

        var controller = new MembersController(db, config, new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<MembersController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create("editor-user")
            }
        };

        var request = new InviteRequest(
            RecipientId: invitee.Id,
            Role: "viewer",
            EpochKeys: [
                new EpochKeyCreate(
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

        // Assert
        Assert.IsType<ForbidResult>(result);
        Assert.Equal(2, db.AlbumMembers.Count()); // owner + editor
        Assert.Empty(db.EpochKeys);
    }

    [Fact]
    public async Task Invite_ReturnsForbid_WhenViewerTries()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var viewer = await builder.CreateUserAsync("viewer-user");
        var invitee = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, viewer, "viewer", owner);

        var controller = new MembersController(db, config, new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<MembersController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create("viewer-user")
            }
        };

        var request = new InviteRequest(
            RecipientId: invitee.Id,
            Role: "viewer",
            EpochKeys: [
                new EpochKeyCreate(
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

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Invite_ReturnsForbid_WhenNonMemberTries()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var outsider = await builder.CreateUserAsync("outsider-user");
        var invitee = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new MembersController(db, config, new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<MembersController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create("outsider-user")
            }
        };

        var request = new InviteRequest(
            RecipientId: invitee.Id,
            Role: "viewer",
            EpochKeys: [
                new EpochKeyCreate(
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

        // Assert
        Assert.IsType<ForbidResult>(result);
        Assert.Single(db.AlbumMembers); // owner only
        Assert.Empty(db.EpochKeys);
    }

    [Fact]
    public async Task Invite_ReturnsBadRequest_WhenInvalidRole()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var invitee = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new MembersController(db, config, new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<MembersController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new InviteRequest(
            RecipientId: invitee.Id,
            Role: "admin", // Invalid role
            EpochKeys: [
                new EpochKeyCreate(
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

        // Assert
        ProblemDetailsAssertions.AssertBadRequest(result);
    }

    [Fact]
    public async Task Invite_ReturnsBadRequest_WhenNoEpochKeys()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var invitee = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new MembersController(db, config, new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<MembersController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new InviteRequest(
            RecipientId: invitee.Id,
            Role: "viewer",
            EpochKeys: []
        );

        // Act
        var result = await controller.Invite(album.Id, request);

        // Assert
        ProblemDetailsAssertions.AssertBadRequest(result);
    }

    [Fact]
    public async Task Invite_ReturnsNotFound_WhenRecipientNotExists()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new MembersController(db, config, new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<MembersController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new InviteRequest(
            RecipientId: Guid.NewGuid(),
            Role: "viewer",
            EpochKeys: [
                new EpochKeyCreate(
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

        // Assert
        ProblemDetailsAssertions.AssertNotFound(result);
    }

    [Fact]
    public async Task Invite_ReturnsConflict_WhenAlreadyMember()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var member = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, member, "viewer", owner);

        var controller = new MembersController(db, config, new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<MembersController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new InviteRequest(
            RecipientId: member.Id,
            Role: "editor",
            EpochKeys: [
                new EpochKeyCreate(
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

        // Assert
        ProblemDetailsAssertions.AssertConflict(result);
    }

    [Fact]
    public async Task Invite_ReactivatesMembership_WhenPreviouslyRevoked()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var member = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var membership = await builder.AddMemberAsync(album, member, "viewer", owner);
        membership.RevokedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();

        var controller = new MembersController(db, config, new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<MembersController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new InviteRequest(
            RecipientId: member.Id,
            Role: "editor",
            EpochKeys: [
                new EpochKeyCreate(
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

        // Assert
        Assert.IsType<CreatedResult>(result);
        var updatedMembership = db.AlbumMembers.First(m => m.UserId == member.Id);
        Assert.Null(updatedMembership.RevokedAt);
        Assert.Equal("editor", updatedMembership.Role);
    }

    [Fact]
    public async Task Invite_ReturnsBadRequest_WhenInvalidBase64()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var invitee = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new MembersController(db, config, new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<MembersController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        var request = new InviteRequest(
            RecipientId: invitee.Id,
            Role: "viewer",
            EpochKeys: [
                new EpochKeyCreate(
                    EpochId: 1,
                    EncryptedKeyBundle: "not-valid-base64!!!",
                    OwnerSignature: Convert.ToBase64String(new byte[64]),
                    SharerPubkey: Convert.ToBase64String(new byte[32]),
                    SignPubkey: Convert.ToBase64String(new byte[32])
                )
            ]
        );

        // Act
        var result = await controller.Invite(album.Id, request);

        // Assert
        ProblemDetailsAssertions.AssertBadRequest(result);
    }

    [Fact]
    public async Task Remove_RevokesMembership_WhenOwnerRemoves()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var member = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, member, "viewer", owner);

        var controller = new MembersController(db, config, new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<MembersController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        // Act
        var result = await controller.Remove(album.Id, member.Id);

        // Assert
        Assert.IsType<NoContentResult>(result);
        var membership = db.AlbumMembers.First(m => m.UserId == member.Id);
        Assert.NotNull(membership.RevokedAt);
    }

    [Fact]
    public async Task Remove_ReturnsForbid_WhenNonOwnerTries()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var editor = await builder.CreateUserAsync("editor-user");
        var member = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, editor, "editor", owner);
        await builder.AddMemberAsync(album, member, "viewer", owner);

        var controller = new MembersController(db, config, new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<MembersController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create("editor-user")
            }
        };

        // Act
        var result = await controller.Remove(album.Id, member.Id);

        // Assert â€” non-owners get 403
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Remove_ReturnsBadRequest_WhenRemovingOwner()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new MembersController(db, config, new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<MembersController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        // Act
        var result = await controller.Remove(album.Id, owner.Id);

        // Assert
        ProblemDetailsAssertions.AssertBadRequest(result);
    }

    [Fact]
    public async Task Remove_ReturnsNotFound_WhenMemberNotExists()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = new MembersController(db, config, new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<MembersController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        // Act
        var result = await controller.Remove(album.Id, Guid.NewGuid());

        // Assert
        Assert.IsType<NotFoundResult>(result);
    }

    [Fact]
    public async Task Remove_ReturnsNotFound_WhenAlbumNotExists()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);
        await builder.CreateUserAsync(OwnerAuthSub);

        var controller = new MembersController(db, config, new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<MembersController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        // Act
        var result = await controller.Remove(Guid.NewGuid(), Guid.NewGuid());

        // Assert
        Assert.IsType<NotFoundResult>(result);
    }
}

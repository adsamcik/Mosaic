using Mosaic.Backend.Tests.Helpers;

namespace Mosaic.Backend.Tests.Controllers;

public class AlbumsControllerTests
{
    #region List

    [Fact]
    public async Task List_NewUser_ReturnsEmptyList()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = TestControllerFactory.CreateController<AlbumsController>(db, authSub: "new-user");

        // Act
        var result = await controller.List();

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);
    }

    [Fact]
    public async Task List_UserWithAlbums_ReturnsOwnedAndSharedAlbums()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        
        var owner = TestDataFactory.CreateUser("owner");
        var member = TestDataFactory.CreateUser("member");
        db.Users.AddRange(owner, member);
        
        var ownedAlbum = TestDataFactory.CreateAlbum(owner);
        var sharedAlbum = TestDataFactory.CreateAlbum(owner);
        db.Albums.AddRange(ownedAlbum, sharedAlbum);
        
        // Owner membership
        db.AlbumMembers.Add(TestDataFactory.CreateMember(ownedAlbum, owner, "owner"));
        db.AlbumMembers.Add(TestDataFactory.CreateMember(sharedAlbum, owner, "owner"));
        
        // Shared with member
        db.AlbumMembers.Add(TestDataFactory.CreateMember(sharedAlbum, member, "viewer"));
        
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<AlbumsController>(db, authSub: "member");

        // Act
        var result = await controller.List();

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);
    }

    [Fact]
    public async Task List_RevokedMembership_NotIncluded()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        
        var owner = TestDataFactory.CreateUser("owner");
        var member = TestDataFactory.CreateUser("member");
        db.Users.AddRange(owner, member);
        
        var album = TestDataFactory.CreateAlbum(owner);
        db.Albums.Add(album);
        
        db.AlbumMembers.Add(TestDataFactory.CreateMember(album, owner, "owner"));
        var revokedMembership = TestDataFactory.CreateMember(album, member, "viewer");
        revokedMembership.RevokedAt = DateTime.UtcNow;
        db.AlbumMembers.Add(revokedMembership);
        
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<AlbumsController>(db, authSub: "member");

        // Act
        var result = await controller.List();

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var albums = okResult.Value as System.Collections.IEnumerable;
        Assert.NotNull(albums);
        Assert.Empty(albums.Cast<object>());
    }

    #endregion

    #region Create

    [Fact]
    public async Task Create_ValidRequest_CreatesAlbumWithMemberAndEpochKey()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = TestControllerFactory.CreateController<AlbumsController>(db, authSub: "creator");

        var request = new CreateAlbumRequest
        {
            InitialEpochKey = new InitialEpochKeyRequest
            {
                EncryptedKeyBundle = new byte[64],
                OwnerSignature = new byte[64],
                SharerPubkey = new byte[32],
                SignPubkey = new byte[32]
            }
        };

        // Act
        var result = await controller.Create(request);

        // Assert
        var createdResult = Assert.IsType<CreatedResult>(result);
        
        // Verify album was created
        var album = await db.Albums.FirstOrDefaultAsync();
        Assert.NotNull(album);
        Assert.Equal(1, album.CurrentEpochId);
        Assert.Equal(1, album.CurrentVersion);
        
        // Verify owner membership
        var membership = await db.AlbumMembers.FirstOrDefaultAsync();
        Assert.NotNull(membership);
        Assert.Equal("owner", membership.Role);
        
        // Verify epoch key
        var epochKey = await db.EpochKeys.FirstOrDefaultAsync();
        Assert.NotNull(epochKey);
        Assert.Equal(1, epochKey.EpochId);
    }

    [Fact]
    public async Task Create_NullInitialEpochKey_ReturnsBadRequest()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = TestControllerFactory.CreateController<AlbumsController>(db, authSub: "creator");

        var request = new CreateAlbumRequest
        {
            InitialEpochKey = null!
        };

        // Act
        var result = await controller.Create(request);

        // Assert
        Assert.IsType<BadRequestObjectResult>(result);
    }

    [Fact]
    public async Task Create_EmptyEncryptedKeyBundle_ReturnsBadRequest()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = TestControllerFactory.CreateController<AlbumsController>(db, authSub: "creator");

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
        var badRequest = Assert.IsType<BadRequestObjectResult>(result);
        Assert.Contains("encryptedKeyBundle", badRequest.Value?.ToString() ?? "");
    }

    [Fact]
    public async Task Create_EmptyOwnerSignature_ReturnsBadRequest()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = TestControllerFactory.CreateController<AlbumsController>(db, authSub: "creator");

        var request = new CreateAlbumRequest
        {
            InitialEpochKey = new InitialEpochKeyRequest
            {
                EncryptedKeyBundle = new byte[64],
                OwnerSignature = Array.Empty<byte>(),
                SharerPubkey = new byte[32],
                SignPubkey = new byte[32]
            }
        };

        // Act
        var result = await controller.Create(request);

        // Assert
        var badRequest = Assert.IsType<BadRequestObjectResult>(result);
        Assert.Contains("ownerSignature", badRequest.Value?.ToString() ?? "");
    }

    [Fact]
    public async Task Create_EmptySharerPubkey_ReturnsBadRequest()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = TestControllerFactory.CreateController<AlbumsController>(db, authSub: "creator");

        var request = new CreateAlbumRequest
        {
            InitialEpochKey = new InitialEpochKeyRequest
            {
                EncryptedKeyBundle = new byte[64],
                OwnerSignature = new byte[64],
                SharerPubkey = Array.Empty<byte>(),
                SignPubkey = new byte[32]
            }
        };

        // Act
        var result = await controller.Create(request);

        // Assert
        var badRequest = Assert.IsType<BadRequestObjectResult>(result);
        Assert.Contains("sharerPubkey", badRequest.Value?.ToString() ?? "");
    }

    [Fact]
    public async Task Create_EmptySignPubkey_ReturnsBadRequest()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = TestControllerFactory.CreateController<AlbumsController>(db, authSub: "creator");

        var request = new CreateAlbumRequest
        {
            InitialEpochKey = new InitialEpochKeyRequest
            {
                EncryptedKeyBundle = new byte[64],
                OwnerSignature = new byte[64],
                SharerPubkey = new byte[32],
                SignPubkey = Array.Empty<byte>()
            }
        };

        // Act
        var result = await controller.Create(request);

        // Assert
        var badRequest = Assert.IsType<BadRequestObjectResult>(result);
        Assert.Contains("signPubkey", badRequest.Value?.ToString() ?? "");
    }

    #endregion

    #region Get

    [Fact]
    public async Task Get_AsMember_ReturnsAlbum()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        
        var owner = TestDataFactory.CreateUser("owner");
        var member = TestDataFactory.CreateUser("member");
        db.Users.AddRange(owner, member);
        
        var album = TestDataFactory.CreateAlbum(owner);
        db.Albums.Add(album);
        
        db.AlbumMembers.Add(TestDataFactory.CreateMember(album, owner, "owner"));
        db.AlbumMembers.Add(TestDataFactory.CreateMember(album, member, "viewer"));
        
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<AlbumsController>(db, authSub: "member");

        // Act
        var result = await controller.Get(album.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);
    }

    [Fact]
    public async Task Get_NotMember_ReturnsForbid()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        
        var owner = TestDataFactory.CreateUser("owner");
        var stranger = TestDataFactory.CreateUser("stranger");
        db.Users.AddRange(owner, stranger);
        
        var album = TestDataFactory.CreateAlbum(owner);
        db.Albums.Add(album);
        
        db.AlbumMembers.Add(TestDataFactory.CreateMember(album, owner, "owner"));
        
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<AlbumsController>(db, authSub: "stranger");

        // Act
        var result = await controller.Get(album.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Get_RevokedMember_ReturnsForbid()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        
        var owner = TestDataFactory.CreateUser("owner");
        var revokedMember = TestDataFactory.CreateUser("revoked");
        db.Users.AddRange(owner, revokedMember);
        
        var album = TestDataFactory.CreateAlbum(owner);
        db.Albums.Add(album);
        
        db.AlbumMembers.Add(TestDataFactory.CreateMember(album, owner, "owner"));
        var revokedMembership = TestDataFactory.CreateMember(album, revokedMember, "viewer");
        revokedMembership.RevokedAt = DateTime.UtcNow;
        db.AlbumMembers.Add(revokedMembership);
        
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<AlbumsController>(db, authSub: "revoked");

        // Act
        var result = await controller.Get(album.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Get_NonExistentAlbum_ReturnsNotFound()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        
        var user = TestDataFactory.CreateUser("user");
        db.Users.Add(user);
        
        // Create a membership for a different album
        var album = TestDataFactory.CreateAlbum(user);
        db.Albums.Add(album);
        db.AlbumMembers.Add(TestDataFactory.CreateMember(album, user, "owner"));
        
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<AlbumsController>(db, authSub: "user");

        // Act - Request different album
        var result = await controller.Get(Guid.NewGuid());

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    #endregion

    #region Sync

    [Fact]
    public async Task Sync_AsMember_ReturnsManifests()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        
        var owner = TestDataFactory.CreateUser("owner");
        db.Users.Add(owner);
        
        var album = TestDataFactory.CreateAlbum(owner);
        album.CurrentVersion = 5;
        db.Albums.Add(album);
        
        db.AlbumMembers.Add(TestDataFactory.CreateMember(album, owner, "owner"));
        
        // Create manifests at different versions
        for (int i = 1; i <= 5; i++)
        {
            db.Manifests.Add(new Manifest
            {
                Id = Guid.NewGuid(),
                AlbumId = album.Id,
                VersionCreated = i,
                EncryptedMeta = new byte[64],
                Signature = "sig",
                SignerPubkey = "pubkey"
            });
        }
        
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<AlbumsController>(db, authSub: "owner");

        // Act - Get manifests since version 2
        var result = await controller.Sync(album.Id, 2);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);
    }

    [Fact]
    public async Task Sync_NotMember_ReturnsForbid()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        
        var owner = TestDataFactory.CreateUser("owner");
        var stranger = TestDataFactory.CreateUser("stranger");
        db.Users.AddRange(owner, stranger);
        
        var album = TestDataFactory.CreateAlbum(owner);
        db.Albums.Add(album);
        
        db.AlbumMembers.Add(TestDataFactory.CreateMember(album, owner, "owner"));
        
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<AlbumsController>(db, authSub: "stranger");

        // Act
        var result = await controller.Sync(album.Id, 0);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    #endregion

    #region Delete

    [Fact]
    public async Task Delete_AsOwner_DeletesAlbum()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        
        var owner = TestDataFactory.CreateUser("owner");
        db.Users.Add(owner);
        
        var album = TestDataFactory.CreateAlbum(owner);
        db.Albums.Add(album);
        
        db.AlbumMembers.Add(TestDataFactory.CreateMember(album, owner, "owner"));
        
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<AlbumsController>(db, authSub: "owner");

        // Act
        var result = await controller.Delete(album.Id);

        // Assert
        Assert.IsType<NoContentResult>(result);
        Assert.Null(await db.Albums.FindAsync(album.Id));
    }

    [Fact]
    public async Task Delete_NotOwner_ReturnsForbid()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        
        var owner = TestDataFactory.CreateUser("owner");
        var editor = TestDataFactory.CreateUser("editor");
        db.Users.AddRange(owner, editor);
        
        var album = TestDataFactory.CreateAlbum(owner);
        db.Albums.Add(album);
        
        db.AlbumMembers.Add(TestDataFactory.CreateMember(album, owner, "owner"));
        db.AlbumMembers.Add(TestDataFactory.CreateMember(album, editor, "editor"));
        
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<AlbumsController>(db, authSub: "editor");

        // Act
        var result = await controller.Delete(album.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
        Assert.NotNull(await db.Albums.FindAsync(album.Id));
    }

    [Fact]
    public async Task Delete_NonExistentAlbum_ReturnsNotFound()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = TestControllerFactory.CreateController<AlbumsController>(db, authSub: "user");

        // Act
        var result = await controller.Delete(Guid.NewGuid());

        // Assert
        Assert.IsType<NotFoundResult>(result);
    }

    #endregion
}

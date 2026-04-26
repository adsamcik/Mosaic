using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using System.Text;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Models.Albums;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Tests.Helpers;
using Mosaic.Backend.Tests.TestHelpers;
using Xunit;

namespace Mosaic.Backend.Tests.Controllers;

public class AlbumContentControllerTests
{
    private const string TestAuthSub = "test-user-123";

    [Fact]
    public async Task PutContent_StoresAndReturnsEncryptedContentAsOpaqueBytes()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);

        var encryptedContent = Encoding.UTF8.GetBytes("{\"blocks\":[{\"type\":\"not-plaintext\"}]}");
        var nonce = Enumerable.Range(0, 24).Select(value => (byte)(value + 1)).ToArray();
        var controller = CreateController(db);
        var request = new UpdateAlbumContentRequest
        {
            EncryptedContent = encryptedContent,
            Nonce = nonce,
            EpochId = 7,
            ExpectedVersion = 0
        };

        // Act
        var putResult = await controller.PutContent(album.Id, request);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(putResult);
        var response = Assert.IsType<AlbumContentResponse>(okResult.Value);
        Assert.Equal(encryptedContent, response.EncryptedContent);
        Assert.Equal(nonce, response.Nonce);
        Assert.Equal(7, response.EpochId);

        var getResult = await controller.GetContent(album.Id);
        var getOkResult = Assert.IsType<OkObjectResult>(getResult);
        var getResponse = Assert.IsType<AlbumContentResponse>(getOkResult.Value);
        Assert.Equal(encryptedContent, getResponse.EncryptedContent);
        Assert.Equal(nonce, getResponse.Nonce);

        var persisted = await db.AlbumContents.SingleAsync(content => content.AlbumId == album.Id);
        Assert.Equal(encryptedContent, persisted.EncryptedContent);
        Assert.Equal(nonce, persisted.Nonce);
    }

    [Fact]
    public async Task PutContent_AcceptsMalformedCiphertextWhenNonceLengthIsValid()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);

        var malformedCiphertext = new byte[] { 0xff, 0xfe, 0x00, 0x13, 0x37 };
        var controller = CreateController(db);
        var request = new UpdateAlbumContentRequest
        {
            EncryptedContent = malformedCiphertext,
            Nonce = new byte[24],
            EpochId = 1,
            ExpectedVersion = 0
        };

        // Act
        var result = await controller.PutContent(album.Id, request);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var response = Assert.IsType<AlbumContentResponse>(okResult.Value);
        Assert.Equal(malformedCiphertext, response.EncryptedContent);
    }

    [Fact]
    public async Task GetContent_ReturnsNotFound_WhenAlbumDoesNotExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = CreateController(db);

        // Act
        var result = await controller.GetContent(Guid.NewGuid());

        // Assert
        Assert.IsType<NotFoundResult>(result);
    }

    [Fact]
    public async Task GetContent_ReturnsNotFound_WhenContentDoesNotExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);

        var controller = CreateController(db);

        // Act
        var result = await controller.GetContent(album.Id);

        // Assert
        Assert.IsType<NotFoundResult>(result);
    }

    [Fact]
    public async Task GetContent_ReturnsForbidden_WhenUserNotMember()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync("other-user");
        var album = await builder.CreateAlbumAsync(owner);

        // Add content for this album
        var content = new AlbumContent
        {
            AlbumId = album.Id,
            EncryptedContent = new byte[] { 1, 2, 3 },
            Nonce = new byte[24],
            EpochId = 1,
            Version = 1
        };
        db.AlbumContents.Add(content);
        await db.SaveChangesAsync();

        var controller = CreateController(db);

        // Act
        var result = await controller.GetContent(album.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task GetContent_ReturnsContent_WhenUserIsOwner()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);

        var encryptedContent = new byte[] { 1, 2, 3, 4, 5 };
        var nonce = new byte[24];
        for (int i = 0; i < 24; i++) nonce[i] = (byte)i;

        var content = new AlbumContent
        {
            AlbumId = album.Id,
            EncryptedContent = encryptedContent,
            Nonce = nonce,
            EpochId = 1,
            Version = 1
        };
        db.AlbumContents.Add(content);
        await db.SaveChangesAsync();

        var controller = CreateController(db);

        // Act
        var result = await controller.GetContent(album.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var response = Assert.IsType<AlbumContentResponse>(okResult.Value);
        Assert.Equal(encryptedContent, response.EncryptedContent);
        Assert.Equal(nonce, response.Nonce);
        Assert.Equal(1, response.EpochId);
        Assert.Equal(1, response.Version);
    }

    [Fact]
    public async Task GetContent_ReturnsContent_WhenUserIsMember()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync("owner-user");
        var member = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, member, "viewer", owner);

        var content = new AlbumContent
        {
            AlbumId = album.Id,
            EncryptedContent = new byte[] { 1, 2, 3 },
            Nonce = new byte[24],
            EpochId = 1,
            Version = 1
        };
        db.AlbumContents.Add(content);
        await db.SaveChangesAsync();

        var controller = CreateController(db);

        // Act
        var result = await controller.GetContent(album.Id);

        // Assert
        Assert.IsType<OkObjectResult>(result);
    }

    [Fact]
    public async Task PutContent_CreatesContent_WhenNoneExists()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);

        var controller = CreateController(db);
        var request = new UpdateAlbumContentRequest
        {
            EncryptedContent = new byte[] { 10, 20, 30 },
            Nonce = new byte[24],
            EpochId = 1,
            ExpectedVersion = 0 // New content
        };

        // Act
        var result = await controller.PutContent(album.Id, request);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var response = Assert.IsType<AlbumContentResponse>(okResult.Value);
        Assert.Equal(1, response.Version);
        Assert.Equal(request.EncryptedContent, response.EncryptedContent);

        // Verify in database
        var saved = await db.AlbumContents.FindAsync(album.Id);
        Assert.NotNull(saved);
        Assert.Equal(1, saved.Version);
    }

    [Fact]
    public async Task PutContent_UpdatesContent_WithCorrectVersion()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);

        var existing = new AlbumContent
        {
            AlbumId = album.Id,
            EncryptedContent = new byte[] { 1, 2, 3 },
            Nonce = new byte[24],
            EpochId = 1,
            Version = 1
        };
        db.AlbumContents.Add(existing);
        await db.SaveChangesAsync();

        var controller = CreateController(db);
        var request = new UpdateAlbumContentRequest
        {
            EncryptedContent = new byte[] { 4, 5, 6 },
            Nonce = new byte[24],
            EpochId = 1,
            ExpectedVersion = 1
        };

        // Act
        var result = await controller.PutContent(album.Id, request);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var response = Assert.IsType<AlbumContentResponse>(okResult.Value);
        Assert.Equal(2, response.Version); // Version incremented
        Assert.Equal(request.EncryptedContent, response.EncryptedContent);
    }

    [Fact]
    public async Task PutContent_ReturnsConflict_WhenVersionMismatch()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);

        var existing = new AlbumContent
        {
            AlbumId = album.Id,
            EncryptedContent = new byte[] { 1, 2, 3 },
            Nonce = new byte[24],
            EpochId = 1,
            Version = 5 // Current version is 5
        };
        db.AlbumContents.Add(existing);
        await db.SaveChangesAsync();

        var controller = CreateController(db);
        var request = new UpdateAlbumContentRequest
        {
            EncryptedContent = new byte[] { 4, 5, 6 },
            Nonce = new byte[24],
            EpochId = 1,
            ExpectedVersion = 3 // Client thinks it's version 3
        };

        // Act
        var result = await controller.PutContent(album.Id, request);

        // Assert
        var conflictResult = Assert.IsType<ConflictObjectResult>(result);
        Assert.Contains("version", conflictResult.Value?.ToString()?.ToLower() ?? "");
    }

    [Fact]
    public async Task PutContent_ReturnsForbidden_WhenUserNotOwner()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync("owner-user");
        var member = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, member, "viewer", owner);

        var controller = CreateController(db);
        var request = new UpdateAlbumContentRequest
        {
            EncryptedContent = new byte[] { 1, 2, 3 },
            Nonce = new byte[24],
            EpochId = 1,
            ExpectedVersion = 0
        };

        // Act
        var result = await controller.PutContent(album.Id, request);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task PutContent_AllowsEditor_ToUpdate()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync("owner-user");
        var editor = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, editor, "editor", owner);

        var controller = CreateController(db);
        var request = new UpdateAlbumContentRequest
        {
            EncryptedContent = new byte[] { 1, 2, 3 },
            Nonce = new byte[24],
            EpochId = 1,
            ExpectedVersion = 0
        };

        // Act
        var result = await controller.PutContent(album.Id, request);

        // Assert
        Assert.IsType<OkObjectResult>(result);
    }

    [Fact]
    public async Task PutContent_ReturnsNotFound_WhenAlbumDoesNotExist()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = CreateController(db);
        var request = new UpdateAlbumContentRequest
        {
            EncryptedContent = new byte[] { 1, 2, 3 },
            Nonce = new byte[24],
            EpochId = 1,
            ExpectedVersion = 0
        };

        // Act
        var result = await controller.PutContent(Guid.NewGuid(), request);

        // Assert
        Assert.IsType<NotFoundResult>(result);
    }

    [Fact]
    public async Task PutContent_ValidatesNonceLength()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var user = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(user);

        var controller = CreateController(db);
        var request = new UpdateAlbumContentRequest
        {
            EncryptedContent = new byte[] { 1, 2, 3 },
            Nonce = new byte[16], // Wrong length - should be 24
            EpochId = 1,
            ExpectedVersion = 0
        };

        // Act
        var result = await controller.PutContent(album.Id, request);

        // Assert
        Assert.IsType<BadRequestObjectResult>(result);
    }

    private AlbumContentController CreateController(MosaicDbContext db)
    {
        return new AlbumContentController(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };
    }
}

using Mosaic.Backend.Tests.Helpers;

namespace Mosaic.Backend.Tests.Controllers;

public class UsersControllerTests
{
    [Fact]
    public async Task GetMe_NewUser_CreatesUserAndReturnsProfile()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = TestControllerFactory.CreateController<UsersController>(db, authSub: "new-user");

        // Act
        var result = await controller.GetMe();

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);

        // Verify user was created in database
        var user = await db.Users.FirstOrDefaultAsync(u => u.AuthSub == "new-user");
        Assert.NotNull(user);
        
        // Verify quota was created
        var quota = await db.UserQuotas.FirstOrDefaultAsync(q => q.UserId == user.Id);
        Assert.NotNull(quota);
        Assert.Equal(10737418240, quota.MaxStorageBytes);
    }

    [Fact]
    public async Task GetMe_ExistingUser_ReturnsProfile()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var existingUser = TestDataFactory.CreateUser("existing-user");
        existingUser.EncryptedSalt = new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 };
        existingUser.SaltNonce = new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 };
        db.Users.Add(existingUser);
        db.UserQuotas.Add(TestDataFactory.CreateQuota(existingUser, usedBytes: 5000));
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<UsersController>(db, authSub: "existing-user");

        // Act
        var result = await controller.GetMe();

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);
        
        // Ensure only one user exists (no duplicate created)
        Assert.Equal(1, await db.Users.CountAsync());
    }

    [Fact]
    public async Task UpdateMe_SetIdentityPubkey_Success()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var user = TestDataFactory.CreateUser("test-user");
        user.IdentityPubkey = ""; // Not set yet
        db.Users.Add(user);
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<UsersController>(db, authSub: "test-user");
        var newPubkey = Convert.ToBase64String(new byte[32]);
        var request = new UsersController.UpdateUserRequest(IdentityPubkey: newPubkey);

        // Act
        var result = await controller.UpdateMe(request);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        
        var updatedUser = await db.Users.FirstAsync(u => u.AuthSub == "test-user");
        Assert.Equal(newPubkey, updatedUser.IdentityPubkey);
    }

    [Fact]
    public async Task UpdateMe_ChangeExistingIdentityPubkey_ReturnsBadRequest()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var user = TestDataFactory.CreateUser("test-user");
        user.IdentityPubkey = Convert.ToBase64String(new byte[32]); // Already set
        db.Users.Add(user);
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<UsersController>(db, authSub: "test-user");
        var differentPubkey = Convert.ToBase64String(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32 });
        var request = new UsersController.UpdateUserRequest(IdentityPubkey: differentPubkey);

        // Act
        var result = await controller.UpdateMe(request);

        // Assert
        var badRequest = Assert.IsType<BadRequestObjectResult>(result);
        Assert.Contains("already set", badRequest.Value?.ToString()?.ToLower() ?? "");
    }

    [Fact]
    public async Task UpdateMe_SetSameIdentityPubkey_Success()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var user = TestDataFactory.CreateUser("test-user");
        var pubkey = Convert.ToBase64String(new byte[32]);
        user.IdentityPubkey = pubkey;
        db.Users.Add(user);
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<UsersController>(db, authSub: "test-user");
        var request = new UsersController.UpdateUserRequest(IdentityPubkey: pubkey); // Same value

        // Act
        var result = await controller.UpdateMe(request);

        // Assert
        Assert.IsType<OkObjectResult>(result);
    }

    [Fact]
    public async Task UpdateMe_SetEncryptedSalt_Success()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var user = TestDataFactory.CreateUser("test-user");
        db.Users.Add(user);
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<UsersController>(db, authSub: "test-user");
        var encryptedSalt = Convert.ToBase64String(new byte[32]); // 16 bytes + 16 bytes auth tag
        var saltNonce = Convert.ToBase64String(new byte[12]); // 12 bytes for AES-GCM
        var request = new UsersController.UpdateUserRequest(EncryptedSalt: encryptedSalt, SaltNonce: saltNonce);

        // Act
        var result = await controller.UpdateMe(request);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        
        var updatedUser = await db.Users.FirstAsync(u => u.AuthSub == "test-user");
        Assert.NotNull(updatedUser.EncryptedSalt);
        Assert.NotNull(updatedUser.SaltNonce);
        Assert.Equal(32, updatedUser.EncryptedSalt.Length);
        Assert.Equal(12, updatedUser.SaltNonce.Length);
    }

    [Fact]
    public async Task UpdateMe_OnlySaltWithoutNonce_ReturnsBadRequest()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var user = TestDataFactory.CreateUser("test-user");
        db.Users.Add(user);
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<UsersController>(db, authSub: "test-user");
        var request = new UsersController.UpdateUserRequest(
            EncryptedSalt: Convert.ToBase64String(new byte[32]),
            SaltNonce: null
        );

        // Act
        var result = await controller.UpdateMe(request);

        // Assert
        var badRequest = Assert.IsType<BadRequestObjectResult>(result);
        Assert.Contains("both", badRequest.Value?.ToString()?.ToLower() ?? "");
    }

    [Fact]
    public async Task UpdateMe_OnlyNonceWithoutSalt_ReturnsBadRequest()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var user = TestDataFactory.CreateUser("test-user");
        db.Users.Add(user);
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<UsersController>(db, authSub: "test-user");
        var request = new UsersController.UpdateUserRequest(
            EncryptedSalt: null,
            SaltNonce: Convert.ToBase64String(new byte[12])
        );

        // Act
        var result = await controller.UpdateMe(request);

        // Assert
        var badRequest = Assert.IsType<BadRequestObjectResult>(result);
        Assert.Contains("both", badRequest.Value?.ToString()?.ToLower() ?? "");
    }

    [Fact]
    public async Task UpdateMe_InvalidNonceLength_ReturnsBadRequest()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var user = TestDataFactory.CreateUser("test-user");
        db.Users.Add(user);
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<UsersController>(db, authSub: "test-user");
        var request = new UsersController.UpdateUserRequest(
            EncryptedSalt: Convert.ToBase64String(new byte[32]),
            SaltNonce: Convert.ToBase64String(new byte[16]) // Wrong length (should be 12)
        );

        // Act
        var result = await controller.UpdateMe(request);

        // Assert
        var badRequest = Assert.IsType<BadRequestObjectResult>(result);
        Assert.Contains("nonce", badRequest.Value?.ToString()?.ToLower() ?? "");
    }

    [Fact]
    public async Task UpdateMe_InvalidBase64Salt_ReturnsBadRequest()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var user = TestDataFactory.CreateUser("test-user");
        db.Users.Add(user);
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<UsersController>(db, authSub: "test-user");
        var request = new UsersController.UpdateUserRequest(
            EncryptedSalt: "not-valid-base64!!!",
            SaltNonce: Convert.ToBase64String(new byte[12])
        );

        // Act
        var result = await controller.UpdateMe(request);

        // Assert
        var badRequest = Assert.IsType<BadRequestObjectResult>(result);
        Assert.Contains("base64", badRequest.Value?.ToString()?.ToLower() ?? "");
    }

    [Fact]
    public async Task UpdateMe_TooShortEncryptedSalt_ReturnsBadRequest()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var user = TestDataFactory.CreateUser("test-user");
        db.Users.Add(user);
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<UsersController>(db, authSub: "test-user");
        var request = new UsersController.UpdateUserRequest(
            EncryptedSalt: Convert.ToBase64String(new byte[10]), // Too short
            SaltNonce: Convert.ToBase64String(new byte[12])
        );

        // Act
        var result = await controller.UpdateMe(request);

        // Assert
        var badRequest = Assert.IsType<BadRequestObjectResult>(result);
        Assert.Contains("salt", badRequest.Value?.ToString()?.ToLower() ?? "");
    }

    [Fact]
    public async Task GetUser_ExistingUser_ReturnsPublicInfo()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var targetUser = TestDataFactory.CreateUser("target-user");
        db.Users.Add(targetUser);
        
        var requester = TestDataFactory.CreateUser("requester");
        db.Users.Add(requester);
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<UsersController>(db, authSub: "requester");

        // Act
        var result = await controller.GetUser(targetUser.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);
    }

    [Fact]
    public async Task GetUser_NonExistentUser_ReturnsNotFound()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var requester = TestDataFactory.CreateUser("requester");
        db.Users.Add(requester);
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<UsersController>(db, authSub: "requester");

        // Act
        var result = await controller.GetUser(Guid.NewGuid());

        // Assert
        Assert.IsType<NotFoundObjectResult>(result);
    }

    [Fact]
    public async Task GetUserByPubkey_ExistingPubkey_ReturnsUser()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var targetPubkey = Convert.ToBase64String(TestDataFactory.RandomBytes(32));
        var targetUser = TestDataFactory.CreateUser("target-user", targetPubkey);
        db.Users.Add(targetUser);
        
        var requester = TestDataFactory.CreateUser("requester");
        db.Users.Add(requester);
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<UsersController>(db, authSub: "requester");

        // Act
        var result = await controller.GetUserByPubkey(targetPubkey);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);
    }

    [Fact]
    public async Task GetUserByPubkey_NonExistentPubkey_ReturnsNotFound()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var requester = TestDataFactory.CreateUser("requester");
        db.Users.Add(requester);
        await db.SaveChangesAsync();

        var controller = TestControllerFactory.CreateController<UsersController>(db, authSub: "requester");

        // Act
        var result = await controller.GetUserByPubkey("nonexistent-pubkey");

        // Assert
        Assert.IsType<NotFoundObjectResult>(result);
    }
}

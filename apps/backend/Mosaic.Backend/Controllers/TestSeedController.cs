using System.Security.Cryptography;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;

namespace Mosaic.Backend.Controllers;

/// <summary>
/// E2E test seeding controller for managing test users and data.
/// This controller is ONLY available when ASPNETCORE_ENVIRONMENT is "Development" or "Testing".
/// All endpoints are unauthenticated for test automation purposes.
/// </summary>
[ApiController]
[Route("api/test-seed")]
public class TestSeedController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IWebHostEnvironment _env;
    private readonly IConfiguration _config;
    private readonly ILogger<TestSeedController> _logger;

    /// <summary>
    /// Email suffix used to identify E2E test users.
    /// Users with emails ending in this suffix can be safely deleted during test cleanup.
    /// </summary>
    private const string E2EEmailSuffix = "@e2e.local";

    /// <summary>
    /// Pool user email for ProxyAuth tests.
    /// </summary>
    private const string PoolProxyEmail = "pool-proxy@e2e.local";

    /// <summary>
    /// Pool user email for LocalAuth tests.
    /// </summary>
    private const string PoolLocalEmail = "pool-local@e2e.local";

    public TestSeedController(
        MosaicDbContext db,
        IWebHostEnvironment env,
        IConfiguration config,
        ILogger<TestSeedController> logger)
    {
        _db = db;
        _env = env;
        _config = config;
        _logger = logger;
    }

    /// <summary>
    /// Checks if the current environment allows test seeding operations.
    /// </summary>
    private bool IsTestEnvironment()
    {
        return _env.IsDevelopment() || _env.IsEnvironment("Testing");
    }

    /// <summary>
    /// Resets the test database by deleting all E2E test users.
    /// Cascade deletes their albums, memberships, epochs, shards, etc.
    /// </summary>
    /// <returns>Count of deleted users.</returns>
    /// <response code="200">Returns the count of deleted users.</response>
    /// <response code="404">Environment is not Development or Testing.</response>
    [HttpPost("reset")]
    [ProducesResponseType(typeof(ResetResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Reset()
    {
        if (!IsTestEnvironment())
        {
            return NotFound();
        }

        _logger.LogInformation("Resetting E2E test users with suffix {Suffix}", E2EEmailSuffix);

        // Find all E2E test users
        var e2eUsers = await _db.Users
            .Where(u => u.AuthSub.EndsWith(E2EEmailSuffix))
            .ToListAsync();

        var deletedCount = e2eUsers.Count;

        if (deletedCount > 0)
        {
            // Delete users - cascade will handle albums, memberships, epochs, etc.
            _db.Users.RemoveRange(e2eUsers);
            await _db.SaveChangesAsync();

            _logger.LogInformation("Deleted {Count} E2E test users", deletedCount);
        }

        return Ok(new ResetResponse(deletedCount));
    }

    /// <summary>
    /// Ensures the pool users exist for E2E tests.
    /// Creates exactly 2 users if they don't exist:
    /// - pool-proxy@e2e.local for ProxyAuth tests
    /// - pool-local@e2e.local for LocalAuth tests
    /// </summary>
    /// <returns>List of pool user emails.</returns>
    /// <response code="200">Returns the pool user emails.</response>
    /// <response code="404">Environment is not Development or Testing.</response>
    [HttpPost("ensure-pool")]
    [ProducesResponseType(typeof(EnsurePoolResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> EnsurePool()
    {
        if (!IsTestEnvironment())
        {
            return NotFound();
        }

        _logger.LogInformation("Ensuring E2E pool users exist");

        var createdUsers = new List<string>();
        var existingUsers = new List<string>();

        // Ensure pool-proxy user (for ProxyAuth tests)
        var proxyResult = await EnsurePoolUser(PoolProxyEmail, "proxy");
        if (proxyResult.WasCreated)
        {
            createdUsers.Add(PoolProxyEmail);
        }
        else
        {
            existingUsers.Add(PoolProxyEmail);
        }

        // Ensure pool-local user (for LocalAuth tests)
        var localResult = await EnsurePoolUser(PoolLocalEmail, "local");
        if (localResult.WasCreated)
        {
            createdUsers.Add(PoolLocalEmail);
        }
        else
        {
            existingUsers.Add(PoolLocalEmail);
        }

        return Ok(new EnsurePoolResponse(
            [PoolProxyEmail, PoolLocalEmail],
            createdUsers,
            existingUsers
        ));
    }

    /// <summary>
    /// Creates a single user on-demand for E2E tests.
    /// </summary>
    /// <param name="request">The user creation request.</param>
    /// <returns>The created user information.</returns>
    /// <response code="200">Returns the created user information.</response>
    /// <response code="400">Email does not end with @e2e.local or is invalid.</response>
    /// <response code="404">Environment is not Development or Testing.</response>
    /// <response code="409">User with this email already exists.</response>
    [HttpPost("create-user")]
    [ProducesResponseType(typeof(CreateUserResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<IActionResult> CreateUser(
        [FromBody] CreateUserRequest request)
    {
        if (!IsTestEnvironment())
        {
            return NotFound();
        }

        // Validate email format
        if (string.IsNullOrWhiteSpace(request.Email))
        {
            return BadRequest(new ErrorResponse("Email is required"));
        }

        if (!request.Email.EndsWith(E2EEmailSuffix, StringComparison.OrdinalIgnoreCase))
        {
            return BadRequest(new ErrorResponse($"Email must end with {E2EEmailSuffix}"));
        }

        // Check if user already exists
        var existingUser = await _db.Users.FirstOrDefaultAsync(u => u.AuthSub == request.Email);
        if (existingUser != null)
        {
            return Conflict(new ErrorResponse("User with this email already exists"));
        }

        _logger.LogInformation("Creating E2E test user: {Email} with auth mode: {AuthMode}",
            request.Email, request.AuthMode);

        // Create the user
        var user = new User
        {
            Id = Guid.CreateVersion7(),
            AuthSub = request.Email,
            IdentityPubkey = "", // Empty for fresh test user
            CreatedAt = DateTime.UtcNow
        };

        // For LocalAuth mode, set up salts
        if (request.AuthMode.Equals("local", StringComparison.OrdinalIgnoreCase))
        {
            user.UserSalt = RandomNumberGenerator.GetBytes(16);
            user.AccountSalt = RandomNumberGenerator.GetBytes(16);
        }

        _db.Users.Add(user);

        // Create quota
        _db.UserQuotas.Add(new UserQuota
        {
            UserId = user.Id,
            MaxStorageBytes = _config.GetValue<long>("Quota:DefaultMaxBytes", 10L * 1024 * 1024 * 1024) // 10GB default
        });

        await _db.SaveChangesAsync();

        return Ok(new CreateUserResponse(
            user.Id,
            user.AuthSub,
            request.AuthMode,
            user.CreatedAt
        ));
    }

    /// <summary>
    /// Ensures a pool user exists, creating if necessary.
    /// </summary>
    private async Task<(User? User, bool WasCreated)> EnsurePoolUser(string email, string authMode)
    {
        var existingUser = await _db.Users.FirstOrDefaultAsync(u => u.AuthSub == email);
        if (existingUser != null)
        {
            return (existingUser, false);
        }

        var user = new User
        {
            Id = Guid.CreateVersion7(),
            AuthSub = email,
            IdentityPubkey = "", // Empty for fresh test user
            CreatedAt = DateTime.UtcNow
        };

        // For LocalAuth mode, set up salts
        if (authMode.Equals("local", StringComparison.OrdinalIgnoreCase))
        {
            user.UserSalt = RandomNumberGenerator.GetBytes(16);
            user.AccountSalt = RandomNumberGenerator.GetBytes(16);
        }

        _db.Users.Add(user);

        // Create quota
        _db.UserQuotas.Add(new UserQuota
        {
            UserId = user.Id,
            MaxStorageBytes = _config.GetValue<long>("Quota:DefaultMaxBytes", 10L * 1024 * 1024 * 1024) // 10GB default
        });

        await _db.SaveChangesAsync();

        _logger.LogInformation("Created pool user: {Email}", email);

        return (user, true);
    }

    /// <summary>
    /// Expires a share link immediately for E2E testing purposes.
    /// Sets the ExpiresAt to 1 hour in the past.
    /// </summary>
    /// <param name="linkIdBase64">Base64url-encoded LinkId.</param>
    /// <returns>Success status.</returns>
    /// <response code="200">Link was expired.</response>
    /// <response code="404">Environment is not Development/Testing or link not found.</response>
    [HttpPost("expire-link/{linkIdBase64}")]
    [ProducesResponseType(typeof(ExpireLinkResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> ExpireLink(string linkIdBase64)
    {
        if (!IsTestEnvironment())
        {
            return NotFound();
        }

        // Decode link ID from base64url
        var linkIdBytes = FromBase64Url(linkIdBase64);
        if (linkIdBytes == null)
        {
            return BadRequest(new ErrorResponse("Invalid linkId format"));
        }

        var shareLink = await _db.ShareLinks.FirstOrDefaultAsync(sl => sl.LinkId == linkIdBytes);
        if (shareLink == null)
        {
            return NotFound(new ErrorResponse("Share link not found"));
        }

        // Set expiry to 1 hour ago
        shareLink.ExpiresAt = DateTimeOffset.UtcNow.AddHours(-1);
        await _db.SaveChangesAsync();

        _logger.LogInformation("Expired share link {LinkId} for E2E testing", linkIdBase64);

        return Ok(new ExpireLinkResponse(linkIdBase64, shareLink.ExpiresAt.Value));
    }

    /// <summary>
    /// Convert base64url string to bytes
    /// </summary>
    private static byte[]? FromBase64Url(string base64Url)
    {
        try
        {
            // Restore base64 padding
            var base64 = base64Url
                .Replace('-', '+')
                .Replace('_', '/');
            
            switch (base64.Length % 4)
            {
                case 2: base64 += "=="; break;
                case 3: base64 += "="; break;
            }
            
            return Convert.FromBase64String(base64);
        }
        catch
        {
            return null;
        }
    }

    #region Request/Response DTOs

    /// <summary>
    /// Response for the expire-link endpoint.
    /// </summary>
    /// <param name="LinkId">The link ID that was expired.</param>
    /// <param name="ExpiresAt">The new expiration time.</param>
    public record ExpireLinkResponse(string LinkId, DateTimeOffset ExpiresAt);

    /// <summary>
    /// Response for the reset endpoint.
    /// </summary>
    /// <param name="DeletedUsers">Number of E2E test users that were deleted.</param>
    public record ResetResponse(int DeletedUsers);

    /// <summary>
    /// Response for the ensure-pool endpoint.
    /// </summary>
    /// <param name="Users">All pool user emails.</param>
    /// <param name="CreatedUsers">Emails of users that were created.</param>
    /// <param name="ExistingUsers">Emails of users that already existed.</param>
    public record EnsurePoolResponse(
        string[] Users,
        List<string> CreatedUsers,
        List<string> ExistingUsers
    );

    /// <summary>
    /// Request for the create-user endpoint.
    /// </summary>
    /// <param name="Email">Email address for the user. Must end with @e2e.local.</param>
    /// <param name="AuthMode">Authentication mode: "proxy" or "local".</param>
    public record CreateUserRequest(string Email, string AuthMode);

    /// <summary>
    /// Response for the create-user endpoint.
    /// </summary>
    /// <param name="Id">The created user's ID.</param>
    /// <param name="Email">The user's email/AuthSub.</param>
    /// <param name="AuthMode">The authentication mode used.</param>
    /// <param name="CreatedAt">When the user was created.</param>
    public record CreateUserResponse(
        Guid Id,
        string Email,
        string AuthMode,
        DateTime CreatedAt
    );

    /// <summary>
    /// Generic error response.
    /// </summary>
    /// <param name="Error">The error message.</param>
    public record ErrorResponse(string Error);

    #endregion
}

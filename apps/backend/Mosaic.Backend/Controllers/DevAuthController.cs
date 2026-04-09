using System.Security.Cryptography;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Models.Auth;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Logging;

namespace Mosaic.Backend.Controllers;

#if DEBUG
/// <summary>
/// Development-only authentication controller.
/// Provides quick login without cryptographic verification for local testing.
/// This controller is ONLY available when ASPNETCORE_ENVIRONMENT=Development AND Auth:Mode=LocalAuth.
/// </summary>
[ApiController]
[Route("api/dev-auth")]
public class DevAuthController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly ILogger<DevAuthController> _logger;
    private readonly IWebHostEnvironment _env;
    private readonly bool _isLocalAuthMode;

    // Session expiry settings (same as AuthController)
    private static readonly TimeSpan SessionSlidingExpiry = TimeSpan.FromDays(7);
    private static readonly TimeSpan SessionAbsoluteExpiry = TimeSpan.FromDays(30);

    public DevAuthController(
        MosaicDbContext db,
        IConfiguration config,
        ILogger<DevAuthController> logger,
        IWebHostEnvironment env)
    {
        _db = db;
        _logger = logger;
        _env = env;

        // Check if LocalAuth mode is enabled (support both new and legacy config)
        var legacyMode = config["Auth:Mode"];
        if (config.GetValue<bool?>("Auth:LocalAuthEnabled") != null)
        {
            _isLocalAuthMode = config.GetValue("Auth:LocalAuthEnabled", false);
        }
        else if (!string.IsNullOrEmpty(legacyMode))
        {
            _isLocalAuthMode = legacyMode.Equals("LocalAuth", StringComparison.OrdinalIgnoreCase);
        }
        else
        {
            _isLocalAuthMode = false;
        }
    }

    /// <summary>
    /// Quick login for development - creates user if needed and establishes session.
    /// Only works in Development environment with LocalAuth mode.
    /// </summary>
    [HttpPost("login")]
    public async Task<IActionResult> DevLogin([FromBody] DevLoginRequest request)
    {
        // Security: Only allow in Development environment
        if (!_env.IsDevelopment())
        {
            return NotFound();
        }

        // Security: Only allow when LocalAuth is enabled
        if (!_isLocalAuthMode)
        {
            return NotFound();
        }

        if (string.IsNullOrWhiteSpace(request.Username))
        {
            return Problem(
                detail: "Username is required",
                statusCode: StatusCodes.Status400BadRequest);
        }

        Log.DevAuthLogin(_logger, request.Username);

        // Find or create user
        var user = await _db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.AuthSub == request.Username);

        if (user == null)
        {
            // Create new user with deterministic dev salts
            var userSalt = GenerateDevSalt($"{request.Username}_user");
            var accountSalt = GenerateDevSalt($"{request.Username}_account");

            user = new User
            {
                Id = Guid.CreateVersion7(),
                AuthSub = request.Username,
                IdentityPubkey = "", // Will be set by client on first proper init
                UserSalt = userSalt,
                AccountSalt = accountSalt,
                // Note: AuthPubkey will be set by client on first proper init
                CreatedAt = DateTime.UtcNow
            };
            _db.Users.Add(user);

            // Create quota with default settings (consistent with CurrentUserService)
            _db.UserQuotas.Add(new UserQuota
            {
                UserId = user.Id,
                MaxStorageBytes = 10737418240L // 10 GB default
            });

            await _db.SaveChangesAsync();

            _logger.LogInformation("Created dev user: {Username}", request.Username);
        }

        // Create session
        var sessionToken = RandomNumberGenerator.GetBytes(32);
        var tokenHash = SHA256.HashData(sessionToken);

        var session = new Session
        {
            Id = Guid.CreateVersion7(),
            UserId = user.Id,
            TokenHash = tokenHash,
            ExpiresAt = DateTime.UtcNow.Add(SessionAbsoluteExpiry),
            UserAgent = Request.Headers.UserAgent.ToString(),
            IpAddress = HttpContext.Connection.RemoteIpAddress?.ToString(),
            DeviceName = "Dev Session"
        };
        _db.Sessions.Add(session);
        await _db.SaveChangesAsync();

        // Set session cookie (non-secure for localhost dev)
        Response.Cookies.Append("mosaic_session", Convert.ToBase64String(sessionToken), new CookieOptions
        {
            HttpOnly = true,
            Secure = false, // Allow HTTP for localhost dev
            SameSite = SameSiteMode.Lax, // Lax for dev, Strict in prod
            Path = "/api",
            MaxAge = SessionSlidingExpiry
        });

        return Ok(new DevLoginResponse
        {
            UserId = user.Id,
            Username = user.AuthSub ?? request.Username,
            UserSalt = Convert.ToBase64String(user.UserSalt ?? []),
            AccountSalt = Convert.ToBase64String(user.AccountSalt ?? []),
            IsNewUser = user.WrappedAccountKey == null
        });
    }

    /// <summary>
    /// Update user's crypto keys after client-side initialization.
    /// This allows the dev flow to work: quick login -> client init -> store keys.
    /// </summary>
    [HttpPost("update-keys")]
    public async Task<IActionResult> UpdateKeys([FromBody] DevUpdateKeysRequest request)
    {
        // Security: Only allow in Development environment
        if (!_env.IsDevelopment())
        {
            return NotFound();
        }

        if (!_isLocalAuthMode)
        {
            return NotFound();
        }

        // Get session from cookie
        if (!Request.Cookies.TryGetValue("mosaic_session", out var tokenBase64))
        {
            return Problem(
                detail: "Not authenticated",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        byte[] token;
        try
        {
            token = Convert.FromBase64String(tokenBase64);
        }
        catch
        {
            return Problem(
                detail: "Invalid session",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        var tokenHash = SHA256.HashData(token);
        var session = await _db.Sessions
            .Include(s => s.User)
            .FirstOrDefaultAsync(s =>
                s.TokenHash == tokenHash &&
                s.RevokedAt == null &&
                s.ExpiresAt > DateTime.UtcNow);

        if (session?.User == null)
        {
            return Problem(
                detail: "Session not found",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        // Update user's crypto keys
        var user = session.User;

        if (!string.IsNullOrEmpty(request.AuthPubkey))
        {
            user.AuthPubkey = request.AuthPubkey;
        }

        if (!string.IsNullOrEmpty(request.IdentityPubkey))
        {
            user.IdentityPubkey = request.IdentityPubkey;
        }

        if (!string.IsNullOrEmpty(request.WrappedAccountKey))
        {
            user.WrappedAccountKey = Convert.FromBase64String(request.WrappedAccountKey);
        }

        if (!string.IsNullOrEmpty(request.WrappedIdentitySeed))
        {
            user.WrappedIdentitySeed = Convert.FromBase64String(request.WrappedIdentitySeed);
        }

        await _db.SaveChangesAsync();

        return Ok(new { success = true });
    }

    /// <summary>
    /// Generate deterministic salt for dev users (predictable for testing).
    /// </summary>
    private static byte[] GenerateDevSalt(string seed)
    {
        return SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"mosaic_dev_{seed}"))[..16];
    }
}

#endif

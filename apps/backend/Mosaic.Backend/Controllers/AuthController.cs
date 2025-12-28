using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using NSec.Cryptography;

namespace Mosaic.Backend.Controllers;

/// <summary>
/// Handles local authentication using Ed25519 challenge-response protocol.
/// This controller is only active when Auth:Mode is "LocalAuth".
/// </summary>
[ApiController]
[Route("api/auth")]
public partial class AuthController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IConfiguration _config;
    private readonly ILogger<AuthController> _logger;

    // Challenge expires after 60 seconds
    private static readonly TimeSpan ChallengeExpiry = TimeSpan.FromSeconds(60);

    // Session sliding window: 7 days
    private static readonly TimeSpan SessionSlidingExpiry = TimeSpan.FromDays(7);

    // Session absolute maximum: 30 days
    private static readonly TimeSpan SessionAbsoluteExpiry = TimeSpan.FromDays(30);

    // Domain separation context (must match TypeScript implementation)
    private const string AuthChallengeContext = "Mosaic_Auth_Challenge_v1";

    [GeneratedRegex(@"^[a-zA-Z0-9_\-@.]+$", RegexOptions.Compiled)]
    private static partial Regex ValidUsernamePattern();

    public AuthController(
        MosaicDbContext db,
        IConfiguration config,
        ILogger<AuthController> logger)
    {
        _db = db;
        _config = config;
        _logger = logger;
    }

    /// <summary>
    /// Request a challenge for authentication.
    /// Returns user salt (or fake salt for non-existent users to prevent enumeration).
    /// </summary>
    [HttpPost("init")]
    public async Task<IActionResult> InitAuth([FromBody] AuthInitRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Username))
        {
            return BadRequest(new { error = "Username is required" });
        }

        if (!ValidUsernamePattern().IsMatch(request.Username))
        {
            return BadRequest(new { error = "Invalid username format" });
        }

        var ipAddress = HttpContext.Connection.RemoteIpAddress?.ToString();

        // Check rate limiting (max 10 challenges per IP per minute)
        var oneMinuteAgo = DateTime.UtcNow.AddMinutes(-1);
        var recentChallenges = await _db.AuthChallenges
            .Where(c => c.IpAddress == ipAddress && c.CreatedAt > oneMinuteAgo)
            .CountAsync();

        if (recentChallenges >= 10)
        {
            _logger.LogWarning("Rate limit exceeded for IP {IP}", ipAddress);
            return StatusCode(429, new { error = "Too many requests. Please wait." });
        }

        // Look up user
        var user = await _db.Users.FirstOrDefaultAsync(u => u.AuthSub == request.Username);

        byte[] challenge = RandomNumberGenerator.GetBytes(32);
        byte[] userSalt;

        if (user != null && user.UserSalt != null)
        {
            // Real user - use actual salt
            userSalt = user.UserSalt;
        }
        else
        {
            // Non-existent user or user without local auth setup
            // Generate deterministic fake salt to prevent enumeration
            userSalt = GenerateFakeSalt(request.Username);
        }

        // Store challenge
        var authChallenge = new AuthChallenge
        {
            Id = Guid.CreateVersion7(),
            Username = request.Username,
            Challenge = challenge,
            ExpiresAt = DateTime.UtcNow.Add(ChallengeExpiry),
            IpAddress = ipAddress
        };
        _db.AuthChallenges.Add(authChallenge);
        await _db.SaveChangesAsync();

        // Cleanup old challenges
        await CleanupExpiredChallenges();

        return Ok(new AuthInitResponse
        {
            ChallengeId = authChallenge.Id,
            Challenge = Convert.ToBase64String(challenge),
            UserSalt = Convert.ToBase64String(userSalt),
            Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        });
    }

    /// <summary>
    /// Verify challenge signature and create session.
    /// Only returns wrapped keys after successful authentication.
    /// </summary>
    [HttpPost("verify")]
    public async Task<IActionResult> VerifyAuth([FromBody] AuthVerifyRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Username) ||
            string.IsNullOrWhiteSpace(request.Signature) ||
            request.ChallengeId == Guid.Empty)
        {
            return BadRequest(new { error = "Missing required fields" });
        }

        // Look up and validate challenge
        var authChallenge = await _db.AuthChallenges.FindAsync(request.ChallengeId);
        if (authChallenge == null)
        {
            return Unauthorized(new { error = "Invalid or expired challenge" });
        }

        if (authChallenge.Username != request.Username)
        {
            return Unauthorized(new { error = "Invalid challenge" });
        }

        if (authChallenge.IsUsed)
        {
            return Unauthorized(new { error = "Challenge already used" });
        }

        if (authChallenge.ExpiresAt < DateTime.UtcNow)
        {
            return Unauthorized(new { error = "Challenge expired" });
        }

        // Mark challenge as used (single-use)
        authChallenge.IsUsed = true;
        await _db.SaveChangesAsync();

        // Look up user
        var user = await _db.Users.FirstOrDefaultAsync(u => u.AuthSub == request.Username);
        if (user == null || string.IsNullOrEmpty(user.AuthPubkey))
        {
            // User doesn't exist or doesn't have local auth set up
            // Return same error to prevent enumeration
            _logger.LogInformation("Auth failed: user not found or no local auth: {Username}", request.Username);
            return Unauthorized(new { error = "Invalid credentials" });
        }

        // Verify signature
        try
        {
            var isValid = VerifySignature(
                authChallenge.Challenge,
                request.Username,
                request.Signature,
                user.AuthPubkey,
                request.Timestamp
            );

            if (!isValid)
            {
                _logger.LogInformation("Auth failed: invalid signature for {Username}", request.Username);
                return Unauthorized(new { error = "Invalid credentials" });
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Signature verification error for {Username}", request.Username);
            return Unauthorized(new { error = "Invalid credentials" });
        }

        // Authentication successful - create session
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
            DeviceName = ParseDeviceName(Request.Headers.UserAgent.ToString())
        };
        _db.Sessions.Add(session);
        await _db.SaveChangesAsync();

        // Set session cookie
        Response.Cookies.Append("mosaic_session", Convert.ToBase64String(sessionToken), new CookieOptions
        {
            HttpOnly = true,
            Secure = true,
            SameSite = SameSiteMode.Strict,
            Path = "/api",
            MaxAge = SessionSlidingExpiry
        });

        // Return wrapped keys (only after successful auth)
        return Ok(new AuthVerifyResponse
        {
            Success = true,
            UserId = user.Id,
            AccountSalt = user.AccountSalt != null ? Convert.ToBase64String(user.AccountSalt) : null,
            WrappedAccountKey = user.WrappedAccountKey != null ? Convert.ToBase64String(user.WrappedAccountKey) : null,
            WrappedIdentitySeed = user.WrappedIdentitySeed != null ? Convert.ToBase64String(user.WrappedIdentitySeed) : null,
            IdentityPubkey = user.IdentityPubkey
        });
    }

    /// <summary>
    /// Register a new user with local authentication.
    /// In production, this should be admin-only.
    /// </summary>
    [HttpPost("register")]
    public async Task<IActionResult> Register([FromBody] AuthRegisterRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Username) ||
            string.IsNullOrWhiteSpace(request.AuthPubkey) ||
            string.IsNullOrWhiteSpace(request.IdentityPubkey) ||
            request.UserSalt == null ||
            request.AccountSalt == null)
        {
            return BadRequest(new { error = "Missing required fields" });
        }

        if (!ValidUsernamePattern().IsMatch(request.Username))
        {
            return BadRequest(new { error = "Invalid username format" });
        }

        // Check if user already exists
        var existingUser = await _db.Users.AnyAsync(u => u.AuthSub == request.Username);
        if (existingUser)
        {
            return Conflict(new { error = "Username already exists" });
        }

        // Validate key lengths
        byte[] userSalt, accountSalt, wrappedAccountKey, wrappedIdentitySeed;
        try
        {
            userSalt = Convert.FromBase64String(request.UserSalt);
            accountSalt = Convert.FromBase64String(request.AccountSalt);
            wrappedAccountKey = Convert.FromBase64String(request.WrappedAccountKey ?? "");
            wrappedIdentitySeed = Convert.FromBase64String(request.WrappedIdentitySeed ?? "");

            if (userSalt.Length != 16)
                return BadRequest(new { error = "UserSalt must be 16 bytes" });
            if (accountSalt.Length != 16)
                return BadRequest(new { error = "AccountSalt must be 16 bytes" });
        }
        catch (FormatException)
        {
            return BadRequest(new { error = "Invalid base64 encoding" });
        }

        // Check if this is the first user (make them admin)
        var isFirstUser = !await _db.Users.AnyAsync();

        var user = new User
        {
            Id = Guid.CreateVersion7(),
            AuthSub = request.Username,
            IdentityPubkey = request.IdentityPubkey,
            AuthPubkey = request.AuthPubkey,
            UserSalt = userSalt,
            AccountSalt = accountSalt,
            WrappedAccountKey = wrappedAccountKey.Length > 0 ? wrappedAccountKey : null,
            WrappedIdentitySeed = wrappedIdentitySeed.Length > 0 ? wrappedIdentitySeed : null,
            IsAdmin = isFirstUser  // First user is admin
        };

        _db.Users.Add(user);

        // Create quota for the new user
        var quota = new UserQuota
        {
            UserId = user.Id,
            MaxStorageBytes = _config.GetValue<long>("Quota:DefaultMaxBytes", 10737418240L), // 10 GB default
            MaxAlbums = _config.GetValue<int?>("Quota:DefaultMaxAlbums")
        };
        _db.UserQuotas.Add(quota);

        await _db.SaveChangesAsync();

        _logger.LogInformation("New user registered: {Username} (admin: {IsAdmin})", request.Username, isFirstUser);

        return Created($"/api/users/{user.Id}", new { id = user.Id, username = user.AuthSub, isAdmin = isFirstUser });
    }

    /// <summary>
    /// Logout - revoke current session.
    /// </summary>
    [HttpPost("logout")]
    public async Task<IActionResult> Logout()
    {
        var sessionToken = GetSessionToken();
        if (sessionToken == null)
        {
            return Ok(new { message = "Already logged out" });
        }

        var tokenHash = SHA256.HashData(sessionToken);
        var session = await _db.Sessions.FirstOrDefaultAsync(s => s.TokenHash == tokenHash);
        if (session != null)
        {
            session.RevokedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync();
        }

        // Clear cookie
        Response.Cookies.Delete("mosaic_session", new CookieOptions
        {
            HttpOnly = true,
            Secure = true,
            SameSite = SameSiteMode.Strict,
            Path = "/api"
        });

        return Ok(new { message = "Logged out" });
    }

    /// <summary>
    /// List all active sessions for current user.
    /// </summary>
    [HttpGet("sessions")]
    public async Task<IActionResult> ListSessions()
    {
        var userId = await GetCurrentUserId();
        if (userId == null)
        {
            return Unauthorized();
        }

        var sessions = await _db.Sessions
            .Where(s => s.UserId == userId && s.RevokedAt == null && s.ExpiresAt > DateTime.UtcNow)
            .OrderByDescending(s => s.LastSeenAt)
            .Select(s => new
            {
                s.Id,
                s.DeviceName,
                s.IpAddress,
                s.CreatedAt,
                s.LastSeenAt,
                IsCurrent = s.TokenHash == GetCurrentTokenHash()
            })
            .ToListAsync();

        return Ok(sessions);
    }

    /// <summary>
    /// Revoke a specific session.
    /// </summary>
    [HttpDelete("sessions/{sessionId}")]
    public async Task<IActionResult> RevokeSession(Guid sessionId)
    {
        var userId = await GetCurrentUserId();
        if (userId == null)
        {
            return Unauthorized();
        }

        var session = await _db.Sessions.FirstOrDefaultAsync(s => s.Id == sessionId && s.UserId == userId);
        if (session == null)
        {
            return NotFound();
        }

        session.RevokedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        return Ok(new { message = "Session revoked" });
    }

    /// <summary>
    /// Revoke all sessions except current.
    /// </summary>
    [HttpPost("sessions/revoke-others")]
    public async Task<IActionResult> RevokeOtherSessions()
    {
        var userId = await GetCurrentUserId();
        if (userId == null)
        {
            return Unauthorized();
        }

        var currentTokenHash = GetCurrentTokenHash();
        var sessionsToRevoke = await _db.Sessions
            .Where(s => s.UserId == userId && s.RevokedAt == null && s.TokenHash != currentTokenHash)
            .ToListAsync();

        foreach (var session in sessionsToRevoke)
        {
            session.RevokedAt = DateTime.UtcNow;
        }
        await _db.SaveChangesAsync();

        return Ok(new { revokedCount = sessionsToRevoke.Count });
    }

    // ===== Helper Methods =====

    private byte[]? GetSessionToken()
    {
        if (!Request.Cookies.TryGetValue("mosaic_session", out var tokenBase64))
        {
            return null;
        }

        try
        {
            return Convert.FromBase64String(tokenBase64);
        }
        catch
        {
            return null;
        }
    }

    private byte[]? GetCurrentTokenHash()
    {
        var token = GetSessionToken();
        return token != null ? SHA256.HashData(token) : null;
    }

    private async Task<Guid?> GetCurrentUserId()
    {
        var token = GetSessionToken();
        if (token == null) return null;

        var tokenHash = SHA256.HashData(token);
        var session = await _db.Sessions
            .FirstOrDefaultAsync(s =>
                s.TokenHash == tokenHash &&
                s.RevokedAt == null &&
                s.ExpiresAt > DateTime.UtcNow);

        if (session == null) return null;

        // Check sliding expiration (7 days since last use)
        if (session.LastSeenAt < DateTime.UtcNow.Add(-SessionSlidingExpiry))
        {
            return null;
        }

        // Update last seen
        session.LastSeenAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        return session.UserId;
    }

    private byte[] GenerateFakeSalt(string username)
    {
        // Get server secret from config, or use a default for development
        var serverSecretBase64 = _config["Auth:ServerSecret"];
        byte[] serverSecret;

        if (string.IsNullOrEmpty(serverSecretBase64))
        {
            // In development, use a deterministic secret
            serverSecret = SHA256.HashData(System.Text.Encoding.UTF8.GetBytes("mosaic-dev-secret"));
        }
        else
        {
            serverSecret = Convert.FromBase64String(serverSecretBase64);
        }

        // Deterministic fake salt: SHA256(serverSecret || "fake_salt" || username), truncated to 16 bytes
        var combined = serverSecret
            .Concat(System.Text.Encoding.UTF8.GetBytes("fake_salt"))
            .Concat(System.Text.Encoding.UTF8.GetBytes(username))
            .ToArray();

        return SHA256.HashData(combined)[..16];
    }

    private bool VerifySignature(byte[] challenge, string username, string signatureBase64, string pubkeyBase64, long? timestamp)
    {
        var signature = Convert.FromBase64String(signatureBase64);
        var pubkey = Convert.FromBase64String(pubkeyBase64);

        if (signature.Length != 64 || pubkey.Length != 32)
        {
            return false;
        }

        // Build message exactly as in TypeScript: context || username_length(4 bytes BE) || username || timestamp?(8 bytes BE) || challenge
        var context = System.Text.Encoding.UTF8.GetBytes(AuthChallengeContext);
        var usernameBytes = System.Text.Encoding.UTF8.GetBytes(username);
        var usernameLenBytes = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(usernameLenBytes, (uint)usernameBytes.Length);

        byte[] message;
        if (timestamp.HasValue)
        {
            var timestampBytes = new byte[8];
            BinaryPrimitives.WriteUInt64BigEndian(timestampBytes, (ulong)timestamp.Value);
            message = context
                .Concat(usernameLenBytes)
                .Concat(usernameBytes)
                .Concat(timestampBytes)
                .Concat(challenge)
                .ToArray();
        }
        else
        {
            message = context
                .Concat(usernameLenBytes)
                .Concat(usernameBytes)
                .Concat(challenge)
                .ToArray();
        }

        // Verify Ed25519 signature using NSec
        var algorithm = SignatureAlgorithm.Ed25519;
        var publicKey = PublicKey.Import(algorithm, pubkey, KeyBlobFormat.RawPublicKey);

        return algorithm.Verify(publicKey, message, signature);
    }

    private static string? ParseDeviceName(string userAgent)
    {
        if (string.IsNullOrEmpty(userAgent)) return null;

        // Simple device name extraction
        if (userAgent.Contains("Windows")) return "Windows";
        if (userAgent.Contains("Macintosh")) return "Mac";
        if (userAgent.Contains("Linux")) return "Linux";
        if (userAgent.Contains("iPhone")) return "iPhone";
        if (userAgent.Contains("iPad")) return "iPad";
        if (userAgent.Contains("Android")) return "Android";

        return "Unknown";
    }

    private async Task CleanupExpiredChallenges()
    {
        // Delete challenges older than 5 minutes
        var cutoff = DateTime.UtcNow.AddMinutes(-5);
        
        try
        {
            // Try bulk delete first (PostgreSQL)
            await _db.AuthChallenges
                .Where(c => c.CreatedAt < cutoff)
                .ExecuteDeleteAsync();
        }
        catch (InvalidOperationException)
        {
            // Fall back to entity-based delete (In-Memory provider for tests)
            var expiredChallenges = await _db.AuthChallenges
                .Where(c => c.CreatedAt < cutoff)
                .ToListAsync();
            _db.AuthChallenges.RemoveRange(expiredChallenges);
            await _db.SaveChangesAsync();
        }
    }

    // ===== Request/Response DTOs =====

    public record AuthInitRequest(string Username);

    public record AuthInitResponse
    {
        public Guid ChallengeId { get; init; }
        public required string Challenge { get; init; }
        public required string UserSalt { get; init; }
        public long Timestamp { get; init; }
    }

    public record AuthVerifyRequest(
        string Username,
        Guid ChallengeId,
        string Signature,
        long? Timestamp = null
    );

    public record AuthVerifyResponse
    {
        public bool Success { get; init; }
        public Guid UserId { get; init; }
        public string? AccountSalt { get; init; }
        public string? WrappedAccountKey { get; init; }
        public string? WrappedIdentitySeed { get; init; }
        public string? IdentityPubkey { get; init; }
    }

    public record AuthRegisterRequest(
        string Username,
        string AuthPubkey,
        string IdentityPubkey,
        string UserSalt,
        string AccountSalt,
        string? WrappedAccountKey = null,
        string? WrappedIdentitySeed = null
    );
}

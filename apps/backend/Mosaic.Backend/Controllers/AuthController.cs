using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Mosaic.Backend.Crypto;
using Mosaic.Backend.Data;
using Mosaic.Backend.Models.Auth;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Logging;
using Mosaic.Backend.Security;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

/// <summary>
/// Handles local authentication using Ed25519 challenge-response protocol.
/// This controller is only active when Auth:Mode is "LocalAuth".
/// Returns 404 for all endpoints when in ProxyAuth mode.
/// </summary>
[ApiController]
[Route("api/v1/auth")]
public partial class AuthController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IConfiguration _config;
    private readonly ILogger<AuthController> _logger;
    private readonly RustCoreHost _rustHost;
    private readonly bool _isLocalAuthMode;

    // Challenge expires after 60 seconds
    private static readonly TimeSpan ChallengeExpiry = TimeSpan.FromSeconds(60);

    // Session sliding window: 7 days
    private static readonly TimeSpan SessionSlidingExpiry = TimeSpan.FromDays(7);

    // Session absolute maximum: 30 days
    private static readonly TimeSpan SessionAbsoluteExpiry = TimeSpan.FromDays(30);

    private const int DefaultKdfMemoryKib = 65536;
    private const int DefaultKdfIterations = 3;
    private const int DefaultKdfParallelism = 1;
    private const byte DefaultKdfAlgVersion = 0x13;

    [GeneratedRegex(@"^[a-zA-Z0-9_\-@.]+$", RegexOptions.Compiled)]
    private static partial Regex ValidUsernamePattern();

    private readonly IWebHostEnvironment _env;
    private readonly IMemoryCache _cache;
    private readonly IAuditLogService? _auditLog;
    private readonly TimeProvider _timeProvider;
    private readonly MosaicMetrics? _metrics;
    private readonly KdfPolicy _kdfPolicy;
    private readonly bool _isProxyAuthMode;

    public AuthController(
        MosaicDbContext db,
        IConfiguration config,
        ILogger<AuthController> logger,
        IWebHostEnvironment env,
        IMemoryCache cache,
        RustCoreHost rustHost,
        KdfPolicy kdfPolicy,
        IAuditLogService? auditLog = null,
        TimeProvider? timeProvider = null,
        MosaicMetrics? metrics = null)
    {
        _db = db;
        _config = config;
        _logger = logger;
        _rustHost = rustHost;
        _env = env;
        _cache = cache;
        _auditLog = auditLog;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _metrics = metrics;
        _kdfPolicy = kdfPolicy;

        // Check if LocalAuth mode is enabled (support both new and legacy config)
        var legacyMode = config["Auth:Mode"];
        if (config.GetValue<bool?>("Auth:LocalAuthEnabled") != null)
        {
            _isLocalAuthMode = config.GetValue("Auth:LocalAuthEnabled", false);
            _isProxyAuthMode = config.GetValue("Auth:ProxyAuthEnabled", false);
        }
        else if (!string.IsNullOrEmpty(legacyMode))
        {
            _isLocalAuthMode = legacyMode.Equals("LocalAuth", StringComparison.OrdinalIgnoreCase);
            _isProxyAuthMode = legacyMode.Equals("ProxyAuth", StringComparison.OrdinalIgnoreCase);
        }
        else
        {
            _isLocalAuthMode = false;
            _isProxyAuthMode = true; // Default to ProxyAuth
        }
    }

    /// <summary>
    /// Get authentication configuration.
    /// Returns which auth methods are enabled so the frontend can show the appropriate UI.
    /// This endpoint is always public (no authentication required).
    /// </summary>
    [HttpGet("config")]
    public IActionResult GetAuthConfig()
    {
        return Ok(new
        {
            localAuthEnabled = _isLocalAuthMode,
            proxyAuthEnabled = _isProxyAuthMode
        });
    }

    /// <summary>
    /// Request a challenge for authentication.
    /// Returns user salt (or fake salt for non-existent users to prevent enumeration).
    /// </summary>
    [HttpPost("init")]
    public async Task<IActionResult> InitAuth([FromBody] AuthInitRequest request)
    {
        // Return ProblemDetails 404 when not in LocalAuth mode (RFC7807, consistent with other controllers)
        if (!_isLocalAuthMode)
        {
            return Problem(
                title: "Local authentication disabled",
                detail: "This endpoint is only available when local authentication is enabled. Contact your administrator.",
                statusCode: StatusCodes.Status404NotFound,
                type: "https://tools.ietf.org/html/rfc7231#section-6.5.4");
        }

        if (string.IsNullOrWhiteSpace(request.Username))
        {
            return Problem(
                detail: "Username is required",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (!ValidUsernamePattern().IsMatch(request.Username))
        {
            return Problem(
                detail: "Invalid username format",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var ipAddress = HttpContext.Connection.RemoteIpAddress?.ToString();

        // Check rate limiting (max 10 challenges per IP per minute)
        // Skip rate limiting in Development and Testing environments for easier testing
        if (!_env.IsDevelopment() && !_env.IsEnvironment("Testing"))
        {
            var oneMinuteAgo = _timeProvider.GetUtcNow().UtcDateTime.AddMinutes(-1);
            var recentChallenges = await _db.AuthChallenges
                .Where(c => c.IpAddress == ipAddress && c.CreatedAt > oneMinuteAgo)
                .CountAsync();

            if (recentChallenges >= 10)
            {
                _logger.AuthRateLimited(request.Username);
                Response.Headers.RetryAfter = "60";
                return Problem(
                    statusCode: StatusCodes.Status429TooManyRequests,
                    title: "Too many requests",
                    detail: "Too many requests. Please wait.");
            }
        }

        // Look up user
        var user = await _db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.AuthSub == request.Username);

        byte[] challenge = RandomNumberGenerator.GetBytes(32);
        byte[] userSalt;
        var kdfMemoryKib = DefaultKdfMemoryKib;
        var kdfIterations = DefaultKdfIterations;
        var kdfParallelism = DefaultKdfParallelism;
        var kdfAlgVersion = DefaultKdfAlgVersion;

        if (user != null && user.UserSalt != null)
        {
            // Real user - use actual salt
            userSalt = user.UserSalt;
            kdfMemoryKib = user.KdfMemoryKib;
            kdfIterations = user.KdfIterations;
            kdfParallelism = user.KdfParallelism;
            kdfAlgVersion = user.KdfAlgVersion;
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
            ExpiresAt = _timeProvider.GetUtcNow().UtcDateTime.Add(ChallengeExpiry),
            IpAddress = ipAddress
        };
        _db.AuthChallenges.Add(authChallenge);
        await _db.SaveChangesAsync();

        // Cleanup old challenges
        await CleanupExpiredChallengesAsync();

        return Ok(new AuthInitResponse
        {
            ChallengeId = authChallenge.Id,
            Challenge = Convert.ToBase64String(challenge),
            UserSalt = Convert.ToBase64String(userSalt),
            Timestamp = _timeProvider.GetUtcNow().ToUnixTimeMilliseconds(),
            KdfMemoryKib = kdfMemoryKib,
            KdfIterations = kdfIterations,
            KdfParallelism = kdfParallelism,
            KdfAlgVersion = kdfAlgVersion
        });
    }

    /// <summary>
    /// Verify challenge signature and create session.
    /// Only returns wrapped keys after successful authentication.
    /// </summary>
    [HttpPost("verify")]
    public async Task<IActionResult> VerifyAuth([FromBody] AuthVerifyRequest request)
    {
        // Return 404 when not in LocalAuth mode
        if (!_isLocalAuthMode)
        {
            return NotFound();
        }

        if (string.IsNullOrWhiteSpace(request.Username) ||
            string.IsNullOrWhiteSpace(request.Signature) ||
            request.ChallengeId == Guid.Empty)
        {
            return Problem(
                detail: "Missing required fields",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (!ValidUsernamePattern().IsMatch(request.Username))
        {
            return Problem(
                detail: "Invalid username format",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var ipAddress = HttpContext.Connection.RemoteIpAddress?.ToString();

        // Rate limit verify attempts (max 10 per IP per minute)
        // Skip rate limiting in Development and Testing environments for easier testing
        if (!_env.IsDevelopment() && !_env.IsEnvironment("Testing"))
        {
            var oneMinuteAgo = _timeProvider.GetUtcNow().UtcDateTime.AddMinutes(-1);
            var recentChallenges = await _db.AuthChallenges
                .Where(c => c.IpAddress == ipAddress && c.IsUsed && c.CreatedAt > oneMinuteAgo)
                .CountAsync();

            if (recentChallenges >= 10)
            {
                _logger.AuthRateLimited(request.Username);
                Response.Headers.RetryAfter = "60";
                return Problem(
                    statusCode: StatusCodes.Status429TooManyRequests,
                    title: "Too many requests",
                    detail: "Too many attempts. Please wait.");
            }
        }

        // Look up and validate challenge
        var authChallenge = await _db.AuthChallenges
            .AsNoTracking()
            .FirstOrDefaultAsync(c => c.Id == request.ChallengeId);
        if (authChallenge == null)
        {
            return Problem(
                detail: "Invalid or expired challenge",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        if (authChallenge.Username != request.Username)
        {
            return Problem(
                detail: "Invalid challenge",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        var now = _timeProvider.GetUtcNow().UtcDateTime;
        var challengeClaimed = await TryClaimAuthChallengeAsync(request.ChallengeId, now);
        if (!challengeClaimed)
        {
            var currentChallenge = await _db.AuthChallenges
                .AsNoTracking()
                .FirstOrDefaultAsync(c => c.Id == request.ChallengeId);
            var detail = currentChallenge?.IsUsed == true
                ? "Challenge already used"
                : "Challenge expired";

            return Problem(
                detail: detail,
                statusCode: StatusCodes.Status401Unauthorized);
        }

        // Look up user
        var user = await _db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.AuthSub == request.Username);
        if (user == null || string.IsNullOrEmpty(user.AuthPubkey))
        {
            // User doesn't exist or doesn't have local auth set up
            // Return same error to prevent enumeration
            _logger.AuthChallengeFailed(request.Username, "user not found or no local auth");
            if (_auditLog is not null)
            {
                await _auditLog.WriteAsync(
                    AuditEventTypes.AuthLoginFailed,
                    AuditOutcomes.Denied,
                    HttpContext,
                    details: new { reason = "user-not-found" });
            }
            return Problem(
                detail: "Invalid credentials",
                statusCode: StatusCodes.Status401Unauthorized);
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
                _metrics?.RecordAuthFailure();
                _logger.AuthChallengeFailed(request.Username, "invalid signature");
                if (_auditLog is not null)
                {
                    await _auditLog.WriteAsync(
                        AuditEventTypes.AuthLoginFailed,
                        AuditOutcomes.Denied,
                        HttpContext,
                        actorUserId: user.Id,
                        details: new { reason = "invalid-signature" });
                }
                return Problem(
                    detail: "Invalid credentials",
                    statusCode: StatusCodes.Status401Unauthorized);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Signature verification error for {Username}", request.Username);
            if (_auditLog is not null)
            {
                await _auditLog.WriteAsync(
                    AuditEventTypes.AuthLoginFailed,
                    AuditOutcomes.Error,
                    HttpContext,
                    actorUserId: user.Id,
                    details: new { reason = "signature-verification-error" });
            }
            return Problem(
                detail: "Invalid credentials",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        // Authentication successful - create session
        var sessionToken = RandomNumberGenerator.GetBytes(32);
        var tokenHash = SHA256.HashData(sessionToken);

        var session = new Session
        {
            Id = Guid.CreateVersion7(),
            UserId = user.Id,
            TokenHash = tokenHash,
            ExpiresAt = _timeProvider.GetUtcNow().UtcDateTime.Add(SessionAbsoluteExpiry),
            UserAgent = Request.Headers.UserAgent.ToString(),
            IpAddress = HttpContext.Connection.RemoteIpAddress?.ToString(),
            DeviceName = ParseDeviceName(Request.Headers.UserAgent.ToString())
        };
        _db.Sessions.Add(session);
        await _db.SaveChangesAsync();

        // D1 audit: record successful sign-in. The actorUserId is the
        // canonical opaque identifier — the plaintext username is NOT
        // included in details to comply with GDPR Article 17 (right to
        // erasure) without retroactive scrubbing. The session token
        // NEVER appears in the audit log.
        if (_auditLog is not null)
        {
            await _auditLog.WriteAsync(
                AuditEventTypes.AuthLoginSucceeded,
                AuditOutcomes.Success,
                HttpContext,
                actorUserId: user.Id,
                details: new { kdfAlgVersion = user.KdfAlgVersion });
        }

        // Set session cookie
        // Use Secure=false in Development/Testing (HTTP), Secure=true in Production (HTTPS)
        var isSecure = !_env.IsDevelopment() && !_env.EnvironmentName.Equals("Testing", StringComparison.OrdinalIgnoreCase);
        Response.Cookies.Append("mosaic_session", Convert.ToBase64String(sessionToken), new CookieOptions
        {
            HttpOnly = true,
            Secure = isSecure,
            SameSite = isSecure ? SameSiteMode.Strict : SameSiteMode.Lax,
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
            IdentityPubkey = user.IdentityPubkey,
            KdfMemoryKib = user.KdfMemoryKib,
            KdfIterations = user.KdfIterations,
            KdfParallelism = user.KdfParallelism,
            KdfAlgVersion = user.KdfAlgVersion
        });
    }

    /// <summary>
    /// Register a new user with local authentication.
    /// In production, this should be admin-only.
    /// </summary>
    [HttpPost("register")]
    public async Task<IActionResult> Register([FromBody] AuthRegisterRequest request)
    {
        // Return 404 when not in LocalAuth mode
        if (!_isLocalAuthMode)
        {
            return NotFound();
        }

        if (string.IsNullOrWhiteSpace(request.Username) ||
            string.IsNullOrWhiteSpace(request.AuthPubkey) ||
            string.IsNullOrWhiteSpace(request.IdentityPubkey) ||
            request.UserSalt == null ||
            request.AccountSalt == null)
        {
            return Problem(
                detail: "Missing required fields",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (!ValidUsernamePattern().IsMatch(request.Username))
        {
            return Problem(
                detail: "Invalid username format",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (!_kdfPolicy.IsValid(request.KdfMemoryKib, request.KdfIterations, request.KdfParallelism, request.KdfAlgVersion))
        {
            return Problem(
                detail: "Invalid KDF profile",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // After the first user is created, registration requires admin authentication.
        // The first registration (bootstrap) remains public so the initial admin can be created.
        // Exception: in Testing environment, registration is always open for E2E test automation.
        var isFirstUser = !await _db.Users.AnyAsync();
        if (!isFirstUser && !_env.IsEnvironment("Testing"))
        {
            var authSub = HttpContext.Items["AuthSub"] as string;
            if (string.IsNullOrEmpty(authSub))
            {
                return Problem(
                    detail: "Authentication required",
                    statusCode: StatusCodes.Status401Unauthorized);
            }

            var callingUser = await _db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.AuthSub == authSub);
            if (callingUser == null || !callingUser.IsAdmin)
            {
                return Problem(
                    detail: "Admin privileges required",
                    statusCode: StatusCodes.Status403Forbidden);
            }
        }

        // Rate limit registration attempts per IP (max 5 per hour)
        var ipAddress = HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        var cacheKey = $"register_limit:{ipAddress}";
        if (!_env.IsDevelopment() && !_env.IsEnvironment("Testing"))
        {
            var attempts = _cache.GetOrCreate(cacheKey, entry =>
            {
                entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromHours(1);
                entry.Size = 1;
                return 0;
            });

            if (attempts >= 5)
            {
                _logger.LogWarning("Registration rate limited for IP {IpAddress}", ipAddress);
                Response.Headers.RetryAfter = "3600";
                return Problem(
                    statusCode: StatusCodes.Status429TooManyRequests,
                    title: "Too many requests",
                    detail: "Too many registration attempts. Please try again later.");
            }

            _cache.Set(cacheKey, attempts + 1, new MemoryCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = TimeSpan.FromHours(1),
                Size = 1,
            });
        }

        // Check if user already exists
        var existingUser = await _db.Users.AnyAsync(u => u.AuthSub == request.Username);
        if (existingUser)
        {
            return Problem(
                detail: "Username already exists",
                statusCode: StatusCodes.Status409Conflict);
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
            {
                return Problem(
                    detail: "UserSalt must be 16 bytes",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            if (accountSalt.Length != 16)
            {
                return Problem(
                    detail: "AccountSalt must be 16 bytes",
                    statusCode: StatusCodes.Status400BadRequest);
            }
        }
        catch (FormatException)
        {
            return Problem(
                detail: "Invalid base64 encoding",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Check if this is the first user (make them admin)
        // Note: isFirstUser was already determined above for the admin auth check

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
            KdfMemoryKib = (int)request.KdfMemoryKib,
            KdfIterations = request.KdfIterations,
            KdfParallelism = request.KdfParallelism,
            KdfAlgVersion = request.KdfAlgVersion,
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

        _logger.UserRegistered(request.Username);

        return Created($"/api/v1/users/{user.Id}", new { id = user.Id, username = user.AuthSub, isAdmin = isFirstUser });
    }

    /// <summary>
    /// Logout - revoke current session.
    /// </summary>
    [HttpPost("logout")]
    public async Task<IActionResult> Logout()
    {
        // Return 404 when not in LocalAuth mode
        if (!_isLocalAuthMode)
        {
            return NotFound();
        }

        var sessionToken = GetSessionToken();
        if (sessionToken == null)
        {
            return Ok(new { message = "Already logged out" });
        }

        var tokenHash = SHA256.HashData(sessionToken);
        var session = await _db.Sessions.FirstOrDefaultAsync(s => s.TokenHash == tokenHash);
        if (session != null)
        {
            session.RevokedAt = _timeProvider.GetUtcNow().UtcDateTime;
            await _db.SaveChangesAsync();

            // D1 audit: record logout. ActorUserId is the session's
            // owner so we have a clean per-user logout trail.
            if (_auditLog is not null)
            {
                await _auditLog.WriteAsync(
                    AuditEventTypes.AuthLogout,
                    AuditOutcomes.Success,
                    HttpContext,
                    actorUserId: session.UserId);
            }
        }

        // Clear cookie - use same settings as when setting the cookie
        var isSecure = !_env.IsDevelopment() && !_env.EnvironmentName.Equals("Testing", StringComparison.OrdinalIgnoreCase);
        Response.Cookies.Delete("mosaic_session", new CookieOptions
        {
            HttpOnly = true,
            Secure = isSecure,
            SameSite = isSecure ? SameSiteMode.Strict : SameSiteMode.Lax,
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
        // Return 404 when not in LocalAuth mode
        if (!_isLocalAuthMode)
        {
            return NotFound();
        }

        var userId = await GetCurrentUserIdAsync();
        if (userId == null)
        {
            return Unauthorized();
        }

        // Get current token hash ONCE before the query to avoid timing attacks
        var currentTokenHash = GetCurrentTokenHash();

        // Load session data without IsCurrent flag (can't do constant-time comparison in SQL)
        var sessionsData = await _db.Sessions
            .AsNoTracking()
            .Where(s => s.UserId == userId && s.RevokedAt == null && s.ExpiresAt > _timeProvider.GetUtcNow().UtcDateTime)
            .OrderByDescending(s => s.LastSeenAt)
            .Select(s => new
            {
                s.Id,
                s.DeviceName,
                s.IpAddress,
                s.CreatedAt,
                s.LastSeenAt,
                s.TokenHash
            })
            .ToListAsync();

        // Map with constant-time comparison to prevent timing attacks
        var sessions = sessionsData.Select(s => new
        {
            s.Id,
            s.DeviceName,
            s.IpAddress,
            s.CreatedAt,
            s.LastSeenAt,
            IsCurrent = currentTokenHash != null &&
                       CryptographicOperations.FixedTimeEquals(s.TokenHash, currentTokenHash)
        }).ToList();

        return Ok(sessions);
    }

    /// <summary>
    /// Revoke a specific session.
    /// </summary>
    [HttpDelete("sessions/{sessionId}")]
    public async Task<IActionResult> RevokeSession(Guid sessionId)
    {
        // Return 404 when not in LocalAuth mode
        if (!_isLocalAuthMode)
        {
            return NotFound();
        }

        var userId = await GetCurrentUserIdAsync();
        if (userId == null)
        {
            return Unauthorized();
        }

        var session = await _db.Sessions.FirstOrDefaultAsync(s => s.Id == sessionId && s.UserId == userId);
        if (session == null)
        {
            return NotFound();
        }

        session.RevokedAt = _timeProvider.GetUtcNow().UtcDateTime;
        await _db.SaveChangesAsync();

        return Ok(new { message = "Session revoked" });
    }

    /// <summary>
    /// Revoke all sessions except current.
    /// </summary>
    [HttpPost("sessions/revoke-others")]
    public async Task<IActionResult> RevokeOtherSessions()
    {
        // Return 404 when not in LocalAuth mode
        if (!_isLocalAuthMode)
        {
            return NotFound();
        }

        var userId = await GetCurrentUserIdAsync();
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
            session.RevokedAt = _timeProvider.GetUtcNow().UtcDateTime;
        }
        await _db.SaveChangesAsync();

        return Ok(new { revokedCount = sessionsToRevoke.Count });
    }

    // ===== Helper Methods =====

    /// <summary>
    /// Rotate the caller's password-derived key material (v1.0.x s38).
    ///
    /// <para>
    /// Requires LocalAuth mode and an active session. The caller must supply
    /// a fresh challenge id + signature over the current AuthPubkey, then the
    /// new <c>UserSalt</c>, <c>AuthPubkey</c>, and wrapped L2 account key.
    /// The server replaces all three atomically, bumps <c>SaltVersion</c>,
    /// and revokes every other active session so a stolen cookie cannot
    /// outlive the password change.
    /// </para>
    ///
    /// <para>
    /// Returns the new <c>SaltVersion</c> and the count of sessions revoked.
    /// </para>
    /// </summary>
    [HttpPost("password-rotation")]
    [ProducesResponseType<PasswordRotationResponse>(StatusCodes.Status200OK)]
    public async Task<IActionResult> RotatePassword([FromBody] PasswordRotationRequest request)
    {
        if (!_isLocalAuthMode)
        {
            return Problem(
                title: "Local authentication disabled",
                detail: "This endpoint is only available when local authentication is enabled.",
                statusCode: StatusCodes.Status404NotFound);
        }

        var userId = await GetCurrentUserIdAsync();
        if (userId is null)
        {
            return Unauthorized();
        }

        var user = await _db.Users.FirstOrDefaultAsync(u => u.Id == userId.Value);
        if (user is null || string.IsNullOrEmpty(user.AuthPubkey))
        {
            // No local-auth material to rotate — treat as not-applicable.
            return Problem(
                detail: "User does not have local authentication enabled",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Decode all incoming key material up-front so a bad encoding fails
        // BEFORE we mutate any state.
        byte[] newUserSalt;
        byte[] newWrappedAccountKey;
        byte[] currentSignature;
        byte[] currentPubkey;
        byte[] newAuthPubkey;
        try
        {
            newUserSalt = Convert.FromBase64String(request.NewUserSalt);
            newWrappedAccountKey = Convert.FromBase64String(request.NewWrappedAccountKey);
            currentSignature = Convert.FromBase64String(request.CurrentSignature);
            currentPubkey = Convert.FromBase64String(user.AuthPubkey);
            newAuthPubkey = Convert.FromBase64String(request.NewAuthPubkey);
        }
        catch (FormatException)
        {
            return Problem(
                detail: "Invalid base64 encoding in request",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (newUserSalt.Length != 16)
        {
            return Problem(
                detail: "newUserSalt must decode to exactly 16 bytes",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (newAuthPubkey.Length != 32)
        {
            return Problem(
                detail: "newAuthPubkey must decode to exactly 32 bytes",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Wrapped L2 envelope: 24-byte nonce + ≥32-byte ciphertext + 16-byte tag.
        if (newWrappedAccountKey.Length < 48)
        {
            return Problem(
                detail: "newWrappedAccountKey is too short",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (currentSignature.Length != 64 || currentPubkey.Length != 32)
        {
            return Problem(
                detail: "Malformed signature material",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        // Look up + claim the challenge atomically.
        var challenge = await _db.AuthChallenges
            .FirstOrDefaultAsync(c => c.Id == request.ChallengeId);
        var now = _timeProvider.GetUtcNow().UtcDateTime;
        if (challenge is null || challenge.ExpiresAt <= now || challenge.IsUsed)
        {
            return Problem(
                detail: "Invalid or expired challenge",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        if (!string.Equals(challenge.Username, user.AuthSub, StringComparison.Ordinal))
        {
            return Problem(
                detail: "Challenge does not match caller",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        var claimed = await TryClaimAuthChallengeAsync(request.ChallengeId, now);
        if (!claimed)
        {
            return Problem(
                detail: "Challenge already used",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        // Verify the signature against the CURRENT AuthPubkey — proves the
        // caller still knows the current password.
        bool signatureValid;
        try
        {
            var transcript = AuthChallengeTranscriptBuilder.BuildTranscript(
                user.AuthSub, challenge.Challenge, request.Timestamp);
            signatureValid = _rustHost.VerifyAuthChallenge(transcript, currentSignature, currentPubkey);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Password-rotation signature verification crashed for user {UserId}", user.Id);
            if (_auditLog is not null)
            {
                await _auditLog.WriteAsync(
                    AuditEventTypes.AuthLoginFailed,
                    AuditOutcomes.Error,
                    HttpContext,
                    actorUserId: user.Id,
                    details: new { reason = "rotation-verify-crash" });
            }
            return Problem(
                detail: "Signature verification failed",
                statusCode: StatusCodes.Status500InternalServerError);
        }

        if (!signatureValid)
        {
            _metrics?.RecordAuthFailure();
            if (_auditLog is not null)
            {
                await _auditLog.WriteAsync(
                    AuditEventTypes.AuthLoginFailed,
                    AuditOutcomes.Denied,
                    HttpContext,
                    actorUserId: user.Id,
                    details: new { reason = "rotation-invalid-signature" });
            }
            return Problem(
                detail: "Invalid signature",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        // Atomic swap: bump key material + SaltVersion + revoke other sessions.
        // Capture SaltVersion BEFORE the transaction so we can detect a concurrent
        // rotation that lands between our initial user-load and our own commit
        // (security-review-2026-05-19-05: last-writer-wins credential race).
        var currentTokenHash = GetCurrentTokenHash();
        var originalSaltVersion = user.SaltVersion;
        int revokedCount = 0;
        IActionResult? earlyExit = null;

        var supportsTx = _db.Database.IsRelational();

        // Bounded retry on PostgreSQL serialization failures (40001) and
        // deadlocks (40P01). Better UX than asking the client to re-derive a
        // fresh challenge + Argon2id-derived keys.
        // (security-review-2026-05-19-07)
        const int MaxRotationAttempts = 4;
        var rotationBackoffsMs = new[] { 250, 500, 1000 };
        // Honor request abort. If the client disconnects mid-retry, stop
        // burning CPU/DB on a rotation no one is waiting for. Falls back to
        // CancellationToken.None when HttpContext is unavailable (unit tests).
        // (security-review-2026-05-19-15)
        var rotationCt = HttpContext?.RequestAborted ?? CancellationToken.None;

        for (int attempt = 0; attempt < MaxRotationAttempts; attempt++)
        {
            earlyExit = null;
            revokedCount = 0;

            // Refresh `now` at the START of every attempt. A session whose
            // absolute or sliding expiry boundary is crossed during retry
            // backoff must NOT pass the in-tx re-check just because the
            // request-entry timestamp captured below at line 861 still
            // pre-dates the boundary (security-review-2026-05-19-09).
            var attemptNow = _timeProvider.GetUtcNow().UtcDateTime;

            Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction? tx = null;
            if (supportsTx)
            {
                tx = await _db.Database.BeginTransactionAsync(System.Data.IsolationLevel.Serializable);
            }

            try
            {
                // Re-read the user under the (Serializable) transaction. ReloadAsync
                // also discards any unsaved mutations from a previous failed attempt
                // (e.g. UserSalt/AuthPubkey/WrappedAccountKey/SaltVersion writes from
                // a rolled-back retry), restoring fresh DB state.
                await _db.Entry(user).ReloadAsync();
                if (user.SaltVersion != originalSaltVersion)
                {
                    earlyExit = Problem(
                        title: "Concurrent password rotation detected",
                        detail: "Another password rotation completed before this one could commit. Retry with a fresh challenge.",
                        statusCode: StatusCodes.Status409Conflict);
                }
                else if (currentTokenHash != null)
                {
                    // Re-verify the caller's session is still active under the
                    // SAME predicate used by GetCurrentUserIdAsync (revocation +
                    // absolute expiry + sliding expiry), evaluated against the
                    // fresh `attemptNow`. A concurrent rotation may have revoked
                    // it, or the session may have expired between request entry
                    // and this attempt's commit; if so the caller no longer has
                    // standing to rotate credentials.
                    // (security-review-2026-05-19-06, -09)
                    var stillActive = await ActiveSessionsQuery(currentTokenHash, attemptNow)
                        .AnyAsync(s => s.UserId == user.Id);
                    if (!stillActive)
                    {
                        earlyExit = Unauthorized();
                    }
                }

                if (earlyExit != null)
                {
                    revokedCount = 0;
                    if (tx is not null)
                    {
                        await tx.RollbackAsync();
                    }
                }
                else
                {
                    user.UserSalt = newUserSalt;
                    user.AuthPubkey = request.NewAuthPubkey;
                    user.WrappedAccountKey = newWrappedAccountKey;
                    user.SaltVersion = user.SaltVersion + 1;

                    var sessionsToRevoke = await _db.Sessions
                        .Where(s => s.UserId == user.Id
                            && s.RevokedAt == null
                            && (currentTokenHash == null || s.TokenHash != currentTokenHash))
                        .ToListAsync();

                    foreach (var s in sessionsToRevoke)
                    {
                        s.RevokedAt = attemptNow;
                    }
                    revokedCount = sessionsToRevoke.Count;

                    await _db.SaveChangesAsync();
                    if (tx is not null)
                    {
                        await tx.CommitAsync();
                    }
                }

                break; // success (or non-retryable earlyExit) — leave the retry loop
            }
            catch (Exception ex) when (
                IsRetryablePostgresConflict(ex) && attempt + 1 < MaxRotationAttempts)
            {
                if (tx is not null)
                {
                    await tx.RollbackAsync();
                }
                var backoffMs = ComputeRotationBackoffMs(rotationBackoffsMs[attempt]);
                _logger.LogWarning(ex,
                    "Password rotation hit serialization/deadlock conflict for user {UserId} on attempt {Attempt}; retrying after {BackoffMs}ms (jittered from base {BaseMs}ms)",
                    user.Id, attempt + 1, backoffMs, rotationBackoffsMs[attempt]);
                await Task.Delay(backoffMs, rotationCt);
                continue;
            }
            catch (Exception ex) when (IsRetryablePostgresConflict(ex))
            {
                // Retries exhausted — surface a clean 409 instead of a raw 500.
                if (tx is not null)
                {
                    await tx.RollbackAsync();
                }
                _logger.LogWarning(ex,
                    "Password rotation exhausted {MaxAttempts} retries on serialization/deadlock conflict for user {UserId}",
                    MaxRotationAttempts, user.Id);
                earlyExit = Problem(
                    title: "Concurrent password rotation detected",
                    detail: "The database could not serialize this rotation against a concurrent transaction. Retry with a fresh challenge.",
                    statusCode: StatusCodes.Status409Conflict);
                break;
            }
            catch
            {
                if (tx is not null)
                {
                    await tx.RollbackAsync();
                }
                throw;
            }
            finally
            {
                if (tx is not null)
                {
                    await tx.DisposeAsync();
                }
            }
        }

        if (earlyExit != null)
        {
            if (_auditLog is not null)
            {
                await _auditLog.WriteAsync(
                    AuditEventTypes.AuthLoginFailed,
                    AuditOutcomes.Denied,
                    HttpContext,
                    actorUserId: user.Id,
                    details: new { reason = "rotation-stale-state" });
            }
            return earlyExit;
        }

        if (_auditLog is not null)
        {
            await _auditLog.WriteAsync(
                AuditEventTypes.AuthLoginSucceeded,
                AuditOutcomes.Success,
                HttpContext,
                actorUserId: user.Id,
                details: new
                {
                    action = "password-rotation",
                    saltVersion = user.SaltVersion,
                    revokedSessions = revokedCount,
                });
        }

        return Ok(new PasswordRotationResponse(user.SaltVersion, revokedCount));
    }

    // ===== Helper Methods (continued) =====

    private async Task<bool> TryClaimAuthChallengeAsync(Guid challengeId, DateTime now)
    {
        if (_db.Database.IsRelational())
        {
            var affected = await _db.AuthChallenges
                .Where(c => c.Id == challengeId && !c.IsUsed && c.ExpiresAt > now)
                .ExecuteUpdateAsync(setters => setters.SetProperty(c => c.IsUsed, true));

            return affected == 1;
        }

        var challenge = await _db.AuthChallenges.FirstOrDefaultAsync(c => c.Id == challengeId);
        if (challenge == null || challenge.IsUsed || challenge.ExpiresAt <= now)
        {
            return false;
        }

        challenge.IsUsed = true;
        await _db.SaveChangesAsync();
        return true;
    }

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

    private async Task<Guid?> GetCurrentUserIdAsync()
    {
        var token = GetSessionToken();
        if (token == null)
        {
            return null;
        }

        var tokenHash = SHA256.HashData(token);
        var now = _timeProvider.GetUtcNow().UtcDateTime;

        // Single source of truth for session validity (revoked / absolute /
        // sliding expiry) — matched against the same predicate the rotation
        // in-transaction re-check uses (security-review-2026-05-19-09).
        var session = await ActiveSessionsQuery(tokenHash, now)
            .FirstOrDefaultAsync();

        if (session == null)
        {
            return null;
        }

        session.LastSeenAt = now;
        await _db.SaveChangesAsync();

        return session.UserId;
    }

    /// <summary>
    /// Returns the set of sessions matching <paramref name="tokenHash"/> that
    /// are still valid as of <paramref name="now"/> — not revoked, before
    /// absolute expiry, and within the sliding window. Centralising this
    /// predicate guarantees that the auth gate (<see cref="GetCurrentUserIdAsync"/>)
    /// and the in-transaction password-rotation re-check evaluate identical
    /// criteria, eliminating the stale-<c>now</c> drift between request entry
    /// and rotation commit (security-review-2026-05-19-09).
    /// </summary>
    private IQueryable<Session> ActiveSessionsQuery(byte[] tokenHash, DateTime now)
    {
        var slidingCutoff = now.Add(-SessionSlidingExpiry);
        return _db.Sessions.Where(s =>
            s.TokenHash == tokenHash &&
            s.RevokedAt == null &&
            s.ExpiresAt > now &&
            s.LastSeenAt >= slidingCutoff);
    }

    // Random fallback secret generated once per process lifetime.
    // Used only when Auth:ServerSecret is not configured (should not happen - Program.cs sets it).
    private static readonly Lazy<byte[]> FallbackServerSecret = new(() => RandomNumberGenerator.GetBytes(32));

    // PostgreSQL conflict detection for the rotation retry loop. Covers:
    //   * 40001 (serialization_failure)   — SSI rolled back our transaction.
    //   * 40P01 (deadlock_detected)       — circular row-lock dependency.
    //   * 55P03 (lock_not_available)      — row lock could not be acquired
    //     within `lock_timeout`. Without this, any deployment that sets a
    //     non-zero `lock_timeout` on the connection (e.g. tenant connection
    //     pooler defaults) would surface a raw 500 instead of retrying.
    //     (security-review-2026-05-19-11)
    // EF wraps the underlying Npgsql exception in DbUpdateException for write
    // failures; unwrap and inspect the SqlState.
    private static readonly HashSet<string> RetryableSqlStates = new(StringComparer.Ordinal)
    {
        "40001",
        "40P01",
        "55P03",
    };

    private static bool IsRetryablePostgresConflict(Exception ex)
    {
        for (var e = ex; e != null; e = e.InnerException!)
        {
            if (e is Npgsql.PostgresException pex &&
                RetryableSqlStates.Contains(pex.SqlState))
            {
                return true;
            }
            if (e.InnerException == null)
            {
                break;
            }
        }
        return false;
    }

    /// <summary>
    /// Computes a jittered backoff delay for the password-rotation retry
    /// loop. Returns a value in the closed interval <c>[baseMs, baseMs * 1.5]</c>:
    /// the original base delay plus 0..50% additional jitter. The jitter
    /// desynchronizes retry timing across concurrent rotations so that two
    /// rotations that just collided do not retry in lock-step and collide
    /// again on identical schedules (retry-storm avoidance).
    /// (security-review-2026-05-19-15)
    /// </summary>
    /// <param name="baseMs">The base delay in milliseconds. Must be non-negative.</param>
    /// <returns>The jittered delay in milliseconds; 0 when <paramref name="baseMs"/> is non-positive.</returns>
    internal static int ComputeRotationBackoffMs(int baseMs)
    {
        if (baseMs <= 0)
        {
            return 0;
        }
        // Random.Shared.Next(0, max) returns [0, max) so use baseMs/2 + 1 as
        // the exclusive upper bound to make the closed interval [0, baseMs/2]
        // reachable. Resulting delay range: [baseMs, baseMs + baseMs/2].
        return baseMs + Random.Shared.Next(0, baseMs / 2 + 1);
    }

    private byte[] GenerateFakeSalt(string username)
    {
        var serverSecretBase64 = _config["Auth:ServerSecret"];
        byte[] serverSecret;

        if (string.IsNullOrEmpty(serverSecretBase64))
        {
            // No configured secret - use random fallback (non-deterministic, changes on restart)
            serverSecret = FallbackServerSecret.Value;
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

        var message = AuthChallengeTranscriptBuilder.BuildTranscript(username, challenge, timestamp);
        return _rustHost.VerifyAuthChallenge(message, signature, pubkey);
    }

    private static string? ParseDeviceName(string userAgent)
    {
        if (string.IsNullOrEmpty(userAgent))
        {
            return null;
        }

        // Simple device name extraction
        if (userAgent.Contains("Windows"))
        {
            return "Windows";
        }

        if (userAgent.Contains("Macintosh"))
        {
            return "Mac";
        }

        if (userAgent.Contains("Linux"))
        {
            return "Linux";
        }

        if (userAgent.Contains("iPhone"))
        {
            return "iPhone";
        }

        if (userAgent.Contains("iPad"))
        {
            return "iPad";
        }

        if (userAgent.Contains("Android"))
        {
            return "Android";
        }

        return "Unknown";
    }

    private async Task CleanupExpiredChallengesAsync()
    {
        // Delete challenges older than 5 minutes
        var cutoff = _timeProvider.GetUtcNow().UtcDateTime.AddMinutes(-5);

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

}

using System.Security.Cryptography;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Crypto;
using Mosaic.Backend.Data;
using Mosaic.Backend.Models.Users;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/v1/users")]
public class UsersController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IConfiguration _config;
    private readonly ICurrentUserService _currentUserService;
    private readonly IUserErasureService? _userErasure;
    private readonly IAuditLogService? _auditLog;
    private readonly RustCoreHost? _rustHost;
    private readonly ILogger<UsersController> _logger;
    private readonly IWebHostEnvironment _env;

    public UsersController(
        MosaicDbContext db,
        IConfiguration config,
        ICurrentUserService currentUserService,
        ILogger<UsersController>? logger = null,
        IWebHostEnvironment? env = null,
        IUserErasureService? userErasure = null,
        RustCoreHost? rustHost = null,
        IAuditLogService? auditLog = null)
    {
        _db = db;
        _config = config;
        _currentUserService = currentUserService;
        _userErasure = userErasure;
        _logger = logger ?? Microsoft.Extensions.Logging.Abstractions.NullLogger<UsersController>.Instance;
        _env = env ?? new NullWebHostEnvironment();
        _rustHost = rustHost;
        _auditLog = auditLog;
    }

    private sealed class NullWebHostEnvironment : IWebHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Production";
        public string ApplicationName { get; set; } = "Mosaic.Backend";
        public string WebRootPath { get; set; } = "";
        public Microsoft.Extensions.FileProviders.IFileProvider WebRootFileProvider { get; set; }
            = new Microsoft.Extensions.FileProviders.NullFileProvider();
        public string ContentRootPath { get; set; } = "";
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; }
            = new Microsoft.Extensions.FileProviders.NullFileProvider();
    }

    /// <summary>
    /// Get current user profile
    /// </summary>
    [HttpGet("me")]
    public async Task<IActionResult> GetMe()
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);
        var quota = await _db.UserQuotas.FindAsync(user.Id);

        return Ok(new
        {
            user.Id,
            user.AuthSub,
            user.IdentityPubkey,
            user.CreatedAt,
            user.IsAdmin,
            EncryptedSalt = user.EncryptedSalt != null ? Convert.ToBase64String(user.EncryptedSalt) : null,
            SaltNonce = user.SaltNonce != null ? Convert.ToBase64String(user.SaltNonce) : null,
            AccountSalt = user.AccountSalt != null ? Convert.ToBase64String(user.AccountSalt) : null,
            WrappedAccountKey = user.WrappedAccountKey != null ? Convert.ToBase64String(user.WrappedAccountKey) : null,
            user.KdfMemoryKib,
            user.KdfIterations,
            user.KdfParallelism,
            user.KdfAlgVersion,
            Quota = quota != null ? new
            {
                quota.MaxStorageBytes,
                quota.UsedStorageBytes
            } : null
        });
    }


    /// <summary>
    /// Update user profile (identity pubkey and/or encrypted salt)
    /// </summary>
    [HttpPut("me")]
    public async Task<IActionResult> UpdateMe([FromBody] UpdateUserRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Update identity pubkey if provided
        if (request.IdentityPubkey != null)
        {
            // Only allow setting identity pubkey once (or if empty)
            if (!string.IsNullOrEmpty(user.IdentityPubkey) && user.IdentityPubkey != request.IdentityPubkey)
            {
                return Problem(
                    detail: "Identity pubkey already set",
                    statusCode: StatusCodes.Status400BadRequest);
            }
            user.IdentityPubkey = request.IdentityPubkey;
        }

        // Update encrypted salt if provided
        if (request.EncryptedSalt != null && request.SaltNonce != null)
        {
            try
            {
                var encryptedSaltBytes = Convert.FromBase64String(request.EncryptedSalt);
                var saltNonceBytes = Convert.FromBase64String(request.SaltNonce);

                // Validate lengths: encrypted salt should be 16 bytes + 16 bytes auth tag = 32 bytes
                // Nonce should be 12 bytes for AES-GCM
                if (saltNonceBytes.Length != 12)
                {
                    return Problem(
                        detail: "Invalid salt nonce length, expected 12 bytes",
                        statusCode: StatusCodes.Status400BadRequest);
                }
                if (encryptedSaltBytes.Length < 16)
                {
                    return Problem(
                        detail: "Invalid encrypted salt length",
                        statusCode: StatusCodes.Status400BadRequest);
                }

                user.EncryptedSalt = encryptedSaltBytes;
                user.SaltNonce = saltNonceBytes;
            }
            catch (FormatException)
            {
                return Problem(
                    detail: "Invalid base64 encoding for salt or nonce",
                    statusCode: StatusCodes.Status400BadRequest);
            }
        }
        else if (request.EncryptedSalt != null || request.SaltNonce != null)
        {
            // Both must be provided together
            return Problem(
                detail: "Both encryptedSalt and saltNonce must be provided together",
                statusCode: StatusCodes.Status400BadRequest);
        }

        await _db.SaveChangesAsync();

        return Ok(new
        {
            user.Id,
            user.AuthSub,
            user.IdentityPubkey,
            user.CreatedAt,
            EncryptedSalt = user.EncryptedSalt != null ? Convert.ToBase64String(user.EncryptedSalt) : null,
            SaltNonce = user.SaltNonce != null ? Convert.ToBase64String(user.SaltNonce) : null
        });
    }


    /// <summary>
    /// Update user's wrapped account key (for identity persistence across sessions)
    /// </summary>
    [HttpPut("me/wrapped-key")]
    [ProducesResponseType<WrappedKeyUpdateResponse>(StatusCodes.Status200OK)]
    public async Task<IActionResult> UpdateWrappedKey([FromBody] UpdateWrappedKeyRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        try
        {
            var wrappedKeyBytes = Convert.FromBase64String(request.WrappedAccountKey);

            // Validate length: wrapped key should be 24 nonce + 32 key + 16 tag = 72 bytes
            if (wrappedKeyBytes.Length < 48)
            {
                return Problem(
                    detail: "Invalid wrapped key length",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            user.WrappedAccountKey = wrappedKeyBytes;
            await _db.SaveChangesAsync();

            return Ok(new WrappedKeyUpdateResponse(true));
        }
        catch (FormatException)
        {
            return Problem(
                detail: "Invalid base64 encoding for wrapped key",
                statusCode: StatusCodes.Status400BadRequest);
        }
    }

    /// <summary>
    /// Get a user's public info (for key exchange)
    /// </summary>
    [HttpGet("{userId:guid}")]
    public async Task<IActionResult> GetUser(Guid userId)
    {
        var user = await _db.Users.FindAsync(userId);
        if (user == null)
        {
            return Problem(
                detail: "User not found",
                statusCode: StatusCodes.Status404NotFound);
        }

        return Ok(new
        {
            user.Id,
            user.IdentityPubkey
        });
    }

    /// <summary>
    /// Look up user by identity public key
    /// </summary>
    [HttpGet("by-pubkey/{pubkey}")]
    public async Task<IActionResult> GetUserByPubkey(string pubkey)
    {
        // pubkey is base64-encoded, URL encoding handled by ASP.NET Core
        var user = await _db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.IdentityPubkey == pubkey);
        if (user == null)
        {
            return Problem(
                detail: "User not found",
                statusCode: StatusCodes.Status404NotFound);
        }

        return Ok(new
        {
            user.Id,
            user.IdentityPubkey
        });
    }

    /// <summary>
    /// GDPR Article 17 self-service right-to-erasure (v1.0.1 s15).
    ///
    /// <para>
    /// Permanently deletes the caller's account, their owned albums and all
    /// shards, their memberships on other albums, share links they created,
    /// sessions, auth challenges, idempotency records, in-flight Tus
    /// uploads, and the encrypted blobs on disk. Audit log entries are
    /// anonymised in place (kept under legitimate-interest basis for
    /// security incident response).
    /// </para>
    ///
    /// <para>
    /// Two guards must be satisfied:
    /// </para>
    ///
    /// <list type="bullet">
    ///   <item><description>
    ///     <c>confirmationText</c> in the body MUST equal the caller's
    ///     username (<see cref="User.AuthSub"/>). This is the type-your-name
    ///     defence against accidental clicks.
    ///   </description></item>
    ///   <item><description>
    ///     In LocalAuth mode, <c>challengeId</c> + <c>confirmationSignature</c>
    ///     MUST be a fresh, single-use Ed25519 signature over the standard
    ///     auth challenge transcript — proving the caller still holds the
    ///     password-derived auth key, not just a stolen session cookie. The
    ///     pair is optional in ProxyAuth mode because the upstream
    ///     identity provider already re-authenticates each request.
    ///   </description></item>
    /// </list>
    ///
    /// <para>
    /// Returns <c>204 No Content</c> on success and clears the session
    /// cookie. The client is expected to wipe local IDB / OPFS / cookie
    /// state immediately after receiving 204.
    /// </para>
    /// </summary>
    [HttpDelete("me")]
    public async Task<IActionResult> DeleteMe([FromBody] DeleteMeRequest request)
    {
        // Per-request DataAnnotations are enforced by [ApiController] but
        // the inert default values mean we need to re-check ConfirmationText
        // explicitly for the empty-string case.
        if (string.IsNullOrWhiteSpace(request.ConfirmationText))
        {
            return Problem(
                detail: "Confirmation text is required",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Guard #1 — type-your-username confirmation. We compare with the
        // user's AuthSub (the stable login identity). Constant-time-style
        // equality here is overkill — the comparison is against the user's
        // own username, not a secret — but using OrdinalIgnoreCase would
        // be wrong because AuthSub is case-sensitive.
        if (!string.Equals(request.ConfirmationText, user.AuthSub, StringComparison.Ordinal))
        {
            if (_auditLog is not null)
            {
                await _auditLog.WriteAsync(
                    AuditEventTypes.UserSelfErased,
                    AuditOutcomes.Denied,
                    HttpContext,
                    actorUserId: user.Id,
                    targetType: "user",
                    targetId: user.Id.ToString(),
                    details: new { reason = "confirmation-mismatch" });
            }
            return Problem(
                detail: "Confirmation text does not match username",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Guard #2 — fresh-auth attestation (LocalAuth only).
        var isLocalAuth = IsLocalAuthMode();
        if (isLocalAuth)
        {
            var freshAuthError = await VerifyFreshAuthAsync(request, user);
            if (freshAuthError is not null)
            {
                if (_auditLog is not null)
                {
                    await _auditLog.WriteAsync(
                        AuditEventTypes.UserSelfErased,
                        AuditOutcomes.Denied,
                        HttpContext,
                        actorUserId: user.Id,
                        targetType: "user",
                        targetId: user.Id.ToString(),
                        details: new { reason = freshAuthError });
                }
                return Problem(
                    detail: "Fresh authentication required",
                    statusCode: StatusCodes.Status403Forbidden);
            }
        }

        // Both guards passed — run the cascade.
        if (_userErasure is null)
        {
            _logger.LogError("IUserErasureService not registered; cannot satisfy DELETE /me");
            return Problem(
                detail: "Account erasure service unavailable",
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }

        var userId = user.Id;
        var authSub = user.AuthSub;
        UserErasureResult result;
        try
        {
            result = await _userErasure.EraseAsync(userId, HttpContext.RequestAborted);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "User erasure failed for {UserId}", userId);
            if (_auditLog is not null)
            {
                await _auditLog.WriteAsync(
                    AuditEventTypes.UserSelfErased,
                    AuditOutcomes.Error,
                    HttpContext,
                    actorUserId: userId,
                    targetType: "user",
                    targetId: userId.ToString(),
                    details: new { reason = "erasure-failed" });
            }
            return Problem(
                detail: "Failed to erase account",
                statusCode: StatusCodes.Status500InternalServerError);
        }

        // Audit AFTER the cascade so the row records what actually
        // happened. The cascade anonymises pre-existing audit rows for
        // this user; the row we write here lands AFTER and is the only
        // one that retains an ActorUserId — but the audit service writes
        // it as the (now-deleted) user id. That's the desired forensic
        // marker: a single "user.erased" row with the user id, followed
        // by no further activity from that id.
        if (_auditLog is not null)
        {
            await _auditLog.WriteAsync(
                AuditEventTypes.UserSelfErased,
                AuditOutcomes.Success,
                HttpContext,
                actorUserId: userId,
                targetType: "user",
                targetId: userId.ToString(),
                details: new
                {
                    username = authSub,
                    ownedAlbums = result.OwnedAlbumsDeleted,
                    memberships = result.MembershipsDeleted,
                    sessions = result.SessionsDeleted,
                    shards = result.ShardsDeleted,
                    blobsDeleted = result.BlobsDeleted,
                    blobsFailed = result.BlobsFailed,
                    tusFiles = result.TusFilesDeleted,
                    auditAnonymised = result.AuditEntriesAnonymised
                });
        }

        // Clear the session cookie on the response. The Session row was
        // already cascade-deleted, so even without the cookie clear the
        // client can no longer authenticate — but stripping the cookie
        // closes the small window where a cached browser might keep
        // sending it to a 401-returning endpoint.
        var isSecure = !_env.IsDevelopment() && !_env.EnvironmentName.Equals("Testing", StringComparison.OrdinalIgnoreCase);
        Response.Cookies.Delete("mosaic_session", new CookieOptions
        {
            HttpOnly = true,
            Secure = isSecure,
            SameSite = isSecure ? SameSiteMode.Strict : SameSiteMode.Lax,
            Path = "/api"
        });

        return NoContent();
    }

    private bool IsLocalAuthMode()
    {
        var legacyMode = _config["Auth:Mode"];
        if (_config.GetValue<bool?>("Auth:LocalAuthEnabled") != null)
        {
            return _config.GetValue("Auth:LocalAuthEnabled", false);
        }
        if (!string.IsNullOrEmpty(legacyMode))
        {
            return legacyMode.Equals("LocalAuth", StringComparison.OrdinalIgnoreCase);
        }
        return false;
    }

    /// <summary>
    /// Validates the fresh-auth attestation supplied with a <c>DELETE /me</c>
    /// request. Mirrors the verification path in <c>AuthController.VerifyAuth</c>
    /// but does not issue a session — the challenge is single-use and is claimed
    /// inline so it cannot be replayed.
    /// </summary>
    /// <returns>
    /// <c>null</c> when the attestation is valid, otherwise a short reason
    /// string suitable for audit logging.
    /// </returns>
    private async Task<string?> VerifyFreshAuthAsync(DeleteMeRequest request, User user)
    {
        if (request.ChallengeId is null || request.ChallengeId == Guid.Empty
            || string.IsNullOrWhiteSpace(request.ConfirmationSignature))
        {
            return "missing-fresh-auth";
        }

        if (string.IsNullOrEmpty(user.AuthPubkey))
        {
            return "user-has-no-auth-pubkey";
        }

        if (_rustHost is null)
        {
            // Rust verifier isn't wired up — treat as configuration error.
            // Refuse the fresh-auth path rather than silently allowing it.
            return "rust-host-unavailable";
        }

        var now = DateTime.UtcNow;
        var challenge = await _db.AuthChallenges
            .FirstOrDefaultAsync(c => c.Id == request.ChallengeId.Value);
        if (challenge is null || challenge.ExpiresAt <= now || challenge.IsUsed)
        {
            return "challenge-invalid";
        }

        if (!string.Equals(challenge.Username, user.AuthSub, StringComparison.Ordinal))
        {
            return "challenge-username-mismatch";
        }

        // Claim the challenge BEFORE verifying — single-use semantics.
        challenge.IsUsed = true;
        await _db.SaveChangesAsync();

        byte[] signature;
        byte[] pubkey;
        try
        {
            signature = Convert.FromBase64String(request.ConfirmationSignature);
            pubkey = Convert.FromBase64String(user.AuthPubkey);
        }
        catch (FormatException)
        {
            return "signature-malformed";
        }

        if (signature.Length != 64 || pubkey.Length != 32)
        {
            return "signature-malformed";
        }

        var transcript = AuthChallengeTranscriptBuilder.BuildTranscript(
            user.AuthSub,
            challenge.Challenge,
            request.Timestamp);

        try
        {
            return _rustHost.VerifyAuthChallenge(transcript, signature, pubkey)
                ? null
                : "signature-invalid";
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Fresh-auth verification crashed for user {UserId}", user.Id);
            return "signature-verification-error";
        }
    }
}

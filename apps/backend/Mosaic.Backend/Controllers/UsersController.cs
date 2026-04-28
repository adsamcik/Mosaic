using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Models.Users;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/users")]
public class UsersController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IConfiguration _config;
    private readonly ICurrentUserService _currentUserService;

    public UsersController(MosaicDbContext db, IConfiguration config, ICurrentUserService currentUserService)
    {
        _db = db;
        _config = config;
        _currentUserService = currentUserService;
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

            return Ok(new { success = true });
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
}

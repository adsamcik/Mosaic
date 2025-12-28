using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/users")]
public class UsersController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IConfiguration _config;

    public UsersController(MosaicDbContext db, IConfiguration config)
    {
        _db = db;
        _config = config;
    }

    private async Task<User> GetOrCreateUser()
    {
        var authSub = HttpContext.Items["AuthSub"] as string
            ?? throw new UnauthorizedAccessException();

        var user = await _db.Users.FirstOrDefaultAsync(u => u.AuthSub == authSub);
        if (user == null)
        {
            user = new User
            {
                Id = Guid.NewGuid(),
                AuthSub = authSub,
                IdentityPubkey = ""  // Set on first key upload
            };
            _db.Users.Add(user);

            // Create quota
            _db.UserQuotas.Add(new UserQuota
            {
                UserId = user.Id,
                MaxStorageBytes = _config.GetValue<long>("Quota:DefaultMaxBytes")
            });

            await _db.SaveChangesAsync();
        }
        return user;
    }

    /// <summary>
    /// Get current user profile
    /// </summary>
    [HttpGet("me")]
    public async Task<IActionResult> GetMe()
    {
        var user = await GetOrCreateUser();
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
            Quota = quota != null ? new
            {
                quota.MaxStorageBytes,
                quota.UsedStorageBytes
            } : null
        });
    }

    public record UpdateUserRequest(
        string? IdentityPubkey = null,
        string? EncryptedSalt = null,
        string? SaltNonce = null
    );

    /// <summary>
    /// Update user profile (identity pubkey and/or encrypted salt)
    /// </summary>
    [HttpPut("me")]
    public async Task<IActionResult> UpdateMe([FromBody] UpdateUserRequest request)
    {
        var user = await GetOrCreateUser();

        // Update identity pubkey if provided
        if (request.IdentityPubkey != null)
        {
            // Only allow setting identity pubkey once (or if empty)
            if (!string.IsNullOrEmpty(user.IdentityPubkey) && user.IdentityPubkey != request.IdentityPubkey)
            {
                return BadRequest(new { error = "Identity pubkey already set" });
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
                    return BadRequest(new { error = "Invalid salt nonce length, expected 12 bytes" });
                }
                if (encryptedSaltBytes.Length < 16)
                {
                    return BadRequest(new { error = "Invalid encrypted salt length" });
                }

                user.EncryptedSalt = encryptedSaltBytes;
                user.SaltNonce = saltNonceBytes;
            }
            catch (FormatException)
            {
                return BadRequest(new { error = "Invalid base64 encoding for salt or nonce" });
            }
        }
        else if (request.EncryptedSalt != null || request.SaltNonce != null)
        {
            // Both must be provided together
            return BadRequest(new { error = "Both encryptedSalt and saltNonce must be provided together" });
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
    /// Get a user's public info (for key exchange)
    /// </summary>
    [HttpGet("{userId:guid}")]
    public async Task<IActionResult> GetUser(Guid userId)
    {
        var user = await _db.Users.FindAsync(userId);
        if (user == null)
        {
            return NotFound(new { error = "User not found" });
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
        var user = await _db.Users.FirstOrDefaultAsync(u => u.IdentityPubkey == pubkey);
        if (user == null)
        {
            return NotFound(new { error = "User not found" });
        }

        return Ok(new
        {
            user.Id,
            user.IdentityPubkey
        });
    }
}

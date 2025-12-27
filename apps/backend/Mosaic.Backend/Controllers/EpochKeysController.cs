using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/epoch-keys")]
public class EpochKeysController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IConfiguration _config;

    public EpochKeysController(MosaicDbContext db, IConfiguration config)
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
                IdentityPubkey = ""
            };
            _db.Users.Add(user);
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
    /// Get epoch keys for albums the current user has access to
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] Guid? albumId)
    {
        var user = await GetOrCreateUser();

        var query = _db.EpochKeys.Where(ek => ek.RecipientId == user.Id);

        if (albumId.HasValue)
        {
            query = query.Where(ek => ek.AlbumId == albumId.Value);
        }

        var keys = await query
            .Select(ek => new
            {
                ek.Id,
                ek.AlbumId,
                ek.EpochId,
                ek.EncryptedKeyBundle,
                ek.OwnerSignature,
                ek.SharerPubkey,
                ek.SignPubkey,
                ek.CreatedAt
            })
            .ToListAsync();

        return Ok(keys);
    }

    public record CreateEpochKeyRequest(
        Guid AlbumId,
        Guid RecipientId,
        int EpochId,
        byte[] EncryptedKeyBundle,
        byte[] OwnerSignature,
        byte[] SharerPubkey,
        byte[] SignPubkey
    );

    /// <summary>
    /// Create a new epoch key for a recipient
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateEpochKeyRequest request)
    {
        var user = await GetOrCreateUser();

        // Verify album ownership or editor role
        var membership = await _db.AlbumMembers
            .FirstOrDefaultAsync(am =>
                am.AlbumId == request.AlbumId &&
                am.UserId == user.Id &&
                am.RevokedAt == null);

        if (membership == null) return Forbid();
        if (membership.Role != "owner" && membership.Role != "editor")
            return Forbid();

        // Check recipient exists
        var recipient = await _db.Users.FindAsync(request.RecipientId);
        if (recipient == null) return NotFound("Recipient not found");

        // Check for existing key
        var existing = await _db.EpochKeys
            .FirstOrDefaultAsync(ek =>
                ek.AlbumId == request.AlbumId &&
                ek.RecipientId == request.RecipientId &&
                ek.EpochId == request.EpochId);

        if (existing != null)
            return Conflict("Epoch key already exists for this album/recipient/epoch");

        var epochKey = new EpochKey
        {
            Id = Guid.NewGuid(),
            AlbumId = request.AlbumId,
            RecipientId = request.RecipientId,
            EpochId = request.EpochId,
            EncryptedKeyBundle = request.EncryptedKeyBundle,
            OwnerSignature = request.OwnerSignature,
            SharerPubkey = request.SharerPubkey,
            SignPubkey = request.SignPubkey
        };

        _db.EpochKeys.Add(epochKey);
        await _db.SaveChangesAsync();

        return Created($"/api/epoch-keys/{epochKey.Id}", new
        {
            epochKey.Id,
            epochKey.AlbumId,
            epochKey.RecipientId,
            epochKey.EpochId,
            epochKey.CreatedAt
        });
    }

    /// <summary>
    /// Get a specific epoch key
    /// </summary>
    [HttpGet("{keyId}")]
    public async Task<IActionResult> Get(Guid keyId)
    {
        var user = await GetOrCreateUser();

        var key = await _db.EpochKeys.FindAsync(keyId);
        if (key == null) return NotFound();

        // Only recipient can view
        if (key.RecipientId != user.Id) return Forbid();

        return Ok(new
        {
            key.Id,
            key.AlbumId,
            key.EpochId,
            key.EncryptedKeyBundle,
            key.OwnerSignature,
            key.SharerPubkey,
            key.SignPubkey,
            key.CreatedAt
        });
    }
}

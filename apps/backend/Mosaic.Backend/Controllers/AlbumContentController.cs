using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

/// <summary>
/// Response containing encrypted album content
/// </summary>
public class AlbumContentResponse
{
    /// <summary>
    /// Encrypted content document (blocks, text, etc.)
    /// </summary>
    public required byte[] EncryptedContent { get; set; }

    /// <summary>
    /// 24-byte nonce used for encryption
    /// </summary>
    public required byte[] Nonce { get; set; }

    /// <summary>
    /// Epoch ID used for content encryption
    /// </summary>
    public int EpochId { get; set; }

    /// <summary>
    /// Content version (for optimistic concurrency)
    /// </summary>
    public long Version { get; set; }

    /// <summary>
    /// When the content was last updated
    /// </summary>
    public DateTime UpdatedAt { get; set; }
}

/// <summary>
/// Request to create or update album content
/// </summary>
public class UpdateAlbumContentRequest
{
    /// <summary>
    /// Encrypted content document
    /// </summary>
    [Required]
    [MaxLength(10 * 1024 * 1024)] // 10MB max
    public required byte[] EncryptedContent { get; set; }

    /// <summary>
    /// 24-byte nonce used for encryption
    /// </summary>
    [Required]
    public required byte[] Nonce { get; set; }

    /// <summary>
    /// Epoch ID used for content encryption
    /// </summary>
    public int EpochId { get; set; }

    /// <summary>
    /// Expected current version (0 for new content).
    /// Used for optimistic concurrency control.
    /// </summary>
    public long ExpectedVersion { get; set; }
}

/// <summary>
/// API for managing album content (storytelling blocks, text, etc.)
/// </summary>
[ApiController]
[Route("api/albums/{albumId:guid}/content")]
public class AlbumContentController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly ICurrentUserService _currentUserService;

    public AlbumContentController(
        MosaicDbContext db,
        ICurrentUserService currentUserService)
    {
        _db = db;
        _currentUserService = currentUserService;
    }

    /// <summary>
    /// Get album content
    /// </summary>
    /// <param name="albumId">Album ID</param>
    /// <returns>Encrypted album content</returns>
    [HttpGet]
    [ProducesResponseType<AlbumContentResponse>(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetContent(Guid albumId)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Check album exists
        var album = await _db.Albums.FindAsync(albumId);
        if (album == null)
        {
            return NotFound();
        }

        // Check user is a member
        var membership = await _db.AlbumMembers
            .AsNoTracking()
            .FirstOrDefaultAsync(am =>
                am.AlbumId == albumId &&
                am.UserId == user.Id &&
                am.RevokedAt == null);

        if (membership == null)
        {
            return Forbid();
        }

        // Get content
        var content = await _db.AlbumContents.FindAsync(albumId);
        if (content == null)
        {
            return NotFound();
        }

        return Ok(new AlbumContentResponse
        {
            EncryptedContent = content.EncryptedContent,
            Nonce = content.Nonce,
            EpochId = content.EpochId,
            Version = content.Version,
            UpdatedAt = content.UpdatedAt
        });
    }

    /// <summary>
    /// Create or update album content
    /// </summary>
    /// <param name="albumId">Album ID</param>
    /// <param name="request">Content update request</param>
    /// <returns>Updated content</returns>
    [HttpPut]
    [ProducesResponseType<AlbumContentResponse>(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<IActionResult> PutContent(Guid albumId, [FromBody] UpdateAlbumContentRequest request)
    {
        // Validate nonce length
        if (request.Nonce.Length != 24)
        {
            return BadRequest("Nonce must be exactly 24 bytes");
        }

        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Check album exists
        var album = await _db.Albums.FindAsync(albumId);
        if (album == null)
        {
            return NotFound();
        }

        // Check user is owner or editor
        var membership = await _db.AlbumMembers
            .AsNoTracking()
            .FirstOrDefaultAsync(am =>
                am.AlbumId == albumId &&
                am.UserId == user.Id &&
                am.RevokedAt == null);

        if (membership == null)
        {
            return NotFound();
        }

        // Only owner or editor can update content
        if (membership.Role != "owner" && membership.Role != "editor")
        {
            return Forbid();
        }

        // Get or create content
        var content = await _db.AlbumContents.FindAsync(albumId);

        if (content == null)
        {
            // Create new content
            if (request.ExpectedVersion != 0)
            {
                return Conflict(new { message = "Version mismatch: content does not exist" });
            }

            content = new AlbumContent
            {
                AlbumId = albumId,
                EncryptedContent = request.EncryptedContent,
                Nonce = request.Nonce,
                EpochId = request.EpochId,
                Version = 1,
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow
            };
            _db.AlbumContents.Add(content);
        }
        else
        {
            // Update existing content
            if (content.Version != request.ExpectedVersion)
            {
                return Conflict(new
                {
                    message = $"Version mismatch: expected {request.ExpectedVersion}, current is {content.Version}",
                    currentVersion = content.Version
                });
            }

            content.EncryptedContent = request.EncryptedContent;
            content.Nonce = request.Nonce;
            content.EpochId = request.EpochId;
            content.Version++;
            content.UpdatedAt = DateTime.UtcNow;
        }

        await _db.SaveChangesAsync();

        return Ok(new AlbumContentResponse
        {
            EncryptedContent = content.EncryptedContent,
            Nonce = content.Nonce,
            EpochId = content.EpochId,
            Version = content.Version,
            UpdatedAt = content.UpdatedAt
        });
    }
}

using Mosaic.Backend.Models.Photos;

namespace Mosaic.Backend.Models.ShareLinks;

/// <summary>
/// Per-user share-link enumeration row (v1.0.x s40). Returned by
/// <c>GET /api/v1/users/me/share-links</c> so a user can audit every share grant
/// they have created without walking every album one-by-one.
/// </summary>
/// <param name="Id">Share link primary key (UUIDv7).</param>
/// <param name="AlbumId">The album the share link grants access to.</param>
/// <param name="AlbumName">
/// The album's encrypted name as a base64-encoded opaque blob. The server cannot
/// decrypt it; the client decrypts client-side using the appropriate epoch read
/// key. <c>null</c> when the album has no name set.
/// </param>
/// <param name="Role">
/// Friendly access role string derived from <c>AccessTier</c>:
/// <c>"read"</c> for tier 1 (thumb) or tier 2 (preview), <c>"write"</c> for
/// tier 3 (full). Note: share links never grant mutation rights — "write" here
/// refers to full-fidelity originals access, mirroring the album-role naming
/// convention used elsewhere in the API.
/// </param>
/// <param name="AccessTier">Raw tier (1=thumb, 2=preview, 3=full) for clients that need it.</param>
/// <param name="ExpiresAt">Absolute expiration; <c>null</c> means never.</param>
/// <param name="CreatedAt">When the share link was issued.</param>
/// <param name="AccessCount">How many times the link has been redeemed.</param>
/// <param name="IsRevoked">Whether the owner explicitly revoked the link.</param>
public sealed record ShareLinkSummary(
    Guid Id,
    Guid AlbumId,
    string? AlbumName,
    string Role,
    int AccessTier,
    DateTimeOffset? ExpiresAt,
    DateTimeOffset CreatedAt,
    int AccessCount,
    bool IsRevoked);

/// <summary>
/// Response for share link creation and listing
/// </summary>
public class ShareLinkResponse
{
    public Guid Id { get; set; }
    public required string LinkId { get; set; }
    public int AccessTier { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }
    public int? MaxUses { get; set; }
    public int UseCount { get; set; }
    public bool IsRevoked { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// Response for share link with owner-encrypted secret (for epoch rotation)
/// </summary>
public class ShareLinkWithSecretResponse
{
    public Guid Id { get; set; }
    public required string LinkId { get; set; }
    public int AccessTier { get; set; }
    public bool IsRevoked { get; set; }
    /// <summary>
    /// Owner-encrypted link secret (null if not stored)
    /// </summary>
    public byte[]? OwnerEncryptedSecret { get; set; }
}

/// <summary>
/// Response for anonymous link access
/// </summary>
public class LinkAccessResponse
{
    public Guid AlbumId { get; set; }
    public int AccessTier { get; set; }
    public int EpochCount { get; set; }
    /// <summary>
    /// Base64-encoded encrypted album name (can be decrypted with tier key)
    /// </summary>
    public string? EncryptedName { get; set; }
    /// <summary>
    /// Short-lived HMAC grant token. Required by subresource endpoints (/keys, /photos, /shards)
    /// when the share link has a MaxUses limit. Pass via X-Share-Grant header.
    /// Valid for ~2 hours from issuance.
    /// </summary>
    public string? GrantToken { get; set; }
}

/// <summary>
/// Response for link epoch key
/// </summary>
public class LinkEpochKeyResponse
{
    public int EpochId { get; set; }
    public int Tier { get; set; }
    public required byte[] Nonce { get; set; }
    public required byte[] EncryptedKey { get; set; }
    public string? SignPubkey { get; set; }
}

/// <summary>
/// Response for photo metadata accessed via share link
/// </summary>
public class ShareLinkPhotoResponse : PhotoResponse;

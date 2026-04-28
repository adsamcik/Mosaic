namespace Mosaic.Backend.Models.ShareLinks;

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
public class ShareLinkPhotoResponse
{
    public Guid Id { get; set; }
    public long VersionCreated { get; set; }
    public bool IsDeleted { get; set; }
    public required byte[] EncryptedMeta { get; set; }
    public required string Signature { get; set; }
    public required string SignerPubkey { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }
    public required List<Guid> ShardIds { get; set; }
}

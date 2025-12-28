using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;

namespace Mosaic.Backend.Tests.Helpers;

/// <summary>
/// Builder for creating test data entities
/// </summary>
public class TestDataBuilder
{
    private readonly MosaicDbContext _db;

    public TestDataBuilder(MosaicDbContext db)
    {
        _db = db;
    }

    /// <summary>
    /// Creates a user with the given auth subject
    /// </summary>
    public async Task<User> CreateUserAsync(string authSub, string? identityPubkey = null)
    {
        var user = new User
        {
            Id = Guid.NewGuid(),
            AuthSub = authSub,
            IdentityPubkey = identityPubkey ?? ""
        };
        _db.Users.Add(user);
        _db.UserQuotas.Add(new UserQuota
        {
            UserId = user.Id,
            MaxStorageBytes = 10737418240
        });
        await _db.SaveChangesAsync();
        return user;
    }

    /// <summary>
    /// Creates an album owned by the given user
    /// </summary>
    public async Task<Album> CreateAlbumAsync(User owner, int currentEpochId = 1, long currentVersion = 1, string? encryptedName = null)
    {
        var album = new Album
        {
            Id = Guid.NewGuid(),
            OwnerId = owner.Id,
            CurrentEpochId = currentEpochId,
            CurrentVersion = currentVersion,
            EncryptedName = encryptedName
        };
        _db.Albums.Add(album);

        // Add owner as member
        _db.AlbumMembers.Add(new AlbumMember
        {
            AlbumId = album.Id,
            UserId = owner.Id,
            Role = "owner"
        });

        await _db.SaveChangesAsync();
        return album;
    }

    /// <summary>
    /// Adds a member to an album
    /// </summary>
    public async Task<AlbumMember> AddMemberAsync(Album album, User user, string role, User? inviter = null)
    {
        var member = new AlbumMember
        {
            AlbumId = album.Id,
            UserId = user.Id,
            Role = role,
            InvitedBy = inviter?.Id
        };
        _db.AlbumMembers.Add(member);
        await _db.SaveChangesAsync();
        return member;
    }

    /// <summary>
    /// Creates an epoch key for a recipient
    /// </summary>
    public async Task<EpochKey> CreateEpochKeyAsync(
        Album album,
        User recipient,
        int epochId = 1,
        byte[]? encryptedKeyBundle = null,
        byte[]? ownerSignature = null,
        byte[]? sharerPubkey = null,
        byte[]? signPubkey = null)
    {
        var epochKey = new EpochKey
        {
            Id = Guid.NewGuid(),
            AlbumId = album.Id,
            RecipientId = recipient.Id,
            EpochId = epochId,
            EncryptedKeyBundle = encryptedKeyBundle ?? new byte[32],
            OwnerSignature = ownerSignature ?? new byte[64],
            SharerPubkey = sharerPubkey ?? new byte[32],
            SignPubkey = signPubkey ?? new byte[32]
        };
        _db.EpochKeys.Add(epochKey);
        await _db.SaveChangesAsync();
        return epochKey;
    }

    /// <summary>
    /// Creates a shard with the given properties
    /// </summary>
    public async Task<Shard> CreateShardAsync(
        User uploader,
        ShardStatus status = ShardStatus.PENDING,
        long sizeBytes = 1024,
        string? storageKey = null)
    {
        var shard = new Shard
        {
            Id = Guid.NewGuid(),
            UploaderId = uploader.Id,
            StorageKey = storageKey ?? $"shards/{Guid.NewGuid()}",
            SizeBytes = sizeBytes,
            Status = status,
            PendingExpiresAt = status == ShardStatus.PENDING ? DateTime.UtcNow.AddHours(1) : null
        };
        _db.Shards.Add(shard);
        await _db.SaveChangesAsync();
        return shard;
    }

    /// <summary>
    /// Creates a manifest with shards
    /// </summary>
    public async Task<Manifest> CreateManifestAsync(
        Album album,
        List<Shard> shards,
        bool isDeleted = false,
        byte[]? encryptedMeta = null)
    {
        var manifest = new Manifest
        {
            Id = Guid.NewGuid(),
            AlbumId = album.Id,
            VersionCreated = album.CurrentVersion,
            IsDeleted = isDeleted,
            EncryptedMeta = encryptedMeta ?? new byte[] { 0x01, 0x02, 0x03 },
            Signature = Convert.ToBase64String(new byte[64]),
            SignerPubkey = Convert.ToBase64String(new byte[32])
        };
        _db.Manifests.Add(manifest);

        for (int i = 0; i < shards.Count; i++)
        {
            _db.ManifestShards.Add(new ManifestShard
            {
                ManifestId = manifest.Id,
                ShardId = shards[i].Id,
                ChunkIndex = i
            });
        }

        await _db.SaveChangesAsync();
        return manifest;
    }

    /// <summary>
    /// Creates a share link for an album
    /// </summary>
    public async Task<ShareLink> CreateShareLinkAsync(
        Album album,
        int accessTier = 3,
        byte[]? linkId = null,
        DateTimeOffset? expiresAt = null,
        int? maxUses = null,
        bool isRevoked = false,
        int useCount = 0,
        byte[]? ownerEncryptedSecret = null)
    {
        var shareLink = new ShareLink
        {
            Id = Guid.NewGuid(),
            LinkId = linkId ?? GenerateRandomBytes(16),
            AlbumId = album.Id,
            AccessTier = accessTier,
            ExpiresAt = expiresAt,
            MaxUses = maxUses,
            UseCount = useCount,
            IsRevoked = isRevoked,
            OwnerEncryptedSecret = ownerEncryptedSecret
        };
        _db.ShareLinks.Add(shareLink);
        await _db.SaveChangesAsync();
        return shareLink;
    }

    /// <summary>
    /// Creates a link epoch key for a share link
    /// </summary>
    public async Task<LinkEpochKey> CreateLinkEpochKeyAsync(
        ShareLink shareLink,
        int epochId,
        int tier,
        byte[]? wrappedNonce = null,
        byte[]? wrappedKey = null)
    {
        var linkEpochKey = new LinkEpochKey
        {
            Id = Guid.NewGuid(),
            ShareLinkId = shareLink.Id,
            EpochId = epochId,
            Tier = tier,
            WrappedNonce = wrappedNonce ?? GenerateRandomBytes(24),
            WrappedKey = wrappedKey ?? GenerateRandomBytes(48)
        };
        _db.LinkEpochKeys.Add(linkEpochKey);
        await _db.SaveChangesAsync();
        return linkEpochKey;
    }

    /// <summary>
    /// Generates random bytes for testing
    /// </summary>
    public static byte[] GenerateRandomBytes(int length)
    {
        var bytes = new byte[length];
        Random.Shared.NextBytes(bytes);
        return bytes;
    }
}

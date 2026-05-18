using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using tusdotnet.Interfaces;
using tusdotnet.Stores;

namespace Mosaic.Backend.Services;

/// <summary>
/// GDPR Article 17 right-to-erasure orchestrator (v1.0.1 s15).
///
/// <para>
/// Wipes one user's entire data footprint server-side. The flow is
/// purposely split into <i>collect → transactional delete → out-of-band
/// blob &amp; Tus cleanup</i> so that:
/// </para>
///
/// <list type="number">
///   <item><description>
///     Database state is consistent the moment the transaction commits
///     (no orphan rows, no half-deleted albums).
///   </description></item>
///   <item><description>
///     Encrypted blobs on disk are erased <b>after</b> the DB no longer
///     references them — if the on-disk delete fails for a single file,
///     we have already lost the only pointer to it and the file becomes
///     garbage-collectible by <see cref="GarbageCollectionService"/>.
///   </description></item>
///   <item><description>
///     The audit log is preserved per the legitimate-interest legal basis
///     for security incident response: rows are anonymised in place
///     (<see cref="AuditLogEntry.ActorUserId"/> → NULL,
///     <see cref="AuditLogEntry.ActorWasErased"/> → <c>true</c>) instead
///     of being deleted.
///   </description></item>
/// </list>
/// </summary>
public interface IUserErasureService
{
    /// <summary>
    /// Erase every artefact owned by <paramref name="userId"/>:
    /// owned albums (and their cascading manifests / epoch keys / members
    /// / share links / share link grants / link epoch keys / album
    /// content / album limits), membership rows on albums the user only
    /// joined, sessions, auth challenges, idempotency records, Tus
    /// reservations, uploaded shard rows, the on-disk encrypted blob
    /// files for those shards, and the user row itself. Audit log
    /// entries for the user are anonymised, not deleted.
    /// </summary>
    /// <returns>
    /// A <see cref="UserErasureResult"/> summarising what was removed —
    /// used by the audit log and by tests to assert per-table effects.
    /// </returns>
    Task<UserErasureResult> EraseAsync(Guid userId, CancellationToken cancellationToken = default);
}

/// <summary>
/// Diagnostic summary of a single right-to-erasure run. Counts are
/// included in the resulting <c>user.erased</c> audit event so operators
/// can see at a glance how large the wipe was without re-querying the
/// (now-deleted) data.
/// </summary>
public sealed record UserErasureResult(
    int OwnedAlbumsDeleted,
    int MembershipsDeleted,
    int SessionsDeleted,
    int AuthChallengesDeleted,
    int IdempotencyRecordsDeleted,
    int TusReservationsDeleted,
    int ShardsDeleted,
    int BlobsDeleted,
    int BlobsFailed,
    int TusFilesDeleted,
    int AuditEntriesAnonymised);

/// <summary>
/// Concrete implementation of <see cref="IUserErasureService"/>.
/// </summary>
public sealed class UserErasureService : IUserErasureService
{
    private readonly MosaicDbContext _db;
    private readonly IStorageService _storage;
    private readonly IConfiguration _config;
    private readonly ILogger<UserErasureService> _logger;

    public UserErasureService(
        MosaicDbContext db,
        IStorageService storage,
        IConfiguration config,
        ILogger<UserErasureService> logger)
    {
        _db = db;
        _storage = storage;
        _config = config;
        _logger = logger;
    }

    public async Task<UserErasureResult> EraseAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        // ───────────────────────────────────────────────────────────
        // Phase 1 — collect (snapshot ids we'll need AFTER the cascade
        // has nulled out FKs). We deliberately read everything before
        // beginning the destructive transaction so a partial failure
        // doesn't leave us guessing which blobs to delete.
        // ───────────────────────────────────────────────────────────

        var user = await _db.Users
            .AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == userId, cancellationToken)
            ?? throw new InvalidOperationException($"User {userId} not found");

        var ownedAlbumIds = await _db.Albums
            .Where(a => a.OwnerId == userId)
            .Select(a => a.Id)
            .ToListAsync(cancellationToken);

        // Shards we must erase from disk:
        //   1. Shards uploaded by this user (Shard.UploaderId), regardless
        //      of which album's manifest currently references them.
        //   2. Shards referenced by manifests in owned albums that some
        //      OTHER user uploaded (a co-contributor on a shared album we
        //      own). They would otherwise dangle once the owning album is
        //      cascade-deleted.
        var uploadedShards = await _db.Shards
            .Where(s => s.UploaderId == userId)
            .Select(s => new ShardRef(s.Id, s.StorageKey))
            .ToListAsync(cancellationToken);

        var albumShards = ownedAlbumIds.Count == 0
            ? new List<ShardRef>()
            : await (from ms in _db.ManifestShards
                     join m in _db.Manifests.IgnoreQueryFilters() on ms.ManifestId equals m.Id
                     join s in _db.Shards on ms.ShardId equals s.Id
                     where ownedAlbumIds.Contains(m.AlbumId)
                     select new ShardRef(s.Id, s.StorageKey))
                    .Distinct()
                    .ToListAsync(cancellationToken);

        var allShardIds = uploadedShards.Select(s => s.Id)
            .Concat(albumShards.Select(s => s.Id))
            .Distinct()
            .ToList();

        var storageKeys = uploadedShards.Select(s => s.StorageKey)
            .Concat(albumShards.Select(s => s.StorageKey))
            .Where(k => !string.IsNullOrEmpty(k))
            .Distinct(StringComparer.Ordinal)
            .ToList();

        var tusFileIds = await _db.TusUploadReservations
            .Where(r => r.UserId == userId)
            .Select(r => r.FileId)
            .ToListAsync(cancellationToken);

        var membershipsCount = await _db.AlbumMembers
            .Where(am => am.UserId == userId)
            .CountAsync(cancellationToken);

        var sessionsCount = await _db.Sessions
            .Where(s => s.UserId == userId)
            .CountAsync(cancellationToken);

        var idempotencyCount = await _db.IdempotencyRecords
            .Where(r => r.UserId == userId)
            .CountAsync(cancellationToken);

        // ───────────────────────────────────────────────────────────
        // Phase 2 — transactional delete. The cascade FKs configured in
        // MosaicDbContext do most of the heavy lifting:
        //
        //   User
        //     ├─ OwnedAlbums (cascade)
        //     │    ├─ AlbumMembers, AlbumContent, AlbumLimits (cascade)
        //     │    ├─ EpochKeys (cascade)
        //     │    ├─ Manifests (cascade)
        //     │    │    └─ ManifestShards (cascade — but Shard.Restrict)
        //     │    └─ ShareLinks (cascade)
        //     │         ├─ LinkEpochKeys (cascade)
        //     │         └─ ShareLinkGrants (cascade)
        //     ├─ Memberships (cascade — on other owners' albums)
        //     ├─ EpochKeys (RecipientId, cascade)
        //     ├─ Sessions (cascade)
        //     ├─ TusUploadReservations (cascade)
        //     ├─ IdempotencyRecords (cascade)
        //     └─ UserQuota (cascade, 1:1)
        //
        // We must manually:
        //   • Delete Shards (ManifestShard.Shard is Restrict, and shards
        //     uploaded by us into albums we DON'T own won't cascade).
        //   • Delete AuthChallenges (no FK — keyed by Username).
        //   • Anonymise AuditLogEntries (KEEP for forensics).
        // ───────────────────────────────────────────────────────────

        await using var tx = await _db.Database.BeginTransactionAsync(cancellationToken);
        int auditAnonymised;
        int authChallengesDeleted;
        int shardsDeleted;
        try
        {
            // Anonymise audit log first — once the User row is gone, the
            // ActorUserId values would still be intact (no FK on
            // audit_log_entries.actor_user_id), but anonymising in place
            // makes the legal-basis story explicit and lets operators
            // grep for ActorWasErased = true.
            auditAnonymised = await _db.AuditLogEntries
                .Where(a => a.ActorUserId == userId)
                .ExecuteUpdateAsync(
                    s => s
                        .SetProperty(a => a.ActorUserId, _ => (Guid?)null)
                        .SetProperty(a => a.ActorWasErased, _ => true),
                    cancellationToken);

            // Auth challenges aren't FK-linked; remove by username.
            authChallengesDeleted = await _db.AuthChallenges
                .Where(c => c.Username == user.AuthSub)
                .ExecuteDeleteAsync(cancellationToken);

            // Delete shards we collected above — but ONLY those that
            // become orphans once the manifests in OUR owned albums are
            // gone. The previous implementation deleted ManifestShard
            // rows by ShardId globally, which silently severed shared-
            // shard links in unrelated users' albums (security-review-
            // 2026-05-18-01). The correct algorithm is:
            //
            //   1. Scope the manifest-link delete to manifests in the
            //      albums we are about to cascade-delete. (The album
            //      cascade would handle this anyway; doing it explicitly
            //      means we can immediately observe orphan status.)
            //   2. A shard is "orphaned" iff zero ManifestShard rows
            //      reference it AFTER step 1. Only then is it safe to
            //      drop the Shard row and zero its blob.
            //   3. Shards still referenced by manifests in albums we do
            //      NOT own are left intact — their Uploader FK falls
            //      back to NULL via the configured SetNull rule when we
            //      drop the user row.
            int shardLinksRemoved = 0;
            var ownedManifestIds = ownedAlbumIds.Count == 0
                ? new List<Guid>()
                : await _db.Manifests.IgnoreQueryFilters()
                    .Where(m => ownedAlbumIds.Contains(m.AlbumId))
                    .Select(m => m.Id)
                    .ToListAsync(cancellationToken);

            if (ownedManifestIds.Count > 0)
            {
                shardLinksRemoved = await _db.ManifestShards
                    .Where(ms => ownedManifestIds.Contains(ms.ManifestId))
                    .ExecuteDeleteAsync(cancellationToken);
            }

            List<Guid> orphanedShardIds;
            if (allShardIds.Count > 0)
            {
                orphanedShardIds = await _db.Shards
                    .Where(s => allShardIds.Contains(s.Id)
                                && !_db.ManifestShards.Any(ms => ms.ShardId == s.Id))
                    .Select(s => s.Id)
                    .ToListAsync(cancellationToken);

                shardsDeleted = orphanedShardIds.Count > 0
                    ? await _db.Shards
                        .Where(s => orphanedShardIds.Contains(s.Id))
                        .ExecuteDeleteAsync(cancellationToken)
                    : 0;
            }
            else
            {
                orphanedShardIds = new List<Guid>();
                shardsDeleted = 0;
            }

            // Narrow the storage-key set to truly orphaned shards before
            // the post-commit blob delete. Blobs for shards that are
            // still referenced by other users' manifests MUST NOT be
            // zeroed — those photos would silently become un-decryptable.
            _ = shardLinksRemoved; // logged via shardsDeleted accounting
            var orphanedIdSet = orphanedShardIds.ToHashSet();
            storageKeys = uploadedShards.Concat(albumShards)
                .Where(s => orphanedIdSet.Contains(s.Id))
                .Select(s => s.StorageKey)
                .Where(k => !string.IsNullOrEmpty(k))
                .Distinct(StringComparer.Ordinal)
                .ToList();

            // Drop the user row. Everything in the cascade list above
            // (owned albums, memberships, sessions, etc.) goes with it.
            await _db.Users
                .Where(u => u.Id == userId)
                .ExecuteDeleteAsync(cancellationToken);

            await tx.CommitAsync(cancellationToken);
        }
        catch
        {
            await tx.RollbackAsync(CancellationToken.None);
            throw;
        }

        // ───────────────────────────────────────────────────────────
        // Phase 3 — best-effort, post-commit cleanup of encrypted blobs
        // and Tus in-flight uploads. Failures here are logged but do not
        // roll back the erasure: the DB no longer references these
        // bytes, and the periodic GC will sweep orphans.
        // ───────────────────────────────────────────────────────────

        var blobsDeleted = 0;
        var blobsFailed = 0;
        foreach (var key in storageKeys)
        {
            try
            {
                await _storage.DeleteAsync(key);
                blobsDeleted++;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                blobsFailed++;
                _logger.LogWarning(
                    ex,
                    "Failed to delete encrypted shard blob during user erasure (user={UserId}); orphan will be GC'd",
                    userId);
            }
        }

        var tusFilesDeleted = 0;
        if (tusFileIds.Count > 0)
        {
            var tusStore = new TusDiskStore(_config["Storage:Path"] ?? "./data/blobs");
            if (tusStore is ITusTerminationStore terminationStore)
            {
                foreach (var fileId in tusFileIds)
                {
                    try
                    {
                        await terminationStore.DeleteFileAsync(fileId, cancellationToken);
                        tusFilesDeleted++;
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        _logger.LogWarning(
                            ex,
                            "Failed to terminate in-flight Tus upload during user erasure (user={UserId}, fileId={FileId})",
                            userId,
                            fileId);
                    }
                }
            }
        }

        // ownedAlbums and memberships counts come from the rows that
        // existed before the cascade fired (snapshotted in Phase 1) —
        // surface them in the audit record so operators have a forensic
        // trail even after the rows are gone.

        Debug.Assert(blobsDeleted + blobsFailed == storageKeys.Count);

        return new UserErasureResult(
            OwnedAlbumsDeleted: ownedAlbumIds.Count,
            MembershipsDeleted: membershipsCount,
            SessionsDeleted: sessionsCount,
            AuthChallengesDeleted: authChallengesDeleted,
            IdempotencyRecordsDeleted: idempotencyCount,
            TusReservationsDeleted: tusFileIds.Count,
            ShardsDeleted: shardsDeleted,
            BlobsDeleted: blobsDeleted,
            BlobsFailed: blobsFailed,
            TusFilesDeleted: tusFilesDeleted,
            AuditEntriesAnonymised: auditAnonymised);
    }

    private sealed record ShardRef(Guid Id, string StorageKey);
}

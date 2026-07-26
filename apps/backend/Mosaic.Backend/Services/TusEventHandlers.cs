using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Extensions;
using tusdotnet.Interfaces;
using tusdotnet.Models;
using tusdotnet.Models.Configuration;

namespace Mosaic.Backend.Services;

public static class TusEventHandlers
{
    private const string ReservedBytesItemKey = "QuotaReservedBytes";
    private const string ReservationUserIdItemKey = "TusReservationUserId";
    private const string ReservationAlbumIdItemKey = "TusReservationAlbumId";
    private const string ContentSha256MetadataKey = "content-sha256";
    private const string EnvelopeVersionMetadataKey = "envelope-version";
    /// <summary>
    /// Tus metadata key carrying the client-supplied blob storage-format
    /// version. Required since v1.0.2 so that future format changes can be
    /// detected at upload time and stored blobs cannot be silently
    /// reinterpreted under a new envelope layout. The backend never parses
    /// blob contents (zero-knowledge); this marker is the only on-wire
    /// signal that the client and server agree on the encoding.
    /// </summary>
    private const string BlobFormatVersionMetadataKey = "blob-format-version";
    /// <summary>
    /// Currently the only accepted blob storage-format version. Listed
    /// under <see cref="docs/ARCHITECTURE.md"/> "Storage Format Versions".
    /// Adding a new version means: (a) appending it to this set, (b)
    /// documenting the change in the storage-format register, and (c)
    /// shipping a coordinated client update.
    /// </summary>
    private static readonly HashSet<int> SupportedBlobFormatVersions = new() { 1 };
    private static readonly HashSet<int> SupportedEnvelopeVersions = new() { 3, 4 };
    private static readonly TimeSpan ReservationLifetime = TimeSpan.FromHours(24);
    private static readonly Regex ContentSha256Regex = new("^[0-9a-f]{64}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly ConcurrentDictionary<string, FinalizationLockEntry> FinalizationLocks = new(StringComparer.Ordinal);

    public static async Task OnBeforeCreateAsync(
        BeforeCreateContext context,
        IServiceProvider services)
    {
        if (context.UploadLength < 0)
        {
            context.FailRequest("Deferred upload length is not supported");
            return;
        }

        var httpContext = context.HttpContext;
        var authSub = httpContext.Items["AuthSub"] as string;

        if (string.IsNullOrEmpty(authSub))
        {
            context.FailRequest("Unauthorized");
            return;
        }

        if (!TryReadContentSha256Metadata(context.Metadata, out _, out var hashError))
        {
            context.FailRequest(hashError);
            return;
        }

        if (!TryReadBlobFormatVersionMetadata(context.Metadata, out _, out var versionError))
        {
            context.FailRequest(versionError);
            return;
        }

        if (!TryReadEnvelopeVersionMetadata(context.Metadata, out _, out var envelopeError))
        {
            context.FailRequest(envelopeError);
            return;
        }

        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var timeProvider = scope.ServiceProvider.GetService<TimeProvider>() ?? TimeProvider.System;

        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.AuthSub == authSub);
        if (user == null)
        {
            context.FailRequest("User not found");
            return;
        }

        var albumId = TryGetAlbumId(context.Metadata);
        if (albumId.HasValue)
        {
            var accessError = await ValidateAlbumAccessAsync(db, albumId.Value, user.Id, timeProvider);
            if (accessError != null)
            {
                context.FailRequest(accessError);
                return;
            }
        }

        if (!await HasQuotaCapacityAsync(db, user.Id, context.UploadLength))
        {
            context.FailRequest("Storage quota exceeded");
            return;
        }

        httpContext.Items[ReservedBytesItemKey] = context.UploadLength;
        httpContext.Items[ReservationUserIdItemKey] = user.Id;
        if (albumId.HasValue)
        {
            httpContext.Items[ReservationAlbumIdItemKey] = albumId.Value;
        }
    }

    public static async Task OnCreateCompleteAsync(
        CreateCompleteContext context,
        IServiceProvider services)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var timeProvider = scope.ServiceProvider.GetService<TimeProvider>() ?? TimeProvider.System;
        var httpContext = context.HttpContext;

        var authSub = httpContext.Items["AuthSub"] as string;
        if (string.IsNullOrEmpty(authSub))
        {
            throw new InvalidOperationException("Missing authenticated user for upload reservation.");
        }

        var userId = httpContext.Items[ReservationUserIdItemKey] as Guid?
            ?? await db.Users
                .AsNoTracking()
                .Where(u => u.AuthSub == authSub)
                .Select(u => (Guid?)u.Id)
                .FirstOrDefaultAsync();

        if (!userId.HasValue)
        {
            throw new InvalidOperationException("Authenticated user not found for upload reservation.");
        }

        if (!TryReadContentSha256Metadata(context.Metadata, out var expectedContentSha256, out var hashError))
        {
            throw new InvalidOperationException(hashError);
        }

        if (!TryReadBlobFormatVersionMetadata(context.Metadata, out _, out var versionError))
        {
            throw new InvalidOperationException(versionError);
        }

        if (!TryReadEnvelopeVersionMetadata(context.Metadata, out var envelopeVersion, out var envelopeError))
        {
            throw new InvalidOperationException(envelopeError);
        }

        var now = timeProvider.GetUtcNow().UtcDateTime;

        await using var tx = await db.Database.BeginTransactionAsync(context.CancellationToken);
        var commitAttempted = false;
        try
        {
            var reservation = await db.TusUploadReservations.FindAsync(context.FileId);
            var reservationCreated = reservation == null;
            if (reservation is null)
            {
                reservation = new TusUploadReservation
                {
                    FileId = context.FileId!,
                    UserId = userId.Value
                };
                db.TusUploadReservations.Add(reservation);
            }

            reservation.AlbumId = httpContext.Items[ReservationAlbumIdItemKey] as Guid?
                ?? TryGetAlbumId(context.Metadata);
            reservation.ReservedBytes = httpContext.Items[ReservedBytesItemKey] as long? ?? context.UploadLength;
            reservation.UploadLength = context.UploadLength;
            reservation.ExpiresAt = now.Add(ReservationLifetime);
            reservation.CreatedAt = now;

            var lifecycle = await db.TusUploadLifecycles.FindAsync([context.FileId!], context.CancellationToken);
            if (lifecycle is null)
            {
                lifecycle = new TusUploadLifecycle
                {
                    FileId = context.FileId!,
                    UserId = reservation.UserId,
                    AlbumId = reservation.AlbumId,
                    ReservedBytes = reservation.ReservedBytes,
                    UploadLength = reservation.UploadLength,
                    ExpectedContentSha256 = expectedContentSha256,
                    EnvelopeVersion = envelopeVersion,
                    State = TusUploadLifecycleState.CREATED,
                    CreatedAt = now,
                    UpdatedAt = now
                };
                db.TusUploadLifecycles.Add(lifecycle);
            }
            else if (lifecycle.State == TusUploadLifecycleState.CREATED)
            {
                lifecycle.UserId = reservation.UserId;
                lifecycle.AlbumId = reservation.AlbumId;
                lifecycle.ReservedBytes = reservation.ReservedBytes;
                lifecycle.UploadLength = reservation.UploadLength;
                lifecycle.ExpectedContentSha256 = expectedContentSha256;
                lifecycle.EnvelopeVersion = envelopeVersion;
                lifecycle.UpdatedAt = now;
            }

            if (reservationCreated)
            {
                var quotaReserved = await AdjustQuotaAsync(db, reservation.UserId, reservation.ReservedBytes, enforceLimit: true);
                if (!quotaReserved)
                {
                    throw new InvalidOperationException("Storage quota exceeded");
                }
            }

            await db.SaveChangesAsync();
            commitAttempted = true;
            await tx.CommitAsync(context.CancellationToken);
        }
        catch
        {
            if (!commitAttempted)
            {
                await tx.RollbackAsync(context.CancellationToken);
                await DeleteUnreservedTusFileAsync(context.Store, context.FileId!, context.CancellationToken);
            }

            throw;
        }
    }

    public static async Task OnAuthorizeAsync(
        AuthorizeContext context,
        IServiceProvider services)
    {
        if (context.Intent is IntentType.CreateFile or IntentType.GetOptions)
        {
            return;
        }

        var authSub = context.HttpContext.Items["AuthSub"] as string;
        if (string.IsNullOrEmpty(authSub))
        {
            context.FailRequest("Unauthorized");
            return;
        }

        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var timeProvider = scope.ServiceProvider.GetService<TimeProvider>() ?? TimeProvider.System;

        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.AuthSub == authSub);
        if (user == null)
        {
            context.FailRequest("Unauthorized");
            return;
        }

        if (string.IsNullOrWhiteSpace(context.FileId))
        {
            context.FailRequest("Unauthorized");
            return;
        }

        var reservation = await db.TusUploadReservations
            .AsNoTracking()
            .FirstOrDefaultAsync(r => r.FileId == context.FileId);

        if (reservation == null)
        {
            if (context.Intent == IntentType.GetFileInfo
                && Guid.TryParse(context.FileId, out var shardId)
                && await db.Shards.AsNoTracking().AnyAsync(s => s.Id == shardId && s.UploaderId == user.Id))
            {
                return;
            }

            context.FailRequest("Unauthorized");
            return;
        }

        if (reservation.UserId != user.Id)
        {
            context.FailRequest("Unauthorized");
            return;
        }

        if (context.Intent == IntentType.DeleteFile)
        {
            using var finalizationLease = await AcquireFinalizationLockAsync(
                context.FileId,
                context.CancellationToken);
            var cancelled = await TryCancelReservationUnderLeaseAsync(
                db,
                context.FileId,
                timeProvider.GetUtcNow().UtcDateTime,
                allowReceived: false,
                expiresOnOrBefore: null,
                context.CancellationToken);
            if (!cancelled)
            {
                context.FailRequest("Upload is already finalizing or completed");
            }
        }
    }

    public static async Task OnDeleteCompleteAsync(
        DeleteCompleteContext context,
        IServiceProvider services)
    {
        using var finalizationLease = await AcquireFinalizationLockAsync(
            context.FileId!,
            context.CancellationToken);
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var now = (scope.ServiceProvider.GetService<TimeProvider>() ?? TimeProvider.System)
            .GetUtcNow().UtcDateTime;

        // tusdotnet invokes this callback after terminating the file. Serialize
        // the durable refund/cancellation decision with finalization and refuse
        // to cancel an upload that has already been claimed as RECEIVED.
        await TryCancelReservationUnderLeaseAsync(
            db,
            context.FileId!,
            now,
            allowReceived: false,
            expiresOnOrBefore: null,
            context.CancellationToken);
    }

    public static Task OnFileCompleteAsync(
        FileCompleteContext context,
        IServiceProvider services)
        => FinalizeUploadAsync(context.FileId!, context.Store, services, context.CancellationToken, isReconciliation: false);

    private static async Task FinalizeUploadAsync(
        string fileId,
        ITusStore store,
        IServiceProvider services,
        CancellationToken cancellationToken,
        bool isReconciliation)
    {
        using var finalizationLease = await AcquireFinalizationLockAsync(fileId, cancellationToken);
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var timeProvider = scope.ServiceProvider.GetService<TimeProvider>() ?? TimeProvider.System;
        var logger = scope.ServiceProvider.GetService<ILoggerFactory>()?.CreateLogger(typeof(TusEventHandlers).FullName!);

        var reservation = await db.TusUploadReservations.FirstOrDefaultAsync(r => r.FileId == fileId);
        var now = timeProvider.GetUtcNow().UtcDateTime;
        var lifecycle = await db.TusUploadLifecycles.FirstOrDefaultAsync(l => l.FileId == fileId, cancellationToken);

        if (!Guid.TryParse(fileId, out var shardId))
        {
            if (lifecycle != null)
            {
                await TransitionLifecycleAsync(db, lifecycle, TusUploadLifecycleState.QUARANTINED, now, cancellationToken, "invalid-file-id");
            }
            throw new InvalidOperationException($"Tus file ID {fileId} is not a valid shard ID.");
        }

        var existingShard = await db.Shards.AsNoTracking().FirstOrDefaultAsync(s => s.Id == shardId, cancellationToken);
        var fileExists = await store.FileExistAsync(fileId, cancellationToken);
        if (existingShard != null)
        {
            if (!fileExists)
            {
                if (lifecycle != null)
                {
                    await TransitionLifecycleAsync(db, lifecycle, TusUploadLifecycleState.QUARANTINED, now, cancellationToken, "committed-shard-missing-blob");
                }
                logger?.LogError("Tus shard {FileId} has a database row but its completed blob is missing; finalization is quarantined.", fileId);
                throw new InvalidOperationException("Committed shard blob is missing; upload has been quarantined.");
            }

            if (reservation != null)
            {
                if (lifecycle != null)
                {
                    await TransitionLifecycleAsync(db, lifecycle, TusUploadLifecycleState.QUARANTINED, now, cancellationToken, "committed-shard-retained-reservation");
                }
                logger?.LogError("Tus shard {FileId} has both a committed shard and a live reservation; finalization is quarantined.", fileId);
                throw new InvalidOperationException("Upload lifecycle is inconsistent and has been quarantined.");
            }

            if (lifecycle != null)
            {
                await TransitionLifecycleAsync(db, lifecycle, TusUploadLifecycleState.COMMITTED, now, cancellationToken);
            }
            return;
        }

        if (lifecycle?.State is TusUploadLifecycleState.QUARANTINED or TusUploadLifecycleState.CANCELLED)
        {
            throw new InvalidOperationException($"Tus upload {fileId} is quarantined and requires operator intervention.");
        }

        if (reservation == null)
        {
            if (lifecycle != null)
            {
                await TransitionLifecycleAsync(db, lifecycle, TusUploadLifecycleState.QUARANTINED, now, cancellationToken, "completed-blob-missing-reservation");
            }
            logger?.LogError("Tus blob {FileId} has no shard or reservation; it is quarantined for operator reconciliation.", fileId);
            throw new InvalidOperationException($"Upload reservation missing for tus file {fileId}.");
        }

        lifecycle ??= await EnsureLifecycleAsync(db, reservation, fileId, now, cancellationToken);
        if (lifecycle.State is TusUploadLifecycleState.QUARANTINED or TusUploadLifecycleState.CANCELLED)
        {
            throw new InvalidOperationException($"Tus upload {fileId} is quarantined and requires operator intervention.");

        }

        if (!fileExists)
        {
            await TransitionLifecycleAsync(db, lifecycle, TusUploadLifecycleState.QUARANTINED, now, cancellationToken, "reservation-missing-blob");
            logger?.LogError("Tus reservation {FileId} has no completed blob; finalization is quarantined.", fileId);
            throw new InvalidOperationException("Tus upload content is missing; upload has been quarantined.");
        }

        // Claim completion durably before touching the blob. Expiration and
        // termination cleanup lock the same lifecycle row and may cancel only
        // CREATED uploads, so a completed file cannot disappear while it is
        // being hashed or committed on another backend replica.
        var claim = await ClaimUploadForFinalizationAsync(
            db,
            fileId,
            shardId,
            now,
            cancellationToken);
        if (claim.AlreadyCommitted)
        {
            logger?.LogInformation(
                "Tus upload {FileId} converged on an already committed shard while claiming finalization.",
                fileId);
            return;
        }

        reservation = claim.Reservation!;
        lifecycle = claim.Lifecycle;

        var (fileSize, contentSha256, metadata) = await ReadUploadAsync(store, fileId, cancellationToken);
        if (!TryReadContentSha256Metadata(metadata, out var sha256Hex, out var hashError))
        {
            await CleanupFailedUploadAsync(store, fileId, services, cancellationToken);
            throw new InvalidOperationException(hashError);
        }

        if (!string.Equals(contentSha256, sha256Hex, StringComparison.Ordinal))
        {
            await CleanupFailedUploadAsync(store, fileId, services, cancellationToken);
            throw new InvalidOperationException("Tus content-sha256 metadata does not match the completed upload bytes.");
        }

        if (!string.IsNullOrEmpty(lifecycle.ExpectedContentSha256)
            && !string.Equals(lifecycle.ExpectedContentSha256, sha256Hex, StringComparison.Ordinal))
        {
            await QuarantineUploadAsync(services, fileId, now, "content-sha256-metadata-changed", cancellationToken);
            throw new InvalidOperationException("Tus content-sha256 metadata changed after upload creation; upload has been quarantined.");
        }

        if (!TryReadEnvelopeVersionMetadata(metadata, out var envelopeVersion, out var envelopeError))
        {
            await CleanupFailedUploadAsync(store, fileId, services, cancellationToken);
            throw new InvalidOperationException(envelopeError);
        }

        if (lifecycle.EnvelopeVersion.HasValue && lifecycle.EnvelopeVersion.Value != envelopeVersion)
        {
            await QuarantineUploadAsync(services, fileId, now, "envelope-version-metadata-changed", cancellationToken);
            throw new InvalidOperationException("Tus envelope-version metadata changed after upload creation; upload has been quarantined.");
        }

        lifecycle.EnvelopeVersion = envelopeVersion;

        var accessError = reservation.AlbumId.HasValue
            ? await ValidateAlbumAccessAsync(db, reservation.AlbumId.Value, reservation.UserId, timeProvider)
            : null;
        if (accessError != null)
        {
            await CleanupFailedUploadAsync(store, fileId, services, cancellationToken);
            throw new InvalidOperationException(accessError);
        }

        await using var tx = await db.Database.BeginTransactionAsync(cancellationToken);
        var commitAttempted = false;
        try
        {
            // Serialize on the durable lifecycle row across backend replicas.
            // Clear entities read before the lock so validation below observes
            // a winner that may have committed while this request waited.
            db.ChangeTracker.Clear();
            if (db.UsesLiteProvider())
            {
                lifecycle = await db.TusUploadLifecycles
                    .FirstOrDefaultAsync(candidate => candidate.FileId == fileId, cancellationToken);
            }
            else
            {
                lifecycle = await db.TusUploadLifecycles
                    .FromSqlRaw(
                        "SELECT * FROM tus_upload_lifecycles WHERE file_id = {0} FOR UPDATE",
                        fileId)
                    .FirstOrDefaultAsync(cancellationToken);
            }

            reservation = await db.TusUploadReservations
                .FirstOrDefaultAsync(candidate => candidate.FileId == fileId, cancellationToken);
            existingShard = await db.Shards
                .FirstOrDefaultAsync(candidate => candidate.Id == shardId, cancellationToken);

            if (existingShard != null)
            {
                if (!fileExists)
                {
                    throw new InvalidOperationException("Committed shard blob is missing; upload has been quarantined.");
                }

                if (reservation != null)
                {
                    throw new InvalidOperationException("Upload lifecycle is inconsistent and has been quarantined.");
                }

                if (lifecycle != null)
                {
                    ApplyLifecycleTransition(lifecycle, TusUploadLifecycleState.COMMITTED, now);
                    await db.SaveChangesAsync(cancellationToken);
                }

                commitAttempted = true;
                await tx.CommitAsync(cancellationToken);
                return;
            }

            if (reservation == null || lifecycle == null)
            {
                throw new InvalidOperationException($"Upload reservation missing for tus file {fileId}.");
            }

            if (lifecycle.State is TusUploadLifecycleState.QUARANTINED or TusUploadLifecycleState.CANCELLED)
            {
                throw new InvalidOperationException($"Tus upload {fileId} is quarantined and requires operator intervention.");
            }

            ApplyLifecycleTransition(lifecycle, TusUploadLifecycleState.COMMITTING, now);

            db.Shards.Add(new Shard
            {
                Id = shardId,
                UploaderId = reservation.UserId,
                StorageKey = fileId,
                SizeBytes = fileSize,
                Status = ShardStatus.PENDING,
                PendingExpiresAt = timeProvider.GetUtcNow().UtcDateTime.AddHours(24),
                Sha256 = sha256Hex,
                EnvelopeVersion = envelopeVersion
            });

            var sizeDifference = fileSize - reservation.ReservedBytes;
            var quotaAdjusted = await AdjustQuotaAsync(
                db,
                reservation.UserId,
                sizeDifference,
                enforceLimit: sizeDifference > 0);

            if (!quotaAdjusted)
            {
                throw new InvalidOperationException("Storage quota exceeded");
            }

            db.TusUploadReservations.Remove(reservation);
            ApplyLifecycleTransition(lifecycle, TusUploadLifecycleState.COMMITTED, now);
            await db.SaveChangesAsync(cancellationToken);
            commitAttempted = true;
            await tx.CommitAsync(cancellationToken);

            // v1.0.1 s25: record successful upload completion. Resolved
            // optionally so unit tests that don't register the metrics
            // singleton continue to work.
            scope.ServiceProvider.GetService<MosaicMetrics>()?.RecordUpload();
        }
        catch (Exception ex)
        {
            if (commitAttempted)
            {
                logger?.LogError(
                    ex,
                    "Tus upload completion commit acknowledgement failed for {FileId}; retaining completed blob for reconciliation.",
                    fileId);
                throw;
            }

            await tx.RollbackAsync(cancellationToken);
            var convergenceFailed = false;
            try
            {
                if (await TryConvergeCommittedUploadAsync(
                    services,
                    store,
                    fileId,
                    now,
                    cancellationToken))
                {
                    logger?.LogInformation(
                        "Tus upload {FileId} converged on a concurrently committed shard.",
                        fileId);
                    return;
                }
            }
            catch (Exception convergenceException) when (convergenceException is not OperationCanceledException)
            {
                convergenceFailed = true;
                logger?.LogError(
                    convergenceException,
                    "Tus upload {FileId} could not verify concurrent commit state; retaining it for reconciliation.",
                    fileId);
            }

            if (convergenceFailed)
            {
                throw;
            }

            await QuarantineUploadAsync(
                services,
                fileId,
                now,
                "database-finalization-failed",
                cancellationToken);
            logger?.LogError(ex, "Tus upload {FileId} failed before commit; retaining completed blob in quarantine.", fileId);
            throw;
        }
    }

    public static async Task<int> ReconcileIncompleteUploadsAsync(
        IServiceProvider services,
        CancellationToken cancellationToken = default)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var configuration = scope.ServiceProvider.GetRequiredService<IConfiguration>();
        var logger = scope.ServiceProvider.GetService<ILoggerFactory>()?.CreateLogger(typeof(TusEventHandlers).FullName!);
        var store = new tusdotnet.Stores.TusDiskStore(configuration["Storage:Path"] ?? "./data/blobs");

        var fileIds = await db.TusUploadLifecycles
            .AsNoTracking()
            .Where(l => l.State == TusUploadLifecycleState.RECEIVED || l.State == TusUploadLifecycleState.COMMITTING)
            .OrderBy(l => l.UpdatedAt)
            .Select(l => l.FileId)
            .Take(100)
            .ToListAsync(cancellationToken);

        var reconciled = 0;
        foreach (var fileId in fileIds)
        {
            try
            {
                await FinalizeUploadAsync(fileId, store, services, cancellationToken, isReconciliation: true);
                reconciled++;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger?.LogError(ex, "Tus upload reconciliation failed for {FileId}; lifecycle state remains operator-visible.", fileId);
            }
        }

        return reconciled;
    }

    public static async Task<int> CleanupExpiredReservationsAsync(
        IServiceProvider services,
        CancellationToken cancellationToken = default)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var configuration = scope.ServiceProvider.GetRequiredService<IConfiguration>();
        var timeProvider = scope.ServiceProvider.GetService<TimeProvider>() ?? TimeProvider.System;
        var logger = scope.ServiceProvider.GetService<ILoggerFactory>()?.CreateLogger(typeof(TusEventHandlers).FullName!);

        var tusStore = new tusdotnet.Stores.TusDiskStore(configuration["Storage:Path"] ?? "./data/blobs");
        var deletedCount = 0;

        while (!cancellationToken.IsCancellationRequested)
        {
            var expiresOnOrBefore = timeProvider.GetUtcNow().UtcDateTime;
            var expiredFileIds = await db.TusUploadReservations
                .AsNoTracking()
                .Where(r => r.ExpiresAt <= expiresOnOrBefore)
                .Where(r => !db.TusUploadLifecycles.Any(l =>
                    l.FileId == r.FileId
                    && l.State != TusUploadLifecycleState.CREATED))
                .OrderBy(r => r.ExpiresAt)
                .Select(r => r.FileId)
                .Take(100)
                .ToListAsync(cancellationToken);

            if (expiredFileIds.Count == 0)
            {
                break;
            }

            foreach (var fileId in expiredFileIds)
            {
                using var finalizationLease = await AcquireFinalizationLockAsync(fileId, cancellationToken);
                using var cancellationScope = services.CreateScope();
                var cancellationDb = cancellationScope.ServiceProvider.GetRequiredService<MosaicDbContext>();
                var cancelled = await TryCancelReservationUnderLeaseAsync(
                    cancellationDb,
                    fileId,
                    timeProvider.GetUtcNow().UtcDateTime,
                    allowReceived: false,
                    expiresOnOrBefore,
                    cancellationToken);
                if (!cancelled)
                {
                    continue;
                }

                // The database cancellation commits before the external delete.
                // A delete failure can leave an encrypted orphan for operator
                // cleanup, but can never destroy a blob still owned by a live
                // reservation or a finalizer on another replica.
                if (tusStore is ITusTerminationStore terminationStore)
                {
                    try
                    {
                        await terminationStore.DeleteFileAsync(fileId, cancellationToken);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        logger?.LogWarning(
                            ex,
                            "Expired Tus upload {FileId} was durably cancelled but its blob could not be deleted",
                            fileId);
                    }
                }

                deletedCount++;
            }
        }

        return deletedCount;
    }

    private static async Task<(long FileSize, string ContentSha256, Dictionary<string, tusdotnet.Models.Metadata>? Metadata)> ReadUploadAsync(
        ITusStore store,
        string fileId,
        CancellationToken cancellationToken)
    {
        long fileSize = 0;
        var contentSha256 = string.Empty;
        Dictionary<string, tusdotnet.Models.Metadata>? metadata = null;

        if (store is ITusReadableStore readable)
        {
            var file = await readable.GetFileAsync(fileId, cancellationToken);
            if (file != null)
            {
                await using var stream = await file.GetContentAsync(cancellationToken);
                fileSize = stream.Length;
                contentSha256 = Convert.ToHexString(
                        await SHA256.HashDataAsync(stream, cancellationToken))
                    .ToLowerInvariant();
                metadata = await file.GetMetadataAsync(cancellationToken);
            }
        }

        return (fileSize, contentSha256, metadata);
    }

    private static TusUploadLifecycle CreateLifecycle(
        TusUploadReservation reservation,
        string fileId,
        DateTime now)
        => new()
        {
            FileId = fileId,
            UserId = reservation.UserId,
            AlbumId = reservation.AlbumId,
            ReservedBytes = reservation.ReservedBytes,
            UploadLength = reservation.UploadLength,
            State = TusUploadLifecycleState.CREATED,
            CreatedAt = now,
            UpdatedAt = now
        };

    private static async Task<TusUploadLifecycle> EnsureLifecycleAsync(
        MosaicDbContext db,
        TusUploadReservation reservation,
        string fileId,
        DateTime now,
        CancellationToken cancellationToken)
    {
        var lifecycle = await db.TusUploadLifecycles.FindAsync([fileId], cancellationToken);
        if (lifecycle != null)
        {
            return lifecycle;
        }

        lifecycle = CreateLifecycle(reservation, fileId, now);
        db.TusUploadLifecycles.Add(lifecycle);
        await db.SaveChangesAsync(cancellationToken);
        return lifecycle;
    }

    private static async Task TransitionLifecycleAsync(
        MosaicDbContext db,
        TusUploadLifecycle lifecycle,
        TusUploadLifecycleState state,
        DateTime now,
        CancellationToken cancellationToken,
        string? quarantineReason = null)
    {
        ApplyLifecycleTransition(lifecycle, state, now, quarantineReason);
        await db.SaveChangesAsync(cancellationToken);
    }

    private static void ApplyLifecycleTransition(
        TusUploadLifecycle lifecycle,
        TusUploadLifecycleState state,
        DateTime now,
        string? quarantineReason = null)
    {
        lifecycle.State = state;
        lifecycle.UpdatedAt = now;
        if (state == TusUploadLifecycleState.RECEIVED)
        {
            lifecycle.ReceivedAt ??= now;
        }
        else if (state == TusUploadLifecycleState.COMMITTING)
        {
            lifecycle.CommittingAt = now;
            lifecycle.ReconciliationAttempts++;
        }
        else if (state == TusUploadLifecycleState.COMMITTED)
        {
            lifecycle.CommittedAt = now;
            lifecycle.QuarantineReason = null;
        }
        else if (state == TusUploadLifecycleState.QUARANTINED)
        {
            lifecycle.QuarantinedAt = now;
            lifecycle.QuarantineReason = quarantineReason;
        }
    }

    private static bool TryReadContentSha256Metadata(
        Dictionary<string, tusdotnet.Models.Metadata>? metadata,
        out string contentSha256,
        out string error)
    {
        contentSha256 = string.Empty;
        if (metadata == null || !metadata.TryGetValue(ContentSha256MetadataKey, out var hashMetadata))
        {
            error = $"Missing Tus metadata '{ContentSha256MetadataKey}'";
            return false;
        }

        var candidate = hashMetadata.GetString(Encoding.UTF8);
        if (!ContentSha256Regex.IsMatch(candidate))
        {
            error = $"Tus metadata '{ContentSha256MetadataKey}' must be a lowercase 64-character hex SHA-256";
            return false;
        }

        contentSha256 = candidate;
        error = string.Empty;
        return true;
    }

    /// <summary>
    /// Validates the <c>blob-format-version</c> Tus metadata key. Required
    /// since v1.0.2 (see docs/ARCHITECTURE.md "Storage Format Versions").
    /// Fails closed when the key is missing or carries an unrecognised
    /// value so that future format changes are surfaced at upload time
    /// rather than corrupting the shard cache silently.
    /// </summary>
    private static bool TryReadBlobFormatVersionMetadata(
        Dictionary<string, tusdotnet.Models.Metadata>? metadata,
        out int version,
        out string error)
    {
        version = 0;
        if (metadata == null || !metadata.TryGetValue(BlobFormatVersionMetadataKey, out var versionMetadata))
        {
            error = $"Missing Tus metadata '{BlobFormatVersionMetadataKey}'";
            return false;
        }

        var raw = versionMetadata.GetString(Encoding.UTF8);
        if (!int.TryParse(raw, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var parsed) || parsed <= 0)
        {
            error = $"Tus metadata '{BlobFormatVersionMetadataKey}' must be a positive integer";
            return false;
        }

        if (!SupportedBlobFormatVersions.Contains(parsed))
        {
            error = $"Tus metadata '{BlobFormatVersionMetadataKey}' version {parsed} is not supported by this server";
            return false;
        }

        version = parsed;
        error = string.Empty;
        return true;
    }

    private static bool TryReadEnvelopeVersionMetadata(
        Dictionary<string, tusdotnet.Models.Metadata>? metadata,
        out int version,
        out string error)
    {
        version = 0;
        if (metadata == null || !metadata.TryGetValue(EnvelopeVersionMetadataKey, out var versionMetadata))
        {
            error = $"Missing Tus metadata '{EnvelopeVersionMetadataKey}'";
            return false;
        }

        var raw = versionMetadata.GetString(Encoding.UTF8);
        if (!int.TryParse(raw, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var parsed)
            || parsed <= 0)
        {
            error = $"Tus metadata '{EnvelopeVersionMetadataKey}' must be a positive integer";
            return false;
        }

        if (!SupportedEnvelopeVersions.Contains(parsed))
        {
            error = $"Tus metadata '{EnvelopeVersionMetadataKey}' version {parsed} is not supported by this server";
            return false;
        }

        version = parsed;
        error = string.Empty;
        return true;
    }

    private static async Task DeleteUnreservedTusFileAsync(
        ITusStore store,
        string fileId,
        CancellationToken cancellationToken)
    {
        if (store is ITusTerminationStore terminationStore)
        {
            await terminationStore.DeleteFileAsync(fileId, cancellationToken);
        }
    }

    private static async Task CleanupFailedUploadAsync(
        ITusStore store,
        string fileId,
        IServiceProvider services,
        CancellationToken cancellationToken)
    {
        // FinalizeUploadAsync already owns the per-file lease. Claim durable
        // cancellation and refund quota before deleting the external blob so a
        // database failure retains data for reconciliation instead of losing it.
        using var cleanupScope = services.CreateScope();
        var cleanupDb = cleanupScope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var cancelled = await TryCancelReservationUnderLeaseAsync(
            cleanupDb,
            fileId,
            (cleanupScope.ServiceProvider.GetService<TimeProvider>() ?? TimeProvider.System)
                .GetUtcNow().UtcDateTime,
            allowReceived: true,
            expiresOnOrBefore: null,
            cancellationToken);
        if (!cancelled)
        {
            return;
        }

        if (store is ITusTerminationStore terminationStore)
        {
            await terminationStore.DeleteFileAsync(fileId, cancellationToken);
        }
    }

    private static async Task<IDisposable> AcquireFinalizationLockAsync(
        string fileId,
        CancellationToken cancellationToken)
    {
        FinalizationLockEntry entry;
        while (true)
        {
            entry = FinalizationLocks.GetOrAdd(fileId, static _ => new FinalizationLockEntry());
            lock (entry)
            {
                if (FinalizationLocks.TryGetValue(fileId, out var current)
                    && ReferenceEquals(current, entry))
                {
                    entry.ReferenceCount++;
                    break;
                }
            }
        }

        try
        {
            await entry.Semaphore.WaitAsync(cancellationToken);
            return new FinalizationLockLease(fileId, entry);
        }
        catch
        {
            ReleaseFinalizationLockReference(fileId, entry, releaseSemaphore: false);
            throw;
        }
    }

    private static void ReleaseFinalizationLockReference(
        string fileId,
        FinalizationLockEntry entry,
        bool releaseSemaphore)
    {
        if (releaseSemaphore)
        {
            entry.Semaphore.Release();
        }

        lock (entry)
        {
            entry.ReferenceCount--;
            if (entry.ReferenceCount == 0)
            {
                FinalizationLocks.TryRemove(
                    new KeyValuePair<string, FinalizationLockEntry>(fileId, entry));
            }
        }
    }

    private static async Task<bool> TryConvergeCommittedUploadAsync(
        IServiceProvider services,
        ITusStore store,
        string fileId,
        DateTime now,
        CancellationToken cancellationToken)
    {
        if (!Guid.TryParse(fileId, out var shardId)
            || !await store.FileExistAsync(fileId, cancellationToken))
        {
            return false;
        }

        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        await using var tx = await db.Database.BeginTransactionAsync(cancellationToken);
        var commitAttempted = false;
        try
        {
            var lifecycle = await LockTusUploadLifecycleAsync(db, fileId, cancellationToken);
            var reservation = await LockTusUploadReservationAsync(db, fileId, cancellationToken);
            var shardExists = await db.Shards
                .AsNoTracking()
                .AnyAsync(candidate => candidate.Id == shardId, cancellationToken);
            if (!shardExists || reservation != null)
            {
                await tx.RollbackAsync(cancellationToken);
                return false;
            }

            if (lifecycle != null)
            {
                ApplyLifecycleTransition(lifecycle, TusUploadLifecycleState.COMMITTED, now);
                await db.SaveChangesAsync(cancellationToken);
            }

            commitAttempted = true;
            await tx.CommitAsync(cancellationToken);
            return true;
        }
        catch
        {
            if (!commitAttempted)
            {
                await tx.RollbackAsync(cancellationToken);
            }
            throw;
        }
    }

    private sealed class FinalizationLockEntry
    {
        public SemaphoreSlim Semaphore { get; } = new(1, 1);
        public int ReferenceCount { get; set; }
    }

    private sealed class FinalizationLockLease : IDisposable
    {
        private readonly string _fileId;
        private FinalizationLockEntry? _entry;

        public FinalizationLockLease(string fileId, FinalizationLockEntry entry)
        {
            _fileId = fileId;
            _entry = entry;
        }

        public void Dispose()
        {
            var entry = Interlocked.Exchange(ref _entry, null);
            if (entry != null)
            {
                ReleaseFinalizationLockReference(_fileId, entry, releaseSemaphore: true);
            }
        }
    }

    private static async Task<(
        TusUploadReservation? Reservation,
        TusUploadLifecycle Lifecycle,
        bool AlreadyCommitted)> ClaimUploadForFinalizationAsync(
            MosaicDbContext db,
            string fileId,
            Guid shardId,
            DateTime now,
            CancellationToken cancellationToken)
    {
        await using var tx = await db.Database.BeginTransactionAsync(cancellationToken);
        var commitAttempted = false;
        try
        {
            db.ChangeTracker.Clear();
            var lifecycle = await LockTusUploadLifecycleAsync(db, fileId, cancellationToken)
                ?? throw new InvalidOperationException($"Upload lifecycle missing for tus file {fileId}.");
            var reservation = await LockTusUploadReservationAsync(db, fileId, cancellationToken);

            if (lifecycle.State == TusUploadLifecycleState.COMMITTED)
            {
                var shardExists = await db.Shards
                    .AsNoTracking()
                    .AnyAsync(candidate => candidate.Id == shardId, cancellationToken);
                if (reservation == null && shardExists)
                {
                    commitAttempted = true;
                    await tx.CommitAsync(cancellationToken);
                    return (null, lifecycle, true);
                }

                throw new InvalidOperationException(
                    "Committed upload lifecycle is inconsistent with its shard or reservation.");
            }

            if (lifecycle.State is TusUploadLifecycleState.QUARANTINED
                or TusUploadLifecycleState.CANCELLED)
            {
                throw new InvalidOperationException(
                    $"Tus upload {fileId} is quarantined and requires operator intervention.");
            }

            if (reservation == null)
            {
                throw new InvalidOperationException($"Upload reservation missing for tus file {fileId}.");
            }

            if (lifecycle.State == TusUploadLifecycleState.CREATED)
            {
                ApplyLifecycleTransition(lifecycle, TusUploadLifecycleState.RECEIVED, now);
                await db.SaveChangesAsync(cancellationToken);
            }
            else if (lifecycle.State is not TusUploadLifecycleState.RECEIVED
                and not TusUploadLifecycleState.COMMITTING)
            {
                throw new InvalidOperationException(
                    $"Tus upload {fileId} is in unsupported lifecycle state {lifecycle.State}.");
            }

            commitAttempted = true;
            await tx.CommitAsync(cancellationToken);
            return (reservation, lifecycle, false);
        }
        catch
        {
            if (!commitAttempted)
            {
                await tx.RollbackAsync(cancellationToken);
            }
            throw;
        }
    }

    private static async Task<bool> TryCancelReservationUnderLeaseAsync(
        MosaicDbContext db,
        string fileId,
        DateTime now,
        bool allowReceived,
        DateTime? expiresOnOrBefore,
        CancellationToken cancellationToken)
    {
        await using var tx = await db.Database.BeginTransactionAsync(cancellationToken);
        var commitAttempted = false;
        try
        {
            db.ChangeTracker.Clear();
            var lifecycle = await LockTusUploadLifecycleAsync(db, fileId, cancellationToken);
            var reservation = await LockTusUploadReservationAsync(db, fileId, cancellationToken);
            if (reservation == null
                || (expiresOnOrBefore.HasValue && reservation.ExpiresAt > expiresOnOrBefore.Value)
                || (lifecycle != null
                    && lifecycle.State != TusUploadLifecycleState.CREATED
                    && !(allowReceived && lifecycle.State == TusUploadLifecycleState.RECEIVED)))
            {
                await tx.RollbackAsync(cancellationToken);
                return false;
            }

            if (lifecycle == null)
            {
                lifecycle = CreateLifecycle(reservation, fileId, now);
                db.TusUploadLifecycles.Add(lifecycle);
            }

            await AdjustQuotaAsync(
                db,
                reservation.UserId,
                -reservation.ReservedBytes,
                enforceLimit: false);
            db.TusUploadReservations.Remove(reservation);
            ApplyLifecycleTransition(
                lifecycle,
                TusUploadLifecycleState.CANCELLED,
                now);

            await db.SaveChangesAsync(cancellationToken);
            commitAttempted = true;
            await tx.CommitAsync(cancellationToken);
            return true;
        }
        catch
        {
            if (!commitAttempted)
            {
                await tx.RollbackAsync(cancellationToken);
            }
            throw;
        }
    }

    private static Task<TusUploadLifecycle?> LockTusUploadLifecycleAsync(
        MosaicDbContext db,
        string fileId,
        CancellationToken cancellationToken)
        => db.UsesLiteProvider()
            ? db.TusUploadLifecycles.FirstOrDefaultAsync(
                candidate => candidate.FileId == fileId,
                cancellationToken)
            : db.TusUploadLifecycles
                .FromSqlRaw(
                    "SELECT * FROM tus_upload_lifecycles WHERE file_id = {0} FOR UPDATE",
                    fileId)
                .FirstOrDefaultAsync(cancellationToken);

    private static Task<TusUploadReservation?> LockTusUploadReservationAsync(
        MosaicDbContext db,
        string fileId,
        CancellationToken cancellationToken)
        => db.UsesLiteProvider()
            ? db.TusUploadReservations.FirstOrDefaultAsync(
                candidate => candidate.FileId == fileId,
                cancellationToken)
            : db.TusUploadReservations
                .FromSqlRaw(
                    "SELECT * FROM tus_upload_reservations WHERE file_id = {0} FOR UPDATE",
                    fileId)
                .FirstOrDefaultAsync(cancellationToken);

    private static async Task QuarantineUploadAsync(
        IServiceProvider services,
        string fileId,
        DateTime now,
        string reason,
        CancellationToken cancellationToken)
    {
        using var quarantineScope = services.CreateScope();
        var quarantineDb = quarantineScope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        await using var tx = await quarantineDb.Database.BeginTransactionAsync(cancellationToken);
        var commitAttempted = false;
        try
        {
            var lifecycle = await LockTusUploadLifecycleAsync(
                quarantineDb,
                fileId,
                cancellationToken);
            if (lifecycle == null)
            {
                await tx.RollbackAsync(cancellationToken);
                return;
            }

            var reservation = await LockTusUploadReservationAsync(
                quarantineDb,
                fileId,
                cancellationToken);
            var committedShardExists = Guid.TryParse(fileId, out var shardId)
                && await quarantineDb.Shards
                    .AsNoTracking()
                    .AnyAsync(candidate => candidate.Id == shardId, cancellationToken);

            if (committedShardExists && reservation == null)
            {
                // A different replica may have committed after the failing
                // finalizer performed its first convergence read. Never let a
                // late quarantine overwrite that valid terminal state.
                ApplyLifecycleTransition(lifecycle, TusUploadLifecycleState.COMMITTED, now);
            }
            else if (lifecycle.State is not TusUploadLifecycleState.COMMITTED
                and not TusUploadLifecycleState.CANCELLED)
            {
                ApplyLifecycleTransition(
                    lifecycle,
                    TusUploadLifecycleState.QUARANTINED,
                    now,
                    reason);
            }

            await quarantineDb.SaveChangesAsync(cancellationToken);
            commitAttempted = true;
            await tx.CommitAsync(cancellationToken);
        }
        catch
        {
            if (!commitAttempted)
            {
                await tx.RollbackAsync(cancellationToken);
            }
            throw;
        }
    }

    private static Guid? TryGetAlbumId(Dictionary<string, tusdotnet.Models.Metadata>? metadata)
    {
        if (metadata == null || !metadata.TryGetValue("albumId", out var albumMetadata))
        {
            return null;
        }

        var albumIdStr = albumMetadata.GetString(Encoding.UTF8);
        return Guid.TryParse(albumIdStr, out var albumId) ? albumId : null;
    }

    private static async Task<string?> ValidateAlbumAccessAsync(MosaicDbContext db, Guid albumId, Guid userId, TimeProvider timeProvider)
    {
        var album = await db.Albums.AsNoTracking().FirstOrDefaultAsync(a => a.Id == albumId);
        if (album == null)
        {
            return "Album not found";
        }

        if (album.ExpiresAt.HasValue && album.ExpiresAt.Value <= timeProvider.GetUtcNow())
        {
            return "Album has expired";
        }

        var isMember = await db.AlbumMembers
            .AsNoTracking()
            .AnyAsync(am => am.AlbumId == albumId && am.UserId == userId && am.RevokedAt == null);
        if (!isMember)
        {
            return "Access denied";
        }

        return null;
    }

    private static async Task<bool> HasQuotaCapacityAsync(
        MosaicDbContext db,
        Guid userId,
        long uploadLength)
    {
        var quota = await db.UserQuotas.AsNoTracking().FirstOrDefaultAsync(q => q.UserId == userId);
        if (quota == null)
        {
            return true;
        }

        return uploadLength <= quota.MaxStorageBytes
            && quota.UsedStorageBytes <= quota.MaxStorageBytes - uploadLength;
    }

    private static async Task<bool> AdjustQuotaAsync(
        MosaicDbContext db,
        Guid userId,
        long deltaBytes,
        bool enforceLimit)
    {
        if (deltaBytes == 0)
        {
            return true;
        }

        int rowsAffected;
        if (deltaBytes > 0)
        {
            if (db.UsesLiteProvider())
            {
                rowsAffected = await db.Database.ExecuteSqlRawAsync(
                    "UPDATE user_quotas SET used_storage_bytes = used_storage_bytes + {0}, updated_at = datetime('now') WHERE user_id = {1} AND used_storage_bytes + {0} <= max_storage_bytes",
                    deltaBytes,
                    userId);
            }
            else
            {
                rowsAffected = await db.Database.ExecuteSqlRawAsync(
                    "UPDATE user_quotas SET used_storage_bytes = used_storage_bytes + {0}, updated_at = NOW() WHERE user_id = {1} AND used_storage_bytes + {0} <= max_storage_bytes",
                    deltaBytes,
                    userId);
            }

            if (!enforceLimit)
            {
                return rowsAffected > 0 || !await db.UserQuotas.AnyAsync(q => q.UserId == userId);
            }

            if (rowsAffected == 0)
            {
                var quotaExists = await db.UserQuotas.AnyAsync(q => q.UserId == userId);
                return !quotaExists;
            }

            return true;
        }

        if (db.UsesLiteProvider())
        {
            rowsAffected = await db.Database.ExecuteSqlRawAsync(
                "UPDATE user_quotas SET used_storage_bytes = MAX(0, used_storage_bytes + {0}), updated_at = datetime('now') WHERE user_id = {1}",
                deltaBytes,
                userId);
        }
        else
        {
            rowsAffected = await db.Database.ExecuteSqlRawAsync(
                "UPDATE user_quotas SET used_storage_bytes = GREATEST(0, used_storage_bytes + {0}), updated_at = NOW() WHERE user_id = {1}",
                deltaBytes,
                userId);
        }

        return rowsAffected > 0 || !await db.UserQuotas.AnyAsync(q => q.UserId == userId);
    }
}

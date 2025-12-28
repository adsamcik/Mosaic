using Microsoft.Extensions.Logging;

namespace Mosaic.Backend.Logging;

/// <summary>
/// High-performance logger extensions using the [LoggerMessage] source generator.
/// Benefits:
/// - Zero boxing of value types
/// - Template parsing at compile-time
/// - Automatic IsEnabled checks
/// - Compile-time validation of templates
/// </summary>
public static partial class Log
{
    #region Request Lifecycle (1000-1099)

    [LoggerMessage(
        EventId = LogEvents.RequestCompleted,
        Level = LogLevel.Information,
        Message = "{Method} {Path} responded {StatusCode} in {ElapsedMs}ms")]
    public static partial void RequestCompleted(
        this ILogger logger,
        string method,
        string path,
        int statusCode,
        long elapsedMs);

    [LoggerMessage(
        EventId = LogEvents.RequestFailed,
        Level = LogLevel.Warning,
        Message = "{Method} {Path} failed with {StatusCode} in {ElapsedMs}ms")]
    public static partial void RequestFailed(
        this ILogger logger,
        string method,
        string path,
        int statusCode,
        long elapsedMs);

    [LoggerMessage(
        EventId = LogEvents.ModelValidationFailed,
        Level = LogLevel.Warning,
        Message = "Model validation failed for {Path}")]
    public static partial void ModelValidationFailed(
        this ILogger logger,
        string path);

    #endregion

    #region Authentication (1100-1199)

    [LoggerMessage(
        EventId = LogEvents.AuthChallengeSent,
        Level = LogLevel.Debug,
        Message = "Auth challenge sent to {Username}")]
    public static partial void AuthChallengeSent(
        this ILogger logger,
        string username);

    [LoggerMessage(
        EventId = LogEvents.AuthChallengeVerified,
        Level = LogLevel.Information,
        Message = "Auth challenge verified for {Username}")]
    public static partial void AuthChallengeVerified(
        this ILogger logger,
        string username);

    [LoggerMessage(
        EventId = LogEvents.AuthChallengeFailed,
        Level = LogLevel.Warning,
        Message = "Auth challenge failed for {Username}: {Reason}")]
    public static partial void AuthChallengeFailed(
        this ILogger logger,
        string username,
        string reason);

    [LoggerMessage(
        EventId = LogEvents.AuthRateLimited,
        Level = LogLevel.Warning,
        Message = "Auth rate limited for {Username} - too many attempts")]
    public static partial void AuthRateLimited(
        this ILogger logger,
        string username);

    [LoggerMessage(
        EventId = LogEvents.UserRegistered,
        Level = LogLevel.Information,
        Message = "New user registered: {Username}")]
    public static partial void UserRegistered(
        this ILogger logger,
        string username);

    [LoggerMessage(
        EventId = LogEvents.SessionCreated,
        Level = LogLevel.Debug,
        Message = "Session created for {Username}")]
    public static partial void SessionCreated(
        this ILogger logger,
        string username);

    [LoggerMessage(
        EventId = LogEvents.SessionInvalid,
        Level = LogLevel.Debug,
        Message = "Invalid or expired session")]
    public static partial void SessionInvalid(this ILogger logger);

    [LoggerMessage(
        EventId = LogEvents.UntrustedProxyRequest,
        Level = LogLevel.Warning,
        Message = "Untrusted proxy request from {RemoteIp}")]
    public static partial void UntrustedProxyRequest(
        this ILogger logger,
        string remoteIp);

    [LoggerMessage(
        EventId = LogEvents.MissingRemoteUser,
        Level = LogLevel.Warning,
        Message = "Missing Remote-User header from trusted proxy")]
    public static partial void MissingRemoteUser(this ILogger logger);

    [LoggerMessage(
        EventId = LogEvents.DevAuthLogin,
        Level = LogLevel.Debug,
        Message = "Dev auth login for {Username}")]
    public static partial void DevAuthLogin(
        this ILogger logger,
        string username);

    #endregion

    #region Albums (1200-1299)

    [LoggerMessage(
        EventId = LogEvents.AlbumCreated,
        Level = LogLevel.Information,
        Message = "Album {AlbumId} created by {UserId}")]
    public static partial void AlbumCreated(
        this ILogger logger,
        Guid albumId,
        Guid userId);

    [LoggerMessage(
        EventId = LogEvents.AlbumDeleted,
        Level = LogLevel.Information,
        Message = "Album {AlbumId} deleted by {UserId}")]
    public static partial void AlbumDeleted(
        this ILogger logger,
        Guid albumId,
        Guid userId);

    [LoggerMessage(
        EventId = LogEvents.AlbumAccessed,
        Level = LogLevel.Debug,
        Message = "Album {AlbumId} accessed by {UserId}")]
    public static partial void AlbumAccessed(
        this ILogger logger,
        Guid albumId,
        Guid userId);

    [LoggerMessage(
        EventId = LogEvents.AlbumNameUpdated,
        Level = LogLevel.Information,
        Message = "Album {AlbumId} name updated by {UserId}")]
    public static partial void AlbumNameUpdated(
        this ILogger logger,
        Guid albumId,
        Guid userId);

    [LoggerMessage(
        EventId = LogEvents.AlbumExpirationUpdated,
        Level = LogLevel.Information,
        Message = "Album {AlbumId} expiration updated by {UserId}")]
    public static partial void AlbumExpirationUpdated(
        this ILogger logger,
        Guid albumId,
        Guid userId);

    [LoggerMessage(
        EventId = LogEvents.AlbumNotFound,
        Level = LogLevel.Debug,
        Message = "Album {AlbumId} not found")]
    public static partial void AlbumNotFound(
        this ILogger logger,
        Guid albumId);

    [LoggerMessage(
        EventId = LogEvents.AlbumAccessDenied,
        Level = LogLevel.Warning,
        Message = "Album {AlbumId} access denied for {UserId}")]
    public static partial void AlbumAccessDenied(
        this ILogger logger,
        Guid albumId,
        Guid userId);

    [LoggerMessage(
        EventId = LogEvents.AlbumCountLimitExceeded,
        Level = LogLevel.Warning,
        Message = "Album count limit exceeded for {UserId}: {CurrentCount}/{MaxCount}")]
    public static partial void AlbumCountLimitExceeded(
        this ILogger logger,
        Guid userId,
        int currentCount,
        int maxCount);

    #endregion

    #region Members (1300-1399)

    [LoggerMessage(
        EventId = LogEvents.MemberAdded,
        Level = LogLevel.Information,
        Message = "Member {MemberId} added to album {AlbumId} with role {Role} by {AddedBy}")]
    public static partial void MemberAdded(
        this ILogger logger,
        Guid memberId,
        Guid albumId,
        string role,
        Guid addedBy);

    [LoggerMessage(
        EventId = LogEvents.MemberRemoved,
        Level = LogLevel.Information,
        Message = "Member {MemberId} removed from album {AlbumId} by {RemovedBy}")]
    public static partial void MemberRemoved(
        this ILogger logger,
        Guid memberId,
        Guid albumId,
        Guid removedBy);

    [LoggerMessage(
        EventId = LogEvents.MemberRoleUpdated,
        Level = LogLevel.Information,
        Message = "Member {MemberId} role updated to {Role} in album {AlbumId} by {UpdatedBy}")]
    public static partial void MemberRoleUpdated(
        this ILogger logger,
        Guid memberId,
        string role,
        Guid albumId,
        Guid updatedBy);

    [LoggerMessage(
        EventId = LogEvents.EpochRotated,
        Level = LogLevel.Information,
        Message = "Epoch rotated for album {AlbumId}, new epoch {EpochId}")]
    public static partial void EpochRotated(
        this ILogger logger,
        Guid albumId,
        int epochId);

    #endregion

    #region Uploads/Manifests/Shards (1400-1499)

    [LoggerMessage(
        EventId = LogEvents.UploadStarted,
        Level = LogLevel.Debug,
        Message = "Upload started: {FileId}, size {Size} bytes")]
    public static partial void UploadStarted(
        this ILogger logger,
        string fileId,
        long size);

    [LoggerMessage(
        EventId = LogEvents.UploadCompleted,
        Level = LogLevel.Information,
        Message = "Upload completed: {FileId}")]
    public static partial void UploadCompleted(
        this ILogger logger,
        string fileId);

    [LoggerMessage(
        EventId = LogEvents.ManifestCreated,
        Level = LogLevel.Information,
        Message = "Manifest created for album {AlbumId} with {ShardCount} shards by {UserId}")]
    public static partial void ManifestCreated(
        this ILogger logger,
        Guid albumId,
        int shardCount,
        Guid userId);

    [LoggerMessage(
        EventId = LogEvents.ManifestDeleted,
        Level = LogLevel.Information,
        Message = "Manifest {ManifestId} deleted from album {AlbumId} by {UserId}")]
    public static partial void ManifestDeleted(
        this ILogger logger,
        Guid manifestId,
        Guid albumId,
        Guid userId);

    [LoggerMessage(
        EventId = LogEvents.ShardDownloaded,
        Level = LogLevel.Debug,
        Message = "Shard {ShardId} downloaded")]
    public static partial void ShardDownloaded(
        this ILogger logger,
        Guid shardId);

    [LoggerMessage(
        EventId = LogEvents.PhotoCountLimitExceeded,
        Level = LogLevel.Warning,
        Message = "Photo count limit exceeded for album {AlbumId}: {CurrentCount}/{MaxCount}")]
    public static partial void PhotoCountLimitExceeded(
        this ILogger logger,
        Guid albumId,
        int currentCount,
        int maxCount);

    [LoggerMessage(
        EventId = LogEvents.PhotoSizeLimitExceeded,
        Level = LogLevel.Warning,
        Message = "Photo size limit exceeded for album {AlbumId}: {CurrentSize}/{MaxSize} bytes")]
    public static partial void PhotoSizeLimitExceeded(
        this ILogger logger,
        Guid albumId,
        long currentSize,
        long maxSize);

    #endregion

    #region Share Links (1500-1599)

    [LoggerMessage(
        EventId = LogEvents.ShareLinkCreated,
        Level = LogLevel.Information,
        Message = "Share link created for album {AlbumId} by {UserId}")]
    public static partial void ShareLinkCreated(
        this ILogger logger,
        Guid albumId,
        Guid userId);

    [LoggerMessage(
        EventId = LogEvents.ShareLinkAccessed,
        Level = LogLevel.Debug,
        Message = "Share link accessed for album {AlbumId}")]
    public static partial void ShareLinkAccessed(
        this ILogger logger,
        Guid albumId);

    [LoggerMessage(
        EventId = LogEvents.ShareLinkRevoked,
        Level = LogLevel.Information,
        Message = "Share link revoked for album {AlbumId} by {UserId}")]
    public static partial void ShareLinkRevoked(
        this ILogger logger,
        Guid albumId,
        Guid userId);

    [LoggerMessage(
        EventId = LogEvents.ShareLinkInvalid,
        Level = LogLevel.Debug,
        Message = "Invalid share link accessed")]
    public static partial void ShareLinkInvalid(this ILogger logger);

    #endregion

    #region Admin Operations (1600-1699)

    [LoggerMessage(
        EventId = LogEvents.AdminAccessDenied,
        Level = LogLevel.Warning,
        Message = "Admin access denied for {UserId} on {Path}")]
    public static partial void AdminAccessDenied(
        this ILogger logger,
        Guid userId,
        string path);

    [LoggerMessage(
        EventId = LogEvents.AdminUserPromoted,
        Level = LogLevel.Information,
        Message = "User {TargetUserId} promoted to admin by {AdminId}")]
    public static partial void AdminUserPromoted(
        this ILogger logger,
        Guid targetUserId,
        Guid adminId);

    [LoggerMessage(
        EventId = LogEvents.AdminUserDemoted,
        Level = LogLevel.Information,
        Message = "User {TargetUserId} demoted from admin by {AdminId}")]
    public static partial void AdminUserDemoted(
        this ILogger logger,
        Guid targetUserId,
        Guid adminId);

    [LoggerMessage(
        EventId = LogEvents.AdminQuotaUpdated,
        Level = LogLevel.Information,
        Message = "Quota updated for user {TargetUserId} by admin {AdminId}")]
    public static partial void AdminQuotaUpdated(
        this ILogger logger,
        Guid targetUserId,
        Guid adminId);

    [LoggerMessage(
        EventId = LogEvents.AdminLimitUpdated,
        Level = LogLevel.Information,
        Message = "Limits updated for album {AlbumId} by admin {AdminId}")]
    public static partial void AdminLimitUpdated(
        this ILogger logger,
        Guid albumId,
        Guid adminId);

    [LoggerMessage(
        EventId = LogEvents.AdminSettingUpdated,
        Level = LogLevel.Information,
        Message = "System setting '{SettingKey}' updated by admin {AdminId}")]
    public static partial void AdminSettingUpdated(
        this ILogger logger,
        string settingKey,
        Guid adminId);

    #endregion

    #region Background Services (1700-1799)

    [LoggerMessage(
        EventId = LogEvents.GarbageCollectionStarted,
        Level = LogLevel.Debug,
        Message = "Garbage collection started")]
    public static partial void GarbageCollectionStarted(this ILogger logger);

    [LoggerMessage(
        EventId = LogEvents.GarbageCollectionCompleted,
        Level = LogLevel.Information,
        Message = "Garbage collection completed: {OrphanedBlobs} blobs, {ExpiredSessions} sessions, {ExpiredLinks} links, {ExpiredAlbums} albums cleaned")]
    public static partial void GarbageCollectionCompleted(
        this ILogger logger,
        int orphanedBlobs,
        int expiredSessions,
        int expiredLinks,
        int expiredAlbums);

    [LoggerMessage(
        EventId = LogEvents.GarbageCollectionFailed,
        Level = LogLevel.Error,
        Message = "Garbage collection failed")]
    public static partial void GarbageCollectionFailed(
        this ILogger logger,
        Exception exception);

    [LoggerMessage(
        EventId = LogEvents.OrphanedBlobsCleaned,
        Level = LogLevel.Debug,
        Message = "Cleaned {Count} orphaned blobs")]
    public static partial void OrphanedBlobsCleaned(
        this ILogger logger,
        int count);

    [LoggerMessage(
        EventId = LogEvents.ExpiredSessionsCleaned,
        Level = LogLevel.Debug,
        Message = "Cleaned {Count} expired sessions")]
    public static partial void ExpiredSessionsCleaned(
        this ILogger logger,
        int count);

    [LoggerMessage(
        EventId = LogEvents.ExpiredLinksCleaned,
        Level = LogLevel.Debug,
        Message = "Cleaned {Count} expired links")]
    public static partial void ExpiredLinksCleaned(
        this ILogger logger,
        int count);

    [LoggerMessage(
        EventId = LogEvents.ExpiredAlbumsCleaned,
        Level = LogLevel.Debug,
        Message = "Cleaned {Count} expired albums")]
    public static partial void ExpiredAlbumsCleaned(
        this ILogger logger,
        int count);

    #endregion

    #region Quota/Limits (1800-1899)

    [LoggerMessage(
        EventId = LogEvents.QuotaExceeded,
        Level = LogLevel.Warning,
        Message = "Quota exceeded for user {UserId}: {CurrentUsage}/{MaxBytes} bytes")]
    public static partial void QuotaExceeded(
        this ILogger logger,
        Guid userId,
        long currentUsage,
        long maxBytes);

    [LoggerMessage(
        EventId = LogEvents.QuotaCacheRefreshed,
        Level = LogLevel.Debug,
        Message = "Quota settings cache refreshed")]
    public static partial void QuotaCacheRefreshed(this ILogger logger);

    [LoggerMessage(
        EventId = LogEvents.QuotaSettingsParseFailed,
        Level = LogLevel.Warning,
        Message = "Failed to parse quota setting '{SettingKey}'")]
    public static partial void QuotaSettingsParseFailed(
        this ILogger logger,
        string settingKey);

    #endregion

    #region Errors (9000-9999)

    [LoggerMessage(
        EventId = LogEvents.UnhandledException,
        Level = LogLevel.Error,
        Message = "Unhandled exception: {ExceptionType} at {Path}")]
    public static partial void UnhandledException(
        this ILogger logger,
        Exception exception,
        string exceptionType,
        string path);

    [LoggerMessage(
        EventId = LogEvents.DatabaseError,
        Level = LogLevel.Error,
        Message = "Database error: {Operation}")]
    public static partial void DatabaseError(
        this ILogger logger,
        Exception exception,
        string operation);

    [LoggerMessage(
        EventId = LogEvents.StorageError,
        Level = LogLevel.Error,
        Message = "Storage error: {Operation}")]
    public static partial void StorageError(
        this ILogger logger,
        Exception exception,
        string operation);

    #endregion
}

namespace Mosaic.Backend.Logging;

/// <summary>
/// Centralized event IDs for structured logging.
/// Using unique IDs enables filtering and correlation in log aggregators.
/// 
/// ID Ranges:
/// - 1000-1099: Request/Response lifecycle
/// - 1100-1199: Authentication
/// - 1200-1299: Albums
/// - 1300-1399: Members
/// - 1400-1499: Uploads/Manifests/Shards
/// - 1500-1599: Share links
/// - 1600-1699: Admin operations
/// - 1700-1799: Background services
/// - 1800-1899: Quota/Limits
/// - 9000-9999: Errors
/// </summary>
public static class LogEvents
{
    // Request lifecycle (1000-1099)
    public const int RequestStarted = 1000;
    public const int RequestCompleted = 1001;
    public const int RequestFailed = 1002;
    public const int ModelValidationFailed = 1010;

    // Authentication (1100-1199)
    public const int AuthChallengeSent = 1100;
    public const int AuthChallengeVerified = 1101;
    public const int AuthChallengeFailed = 1102;
    public const int AuthRateLimited = 1103;
    public const int UserRegistered = 1104;
    public const int SessionCreated = 1105;
    public const int SessionValidated = 1106;
    public const int SessionInvalid = 1107;
    public const int UntrustedProxyRequest = 1110;
    public const int MissingRemoteUser = 1111;
    public const int DevAuthLogin = 1120;

    // Albums (1200-1299)
    public const int AlbumCreated = 1200;
    public const int AlbumDeleted = 1201;
    public const int AlbumAccessed = 1202;
    public const int AlbumNameUpdated = 1203;
    public const int AlbumExpirationUpdated = 1204;
    public const int AlbumNotFound = 1210;
    public const int AlbumAccessDenied = 1211;
    public const int AlbumCountLimitExceeded = 1212;

    // Members (1300-1399)
    public const int MemberAdded = 1300;
    public const int MemberRemoved = 1301;
    public const int MemberRoleUpdated = 1302;
    public const int EpochRotated = 1303;
    public const int EpochKeyFetched = 1304;

    // Uploads/Manifests/Shards (1400-1499)
    public const int UploadStarted = 1400;
    public const int UploadCompleted = 1401;
    public const int UploadFailed = 1402;
    public const int ManifestCreated = 1410;
    public const int ManifestDeleted = 1411;
    public const int ShardCreated = 1420;
    public const int ShardDeleted = 1421;
    public const int ShardDownloaded = 1422;
    public const int ShardLimitExceeded = 1430;
    public const int PhotoCountLimitExceeded = 1431;
    public const int PhotoSizeLimitExceeded = 1432;

    // Share links (1500-1599)
    public const int ShareLinkCreated = 1500;
    public const int ShareLinkAccessed = 1501;
    public const int ShareLinkRevoked = 1502;
    public const int ShareLinkExpired = 1503;
    public const int ShareLinkInvalid = 1504;

    // Admin operations (1600-1699)
    public const int AdminAccessDenied = 1600;
    public const int AdminUserPromoted = 1610;
    public const int AdminUserDemoted = 1611;
    public const int AdminQuotaUpdated = 1620;
    public const int AdminLimitUpdated = 1621;
    public const int AdminSettingUpdated = 1630;

    // Background services (1700-1799)
    public const int GarbageCollectionStarted = 1700;
    public const int GarbageCollectionCompleted = 1701;
    public const int GarbageCollectionFailed = 1702;
    public const int OrphanedBlobsCleaned = 1710;
    public const int ExpiredSessionsCleaned = 1711;
    public const int ExpiredLinksCleaned = 1712;
    public const int ExpiredAlbumsCleaned = 1713;

    // Quota/Limits (1800-1899)
    public const int QuotaExceeded = 1800;
    public const int QuotaCacheRefreshed = 1810;
    public const int QuotaSettingsParseFailed = 1811;

    // Errors (9000-9999)
    public const int UnhandledException = 9000;
    public const int DatabaseError = 9001;
    public const int StorageError = 9002;
    public const int CryptoError = 9003;
}

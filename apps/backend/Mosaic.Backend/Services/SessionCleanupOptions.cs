namespace Mosaic.Backend.Services;

/// <summary>
/// Retention policy for session records (v1.0.x s40). Mirrors
/// <see cref="IdempotencyOptions"/> shape so it can be bound from configuration via
/// the <c>Session:Cleanup</c> section and overridden in tests.
/// </summary>
/// <remarks>
/// Defaults align with the s40 sweep requirements:
/// <list type="bullet">
/// <item>Revoked sessions retain their IP/UserAgent/DeviceName telemetry for 30 days
///   after revocation, then are purged.</item>
/// <item>Expired sessions are tolerated for 7 days past <c>ExpiresAt</c> (covers
///   client clock skew and lazy revocation paths), then are purged.</item>
/// </list>
/// </remarks>
public sealed class SessionCleanupOptions
{
    public TimeSpan RevokedRetentionPeriod { get; set; } = TimeSpan.FromDays(30);

    public TimeSpan ExpiredRetentionPeriod { get; set; } = TimeSpan.FromDays(7);

    public TimeSpan CleanupInterval { get; set; } = TimeSpan.FromHours(6);

    public TimeSpan EffectiveRevokedRetentionPeriod
        => RevokedRetentionPeriod > TimeSpan.Zero ? RevokedRetentionPeriod : TimeSpan.FromDays(30);

    public TimeSpan EffectiveExpiredRetentionPeriod
        => ExpiredRetentionPeriod > TimeSpan.Zero ? ExpiredRetentionPeriod : TimeSpan.FromDays(7);

    public TimeSpan EffectiveCleanupInterval
        => CleanupInterval > TimeSpan.Zero ? CleanupInterval : TimeSpan.FromHours(6);
}

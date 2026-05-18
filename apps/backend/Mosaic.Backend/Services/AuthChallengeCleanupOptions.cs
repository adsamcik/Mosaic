namespace Mosaic.Backend.Services;

/// <summary>
/// Retention policy for the <c>AuthChallenges</c> table (v1.0.x s44-y1).
/// Mirrors <see cref="SessionCleanupOptions"/> shape and is bound from the
/// <c>AuthChallenge:Cleanup</c> configuration section.
/// </summary>
/// <remarks>
/// Challenges have a very short native TTL (60 seconds), but the row itself
/// lingers in the table until cleaned up. This background sweep deletes any
/// row whose <c>ExpiresAt &lt; now</c>, complementing the opportunistic
/// per-request cleanup in <c>AuthController</c>.
/// </remarks>
public sealed class AuthChallengeCleanupOptions
{
    /// <summary>How often the cleanup sweep runs. Default: 30 minutes.</summary>
    public TimeSpan CleanupInterval { get; set; } = TimeSpan.FromMinutes(30);

    public TimeSpan EffectiveCleanupInterval
        => CleanupInterval > TimeSpan.Zero ? CleanupInterval : TimeSpan.FromMinutes(30);
}

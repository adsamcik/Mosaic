namespace Mosaic.Backend.Services;

/// <summary>
/// Configuration for the background garbage-collection sweep run by
/// <see cref="GarbageCollectionService"/>. The sweep handles expired sessions,
/// orphaned shards, expired share links, expired albums/manifests, and expired
/// Tus upload reservations.
/// </summary>
public sealed class GcOptions
{
    /// <summary>
    /// Interval between garbage-collection passes. The default of 1 hour
    /// matches the legacy hardcoded cadence. Override via the
    /// <c>Gc__GcInterval</c> environment variable (e.g. <c>00:15:00</c>).
    /// </summary>
    public TimeSpan GcInterval { get; set; } = TimeSpan.FromHours(1);
}

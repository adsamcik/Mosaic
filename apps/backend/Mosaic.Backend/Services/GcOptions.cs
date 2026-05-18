using Microsoft.Extensions.Options;

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
    /// Lower bound on <see cref="GcInterval"/>. Anything below this would
    /// self-DoS the service via continuous GC passes
    /// (security-review-2026-05-18-03). Validation rejects misconfigured
    /// values at startup rather than silently clamping at runtime.
    /// </summary>
    public static readonly TimeSpan MinimumGcInterval = TimeSpan.FromMinutes(1);

    /// <summary>
    /// Interval between garbage-collection passes. The default of 1 hour
    /// matches the legacy hardcoded cadence. Override via the
    /// <c>Gc__GcInterval</c> environment variable (e.g. <c>00:15:00</c>).
    /// Values below <see cref="MinimumGcInterval"/> are rejected by
    /// <see cref="GcOptionsValidator"/>.
    /// </summary>
    public TimeSpan GcInterval { get; set; } = TimeSpan.FromHours(1);
}

/// <summary>
/// Fail-fast validator that prevents the service from starting with a
/// dangerously small <see cref="GcOptions.GcInterval"/>. Registered via
/// <c>AddSingleton&lt;IValidateOptions&lt;GcOptions&gt;&gt;</c> in <c>Program.cs</c>.
/// </summary>
internal sealed class GcOptionsValidator : IValidateOptions<GcOptions>
{
    public ValidateOptionsResult Validate(string? name, GcOptions options)
    {
        if (options.GcInterval < GcOptions.MinimumGcInterval)
        {
            return ValidateOptionsResult.Fail(
                $"Gc__GcInterval ({options.GcInterval}) is below the minimum " +
                $"{GcOptions.MinimumGcInterval}; continuous GC passes would " +
                "self-DoS the service. Configure a value >= 00:01:00.");
        }

        return ValidateOptionsResult.Success;
    }
}

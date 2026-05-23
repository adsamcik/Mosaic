using System.Collections.Concurrent;

namespace Mosaic.Backend.Services;

/// <summary>
/// Per-share-link failed-attempt tracker with a sliding-window lockout.
///
/// <para>
/// v1.0.2 share-link-pake-rate-limit hardening: prior to this service the
/// share-link access endpoint <c>GET /api/v1/s/{linkId}</c> rate-limited only
/// by the global per-IP fixed-window limiter. That global gate is shared with
/// every other public endpoint and is too coarse to defend the 16-byte link
/// secret against per-link enumeration: an attacker can spread guesses across
/// many IPs (or below the global threshold) while still focusing them on a
/// single link / link surface.
/// </para>
///
/// <para>
/// The tracker is keyed by the <i>presented</i> linkId string (the raw URL
/// segment). That deliberately includes malformed / 404 inputs so an attacker
/// who keeps guessing the same target linkId is locked out after
/// <see cref="MaxAttempts"/> failures inside the
/// <see cref="AttemptWindow"/>. Successful resolutions reset the counter.
/// </para>
///
/// <para>
/// In-memory, single-process. Backed by <see cref="ConcurrentDictionary{TKey,TValue}"/>
/// mirroring the proven SidecarRateLimiter pattern; no IMemoryCache size budget
/// to fight. Bucket entries are pruned opportunistically on every interaction
/// so the dictionary does not grow unbounded under attack: each bucket evicts
/// itself once the lockout window has elapsed with no further failures.
/// </para>
/// </summary>
public sealed class ShareLinkAttemptTracker
{
    /// <summary>Maximum failed attempts allowed inside <see cref="AttemptWindow"/> before lockout.</summary>
    public const int MaxAttempts = 5;

    /// <summary>Sliding window in which failed attempts accumulate.</summary>
    public static readonly TimeSpan AttemptWindow = TimeSpan.FromMinutes(15);

    /// <summary>Lockout duration once the failure threshold is exceeded.</summary>
    public static readonly TimeSpan LockoutDuration = TimeSpan.FromHours(1);

    private readonly TimeProvider _time;
    private readonly ConcurrentDictionary<string, Bucket> _buckets = new(StringComparer.Ordinal);

    public ShareLinkAttemptTracker(TimeProvider? timeProvider = null)
    {
        _time = timeProvider ?? TimeProvider.System;
    }

    /// <summary>
    /// Returns the remaining lockout TimeSpan (positive value) if the link is
    /// currently locked, otherwise null.
    /// </summary>
    public TimeSpan? GetLockoutRemaining(string linkKey)
    {
        if (string.IsNullOrEmpty(linkKey))
        {
            return null;
        }

        if (!_buckets.TryGetValue(linkKey, out var bucket))
        {
            return null;
        }

        var now = _time.GetUtcNow();
        lock (bucket.Gate)
        {
            if (bucket.LockedUntil is { } until && until > now)
            {
                return until - now;
            }
            return null;
        }
    }

    /// <summary>
    /// Records a failed access attempt for <paramref name="linkKey"/> and
    /// returns the remaining lockout window if this attempt tripped (or is
    /// inside) the lockout, otherwise null.
    /// </summary>
    public TimeSpan? RecordFailure(string linkKey)
    {
        if (string.IsNullOrEmpty(linkKey))
        {
            return null;
        }

        var now = _time.GetUtcNow();
        var cutoff = now - AttemptWindow;
        var bucket = _buckets.GetOrAdd(linkKey, _ => new Bucket());

        lock (bucket.Gate)
        {
            if (bucket.LockedUntil is { } until && until > now)
            {
                return until - now;
            }

            // Window expired since previous lockout — recycle.
            if (bucket.LockedUntil is { } prev && prev <= now)
            {
                bucket.LockedUntil = null;
                bucket.Failures.Clear();
            }

            while (bucket.Failures.Count > 0 && bucket.Failures.Peek() <= cutoff)
            {
                bucket.Failures.Dequeue();
            }

            bucket.Failures.Enqueue(now);

            if (bucket.Failures.Count >= MaxAttempts)
            {
                bucket.LockedUntil = now + LockoutDuration;
                bucket.Failures.Clear();
                return LockoutDuration;
            }

            return null;
        }
    }

    /// <summary>
    /// Records a successful resolution. Clears any in-window failures so a
    /// legitimate visitor's history does not carry forward.
    /// </summary>
    public void RecordSuccess(string linkKey)
    {
        if (string.IsNullOrEmpty(linkKey))
        {
            return;
        }

        if (_buckets.TryGetValue(linkKey, out var bucket))
        {
            lock (bucket.Gate)
            {
                bucket.Failures.Clear();
                bucket.LockedUntil = null;
            }
            _buckets.TryRemove(linkKey, out _);
        }
    }

    /// <summary>Test/diagnostic helper: drop all stored buckets.</summary>
    internal void Reset() => _buckets.Clear();

    /// <summary>Test/diagnostic helper: prune expired buckets and return how many were removed.</summary>
    internal int PruneExpired()
    {
        var now = _time.GetUtcNow();
        var cutoff = now - AttemptWindow;
        var removed = 0;
        foreach (var (key, bucket) in _buckets)
        {
            lock (bucket.Gate)
            {
                if (bucket.LockedUntil is { } until && until > now)
                {
                    continue;
                }

                while (bucket.Failures.Count > 0 && bucket.Failures.Peek() <= cutoff)
                {
                    bucket.Failures.Dequeue();
                }

                if (bucket.Failures.Count == 0 && bucket.LockedUntil is null)
                {
                    if (_buckets.TryRemove(key, out _))
                    {
                        removed++;
                    }
                }
            }
        }
        return removed;
    }

    private sealed class Bucket
    {
        public readonly object Gate = new();
        public readonly Queue<DateTimeOffset> Failures = new();
        public DateTimeOffset? LockedUntil;
    }
}

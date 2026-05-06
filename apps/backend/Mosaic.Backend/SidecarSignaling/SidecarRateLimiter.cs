using System.Collections.Concurrent;
using Microsoft.Extensions.Options;

namespace Mosaic.Backend.SidecarSignaling;

/// <summary>
/// Per-IP sliding-window rate limiter for room creation. In-memory only, single-process.
/// Bypass-resistant: rapid open/close from the same IP is counted against the same window
/// because every accepted *creation* call records a timestamp; only timestamps older than
/// the window are pruned, so reconnects don't reset the counter.
/// </summary>
public sealed class SidecarRateLimiter
{
    private readonly SidecarSignalingOptions _options;
    private readonly TimeProvider _time;
    private readonly ConcurrentDictionary<string, Bucket> _buckets = new();

    public SidecarRateLimiter(IOptions<SidecarSignalingOptions> options, TimeProvider time)
    {
        _options = options.Value;
        _time = time;
    }

    /// <summary>
    /// Returns true if a new room creation is allowed for <paramref name="ip"/>.
    /// On true, the timestamp is recorded.
    /// </summary>
    public bool TryAcquire(string ip)
    {
        var now = _time.GetUtcNow();
        var cutoff = now - _options.RateLimitWindow;
        var bucket = _buckets.GetOrAdd(ip, _ => new Bucket());

        lock (bucket.Gate)
        {
            // Prune expired entries.
            while (bucket.Hits.Count > 0 && bucket.Hits.Peek() <= cutoff)
            {
                bucket.Hits.Dequeue();
            }

            if (bucket.Hits.Count >= _options.MaxRoomsPerIp)
            {
                return false;
            }

            bucket.Hits.Enqueue(now);
            return true;
        }
    }

    /// <summary>Test/diagnostic helper: drop all stored buckets.</summary>
    internal void Reset() => _buckets.Clear();

    /// <summary>Test/diagnostic helper: drop expired entries across all IPs.</summary>
    internal int PruneExpired()
    {
        var now = _time.GetUtcNow();
        var cutoff = now - _options.RateLimitWindow;
        var pruned = 0;
        foreach (var (ip, bucket) in _buckets)
        {
            lock (bucket.Gate)
            {
                while (bucket.Hits.Count > 0 && bucket.Hits.Peek() <= cutoff)
                {
                    bucket.Hits.Dequeue();
                    pruned++;
                }
                if (bucket.Hits.Count == 0)
                {
                    _buckets.TryRemove(ip, out _);
                }
            }
        }
        return pruned;
    }

    private sealed class Bucket
    {
        public readonly object Gate = new();
        public readonly Queue<DateTimeOffset> Hits = new();
    }
}

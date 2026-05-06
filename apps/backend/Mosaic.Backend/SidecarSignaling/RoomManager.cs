using System.Collections.Concurrent;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Mosaic.Backend.SidecarSignaling;

/// <summary>
/// Tracks active sidecar rooms in memory. The manager holds NO persistent state and
/// stores nothing in the database. A background sweep evicts rooms past their TTL,
/// so even if both relay loops crash mid-flight the dictionary cannot leak entries.
/// </summary>
public sealed class RoomManager : BackgroundService
{
    private readonly ConcurrentDictionary<string, Room> _rooms = new();
    private readonly SidecarSignalingOptions _options;
    private readonly TimeProvider _time;
    private readonly ILogger<RoomManager> _logger;
    private readonly SidecarRateLimiter _rateLimiter;
    private readonly ILoggerFactory _loggerFactory;

    public RoomManager(
        IOptions<SidecarSignalingOptions> options,
        TimeProvider time,
        ILogger<RoomManager> logger,
        ILoggerFactory loggerFactory,
        SidecarRateLimiter rateLimiter)
    {
        _options = options.Value;
        _time = time;
        _logger = logger;
        _loggerFactory = loggerFactory;
        _rateLimiter = rateLimiter ?? throw new ArgumentNullException(nameof(rateLimiter));
    }

    /// <summary>Snapshot of currently tracked rooms (test/diagnostic only).</summary>
    public int RoomCount => _rooms.Count;

    /// <summary>
    /// Returns the existing room for <paramref name="roomId"/> if one is open, otherwise
    /// creates a new room (and counts toward the caller's "creation" budget — handled by
    /// the caller, not here).
    /// </summary>
    internal Room GetOrCreate(string roomId)
    {
        return _rooms.GetOrAdd(roomId, id =>
        {
            var room = new Room(
                id,
                _time.GetUtcNow(),
                _options,
                _loggerFactory.CreateLogger($"SidecarRoom[{id[..Math.Min(8, id.Length)]}]"));
            return room;
        });
    }

    /// <summary>
    /// True if a room with the given id is currently tracked. Used by the rate limiter
    /// to distinguish "join existing" from "create new".
    /// </summary>
    internal bool TryGet(string roomId, out Room? room)
    {
        var ok = _rooms.TryGetValue(roomId, out var r);
        room = r;
        return ok;
    }

    /// <summary>Detach the room from tracking. Idempotent.</summary>
    internal async Task RemoveAsync(string roomId)
    {
        if (_rooms.TryRemove(roomId, out var room))
        {
            await room.DisposeAsync().ConfigureAwait(false);
        }
    }

    /// <summary>Sweep loop: purges rooms whose deadline has passed.</summary>
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(_options.SweepInterval, _time, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            // Prune stale per-IP rate-limit buckets so memory stays bounded with diverse IPs.
            _rateLimiter.PruneExpired();

            var now = _time.GetUtcNow();
            foreach (var (id, room) in _rooms)
            {
                if (room.IsClosed || now >= room.Deadline)
                {
                    room.MarkClosed();
                    if (_rooms.TryRemove(id, out var removed))
                    {
                        try { await removed.DisposeAsync().ConfigureAwait(false); }
                        catch (Exception ex) { _logger.LogDebug(ex, "Error disposing expired room {RoomId}", id); }
                    }
                }
            }
        }
    }
}

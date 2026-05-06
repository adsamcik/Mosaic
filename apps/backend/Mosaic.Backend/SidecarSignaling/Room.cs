using System.Net.WebSockets;
using Microsoft.Extensions.Logging;

namespace Mosaic.Backend.SidecarSignaling;

/// <summary>
/// A signaling room holds at most two WebSocket connections that relay opaque
/// frames to each other. The server NEVER inspects payload bytes — frames are
/// copied verbatim from one peer to the other.
///
/// State machine: Empty -> WaitingForPeer (1 socket) -> Paired (2 sockets) -> Closed.
/// </summary>
internal sealed class Room : IAsyncDisposable
{
    public string RoomId { get; }
    public DateTimeOffset CreatedAt { get; }
    public DateTimeOffset Deadline { get; }

    private readonly SidecarSignalingOptions _options;
    private readonly ILogger _logger;
    private readonly object _gate = new();
    private readonly CancellationTokenSource _cts = new();

    private WebSocket? _peerA;
    private WebSocket? _peerB;
    private int _messageCount;
    private int _byteCount;
    private bool _closed;

    public Room(string roomId, DateTimeOffset createdAt, SidecarSignalingOptions options, ILogger logger)
    {
        RoomId = roomId;
        CreatedAt = createdAt;
        Deadline = createdAt + options.RoomTtl;
        _options = options;
        _logger = logger;
    }

    /// <summary>Cancellation token that fires when the room is closed (TTL, full, peer left, limit hit).</summary>
    public CancellationToken Cancellation => _cts.Token;

    public bool IsClosed
    {
        get { lock (_gate) { return _closed; } }
    }

    /// <summary>Result of a join attempt.</summary>
    public enum JoinResult { Joined, RoomFull, RoomClosed }

    /// <summary>
    /// Attempts to attach <paramref name="socket"/> to this room. Returns the socket of the
    /// peer (if one is already connected) so the caller can begin relaying.
    /// </summary>
    public JoinResult TryJoin(WebSocket socket, out WebSocket? peer)
    {
        lock (_gate)
        {
            peer = null;
            if (_closed)
            {
                return JoinResult.RoomClosed;
            }

            if (_peerA is null)
            {
                _peerA = socket;
                return JoinResult.Joined;
            }

            if (_peerB is null)
            {
                _peerB = socket;
                peer = _peerA;
                return JoinResult.Joined;
            }

            return JoinResult.RoomFull;
        }
    }

    /// <summary>
    /// Returns the peer socket for the calling socket (the "other" side), or null if
    /// the peer hasn't joined yet or has already left.
    /// </summary>
    public WebSocket? GetPeer(WebSocket self)
    {
        lock (_gate)
        {
            if (ReferenceEquals(self, _peerA)) return _peerB;
            if (ReferenceEquals(self, _peerB)) return _peerA;
            return null;
        }
    }

    /// <summary>
    /// Records a relayed frame against the room's per-room budgets. Returns
    /// false if a budget was exhausted, in which case the caller should
    /// <see cref="CloseAsync"/> with a 1011 close.
    /// </summary>
    public bool TryAccountFrame(int frameBytes)
    {
        lock (_gate)
        {
            if (_closed) return false;
            if (frameBytes > _options.MaxFrameBytes) return false;
            if (_messageCount + 1 > _options.MaxMessagesPerRoom) return false;
            if ((long)_byteCount + frameBytes > _options.MaxBytesPerRoom) return false;
            _messageCount += 1;
            _byteCount += frameBytes;
            return true;
        }
    }

    /// <summary>
    /// Marks the room as closed and signals cancellation to any pumps. Idempotent.
    /// Does not close the underlying sockets — the relay loop is responsible for
    /// sending the appropriate WebSocket close frame.
    /// </summary>
    public void MarkClosed()
    {
        lock (_gate)
        {
            if (_closed) return;
            _closed = true;
        }
        try { _cts.Cancel(); } catch (ObjectDisposedException) { /* benign race */ }
    }

    public async ValueTask DisposeAsync()
    {
        MarkClosed();
        // Best-effort close of any sockets still attached. The relay loop normally does this,
        // but DisposeAsync runs from the cleanup sweep when both sides have already detached.
        WebSocket? a, b;
        lock (_gate) { a = _peerA; b = _peerB; _peerA = null; _peerB = null; }
        await TryAbortAsync(a).ConfigureAwait(false);
        await TryAbortAsync(b).ConfigureAwait(false);
        _cts.Dispose();
    }

    private static ValueTask TryAbortAsync(WebSocket? socket)
    {
        if (socket is null) return ValueTask.CompletedTask;
        try { socket.Abort(); } catch { /* swallow */ }
        return ValueTask.CompletedTask;
    }
}

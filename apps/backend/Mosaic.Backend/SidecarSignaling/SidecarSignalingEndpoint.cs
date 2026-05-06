using System.Net.WebSockets;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Mosaic.Backend.SidecarSignaling;

/// <summary>
/// Minimal-API WebSocket relay for the Sidecar Beacon. The relay is intentionally
/// unauthenticated: tying it to user identity would defeat the threat model (the
/// server learning who is pairing with whom). Confidentiality of the pairing is
/// provided end-to-end by the PAKE handshake on top of this transport.
///
/// Server invariants enforced here:
///   * Payload bytes are never inspected — frames round-trip verbatim.
///   * No DB persistence; in-memory rooms only.
///   * Hard TTL cutoff regardless of activity (linked CTS with CancelAfter).
///   * Per-IP creation rate limit; per-room frame/byte/count limits.
/// </summary>
public static partial class SidecarSignalingEndpoint
{
    private const string BasePath = "/api/sidecar";
    private const string SignalPath = BasePath + "/signal/{roomId}";
    private const string HealthPath = BasePath + "/health";

    [GeneratedRegex(@"^[0-9a-f]{32}$", RegexOptions.Compiled)]
    private static partial Regex RoomIdPattern();

    public static IEndpointRouteBuilder MapSidecarSignaling(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet(SignalPath, HandleSignalAsync);
        endpoints.MapGet(HealthPath, (RoomManager mgr) =>
            Results.Ok(new { rooms = mgr.RoomCount }));
        return endpoints;
    }

    private static async Task HandleSignalAsync(
        HttpContext httpContext,
        string roomId,
        RoomManager rooms,
        SidecarRateLimiter rateLimiter,
        IOptions<SidecarSignalingOptions> opts,
        ILoggerFactory loggerFactory,
        TimeProvider time)
    {
        var logger = loggerFactory.CreateLogger("SidecarSignal");

        if (!httpContext.WebSockets.IsWebSocketRequest)
        {
            httpContext.Response.StatusCode = StatusCodes.Status400BadRequest;
            await httpContext.Response.WriteAsync("WebSocket upgrade required");
            return;
        }

        if (!RoomIdPattern().IsMatch(roomId))
        {
            httpContext.Response.StatusCode = StatusCodes.Status400BadRequest;
            await httpContext.Response.WriteAsync("Invalid room id");
            return;
        }

        var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        var options = opts.Value;

        // Rate limit applies only when this connection would CREATE a room.
        // Joining an existing room is governed by the creator's budget + the
        // hard "room full" cap of 2 sockets, so it doesn't need its own limit.
        var roomExists = rooms.TryGet(roomId, out _);
        if (!roomExists && !rateLimiter.TryAcquire(ip))
        {
            httpContext.Response.StatusCode = StatusCodes.Status429TooManyRequests;
            await httpContext.Response.WriteAsync("Too many sidecar rooms from this address");
            return;
        }

        var socket = await httpContext.WebSockets.AcceptWebSocketAsync();

        var room = rooms.GetOrCreate(roomId);
        // If the room is already past its deadline (raced against the sweep), refuse.
        if (time.GetUtcNow() >= room.Deadline)
        {
            await CloseQuietlyAsync(socket, WebSocketCloseStatus.NormalClosure, "room expired");
            await rooms.RemoveAsync(roomId);
            return;
        }

        var join = room.TryJoin(socket, out var peer);
        switch (join)
        {
            case Room.JoinResult.RoomFull:
                logger.LogDebug("Sidecar room {RoomId} full; rejecting third connection", roomId);
                await CloseQuietlyAsync(socket, WebSocketCloseStatus.PolicyViolation, "room full");
                return;
            case Room.JoinResult.RoomClosed:
                await CloseQuietlyAsync(socket, WebSocketCloseStatus.NormalClosure, "room closed");
                return;
        }

        // Build the lifecycle CTS: aborts when (a) the request is cancelled,
        // (b) the room is closed by the peer or limits, or (c) the hard TTL fires.
        using var lifecycle = CancellationTokenSource.CreateLinkedTokenSource(
            httpContext.RequestAborted, room.Cancellation);
        var ttlRemaining = room.Deadline - time.GetUtcNow();
        if (ttlRemaining < TimeSpan.Zero) ttlRemaining = TimeSpan.Zero;
        lifecycle.CancelAfter(ttlRemaining);

        try
        {
            await PumpAsync(socket, room, options, lifecycle.Token, logger);
        }
        catch (OperationCanceledException)
        {
            // Either TTL expired or the peer closed; handled below.
        }
        catch (WebSocketException ex)
        {
            logger.LogDebug(ex, "Sidecar pump WebSocketException for room {RoomId}", roomId);
        }
        finally
        {
            // Decide a close reason for *this* socket.
            var (status, reason) = SelectCloseReason(room, time);
            await CloseQuietlyAsync(socket, status, reason);

            // Notify peer (if still attached) that the relay is over.
            var stillPeer = room.GetPeer(socket);
            if (stillPeer is not null)
            {
                await CloseQuietlyAsync(stillPeer, status, reason);
            }

            room.MarkClosed();
            await rooms.RemoveAsync(roomId);
        }
    }

    /// <summary>
    /// The bidirectional pump runs ONLY in the receive direction for the local socket;
    /// frames are forwarded byte-for-byte to the peer. The peer's pump (running on its
    /// own request) does the symmetric job. This keeps each direction single-threaded
    /// so we don't need locks around <see cref="WebSocket.SendAsync"/>.
    /// </summary>
    private static async Task PumpAsync(
        WebSocket self,
        Room room,
        SidecarSignalingOptions options,
        CancellationToken token,
        ILogger logger)
    {
        // Buffer is sized to MaxFrameBytes + 1 so we can detect oversize frames
        // without allocating per-message. We never inspect or interpret bytes here.
        var buffer = new byte[options.MaxFrameBytes + 1];

        while (!token.IsCancellationRequested && self.State == WebSocketState.Open)
        {
            var filled = 0;
            WebSocketReceiveResult? result = null;
            while (true)
            {
                if (filled >= buffer.Length)
                {
                    // Frame exceeds MaxFrameBytes; drain and abort.
                    logger.LogDebug("Sidecar room {RoomId}: frame exceeded MaxFrameBytes", room.RoomId);
                    room.MarkClosed();
                    return;
                }

                try
                {
                    result = await self.ReceiveAsync(
                        new ArraySegment<byte>(buffer, filled, buffer.Length - filled), token);
                }
                catch (WebSocketException)
                {
                    return;
                }

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    return;
                }

                filled += result.Count;
                if (result.EndOfMessage) break;
            }

            if (result is null) return;

            if (filled > options.MaxFrameBytes)
            {
                room.MarkClosed();
                return;
            }

            if (!room.TryAccountFrame(filled))
            {
                logger.LogDebug("Sidecar room {RoomId}: frame budget exhausted", room.RoomId);
                room.MarkClosed();
                return;
            }

            var peer = room.GetPeer(self);
            if (peer is null || peer.State != WebSocketState.Open)
            {
                // Peer hasn't joined yet — drop the frame.
                // (PAKE/SDP exchange always serializes responder-after-initiator-msg1, so
                //  in practice the first frame from peer-A may arrive before peer-B joins.
                //  We deliberately drop instead of buffering: a server-side queue would
                //  be a side-channel, and the pairing protocol re-sends on reconnect.)
                continue;
            }

            try
            {
                await peer.SendAsync(
                    new ArraySegment<byte>(buffer, 0, filled),
                    result.MessageType, // verbatim (binary or text — we don't care)
                    endOfMessage: true,
                    cancellationToken: token);
            }
            catch (OperationCanceledException) { return; }
            catch (WebSocketException)
            {
                // Peer died mid-send; let the lifecycle teardown notify our side.
                return;
            }
        }
    }

    private static (WebSocketCloseStatus, string) SelectCloseReason(Room room, TimeProvider time)
    {
        if (time.GetUtcNow() >= room.Deadline)
        {
            return (WebSocketCloseStatus.NormalClosure, "room ttl expired");
        }
        // Room marked closed by frame-budget violation -> InternalServerError (1011).
        // Otherwise it's a normal disconnect.
        return room.IsClosed
            ? (WebSocketCloseStatus.NormalClosure, "peer disconnected")
            : (WebSocketCloseStatus.NormalClosure, "peer disconnected");
    }

    private static async Task CloseQuietlyAsync(WebSocket socket, WebSocketCloseStatus status, string reason)
    {
        try
        {
            if (socket.State == WebSocketState.Open || socket.State == WebSocketState.CloseReceived)
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await socket.CloseAsync(status, reason, cts.Token);
            }
        }
        catch
        {
            try { socket.Abort(); } catch { /* swallow */ }
        }
    }
}

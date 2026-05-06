namespace Mosaic.Backend.SidecarSignaling;

/// <summary>
/// Configuration for the sidecar signaling relay. All limits are intentionally
/// small: the relay only carries PAKE handshake messages and (eventually) WebRTC
/// SDP/ICE candidates. Each room is opaque to the server — payload bytes are
/// never inspected.
/// </summary>
public sealed class SidecarSignalingOptions
{
    /// <summary>Hard wall-clock cap from room creation. After this, both sides are closed.</summary>
    public TimeSpan RoomTtl { get; set; } = TimeSpan.FromSeconds(120);

    /// <summary>Maximum bytes per single signaling frame.</summary>
    public int MaxFrameBytes { get; set; } = 8 * 1024;

    /// <summary>Total number of frames a room may relay before it is closed.</summary>
    public int MaxMessagesPerRoom { get; set; } = 50;

    /// <summary>Total bytes a room may relay before it is closed.</summary>
    public int MaxBytesPerRoom { get; set; } = 64 * 1024;

    /// <summary>Number of rooms a single source IP may create within <see cref="RateLimitWindow"/>.</summary>
    public int MaxRoomsPerIp { get; set; } = 5;

    /// <summary>Sliding window used by the per-IP room-creation rate limiter.</summary>
    public TimeSpan RateLimitWindow { get; set; } = TimeSpan.FromMinutes(1);

    /// <summary>How often the cleanup sweep runs. Independent of <see cref="RoomTtl"/> — the room
    /// itself enforces the TTL via a per-room deadline timer; sweeping is a defensive backstop.</summary>
    public TimeSpan SweepInterval { get; set; } = TimeSpan.FromSeconds(10);
}

using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Mosaic.Backend.SidecarSignaling;
using Xunit;

namespace Mosaic.Backend.Tests;

/// <summary>
/// Integration tests for the Sidecar Beacon signaling relay. We exercise the
/// full middleware stack via <see cref="WebApplicationFactory{TEntryPoint}"/>
/// and the in-memory <see cref="TestServer"/> WebSocket transport.
/// </summary>
public sealed class SidecarSignalingTests : IClassFixture<SidecarSignalingTests.DefaultFactory>
{
    private readonly Factory _factory;

    public SidecarSignalingTests(DefaultFactory factory)
    {
        _factory = factory;
        // Each test starts from a clean rate-limit state so that ordering is
        // independent. Singleton across the fixture preserves the relay graph.
        var limiter = _factory.Services.GetRequiredService<SidecarRateLimiter>();
        typeof(SidecarRateLimiter).GetMethod("Reset",
            System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)
            !.Invoke(limiter, null);
    }

    private static string NewRoomId()
    {
        // 32 lowercase hex chars (16 bytes) — matches HKDF output the client produces.
        var bytes = RandomNumberGenerator.GetBytes(16);
        var sb = new StringBuilder(32);
        foreach (var b in bytes) sb.Append(b.ToString("x2"));
        return sb.ToString();
    }

    private async Task<WebSocket> ConnectAsync(string roomId, CancellationToken ct = default)
    {
        var wsClient = _factory.Server.CreateWebSocketClient();
        var uri = new Uri(_factory.Server.BaseAddress, $"/api/sidecar/signal/{roomId}");
        return await wsClient.ConnectAsync(uri, ct);
    }

    private static async Task SendBinaryAsync(WebSocket ws, byte[] payload, CancellationToken ct = default)
    {
        await ws.SendAsync(payload, WebSocketMessageType.Binary, endOfMessage: true, ct);
    }

    private static async Task<(byte[] payload, WebSocketMessageType type, WebSocketCloseStatus? closeStatus)> ReceiveOnceAsync(
        WebSocket ws, int maxBytes = 16 * 1024, CancellationToken ct = default)
    {
        var buf = new byte[maxBytes];
        var filled = 0;
        while (true)
        {
            var res = await ws.ReceiveAsync(new ArraySegment<byte>(buf, filled, buf.Length - filled), ct);
            if (res.MessageType == WebSocketMessageType.Close)
            {
                return (Array.Empty<byte>(), res.MessageType, res.CloseStatus);
            }
            filled += res.Count;
            if (res.EndOfMessage)
            {
                var slice = new byte[filled];
                Array.Copy(buf, slice, filled);
                return (slice, res.MessageType, null);
            }
            if (filled == buf.Length) throw new InvalidOperationException("Receive buffer exhausted");
        }
    }

    [Fact]
    public async Task TwoClients_RelayBinaryPayloads_Bidirectionally_Verbatim()
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var roomId = NewRoomId();

        using var a = await ConnectAsync(roomId, cts.Token);
        using var b = await ConnectAsync(roomId, cts.Token);

        // Random binary payload — the server MUST round-trip exactly without inspection.
        var payloadAtoB = RandomNumberGenerator.GetBytes(2048);
        var payloadBtoA = RandomNumberGenerator.GetBytes(1024);

        await SendBinaryAsync(a, payloadAtoB, cts.Token);
        var (recvB, typeB, _) = await ReceiveOnceAsync(b, ct: cts.Token);
        Assert.Equal(WebSocketMessageType.Binary, typeB);
        Assert.Equal(payloadAtoB, recvB);

        await SendBinaryAsync(b, payloadBtoA, cts.Token);
        var (recvA, typeA, _) = await ReceiveOnceAsync(a, ct: cts.Token);
        Assert.Equal(WebSocketMessageType.Binary, typeA);
        Assert.Equal(payloadBtoA, recvA);
    }

    [Fact]
    public async Task ServerNeverInspectsPayload_RandomBytesRoundTrip()
    {
        // Adversarial: include bytes that look like JSON, control chars, UTF-8
        // continuation patterns, etc. If the server tries to decode anything,
        // the round-trip will fail.
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var roomId = NewRoomId();
        using var a = await ConnectAsync(roomId, cts.Token);
        using var b = await ConnectAsync(roomId, cts.Token);

        for (var i = 0; i < 5; i++)
        {
            var size = 16 + (i * 311) % 4000;
            var payload = RandomNumberGenerator.GetBytes(size);
            await SendBinaryAsync(a, payload, cts.Token);
            var (recv, type, _) = await ReceiveOnceAsync(b, ct: cts.Token);
            Assert.Equal(WebSocketMessageType.Binary, type);
            Assert.Equal(payload, recv);
        }
    }

    [Fact]
    public async Task PeerDisconnect_NotifiesOtherSide()
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var roomId = NewRoomId();
        var a = await ConnectAsync(roomId, cts.Token);
        var b = await ConnectAsync(roomId, cts.Token);

        await a.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", cts.Token);

        var (_, type, status) = await ReceiveOnceAsync(b, ct: cts.Token);
        Assert.Equal(WebSocketMessageType.Close, type);
        Assert.NotNull(status);

        a.Dispose();
        b.Dispose();
    }

    [Fact]
    public async Task ThirdConnection_IsRejectedAsRoomFull()
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var roomId = NewRoomId();
        using var a = await ConnectAsync(roomId, cts.Token);
        using var b = await ConnectAsync(roomId, cts.Token);

        using var c = await ConnectAsync(roomId, cts.Token);
        var (_, type, status) = await ReceiveOnceAsync(c, ct: cts.Token);
        Assert.Equal(WebSocketMessageType.Close, type);
        Assert.Equal(WebSocketCloseStatus.PolicyViolation, status);
    }

    [Fact]
    public async Task FrameLargerThanLimit_ClosesRoom()
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var roomId = NewRoomId();
        using var a = await ConnectAsync(roomId, cts.Token);
        using var b = await ConnectAsync(roomId, cts.Token);

        // 8 KiB + 1 byte exceeds MaxFrameBytes.
        var oversize = new byte[8 * 1024 + 1];
        RandomNumberGenerator.Fill(oversize);
        await SendBinaryAsync(a, oversize, cts.Token);

        // Both sides should observe a close.
        var (_, typeB, _) = await ReceiveOnceAsync(b, maxBytes: 32 * 1024, ct: cts.Token);
        Assert.Equal(WebSocketMessageType.Close, typeB);
    }

    [Fact]
    public async Task MaxMessageCountExceeded_ClosesRoom()
    {
        // Override options just for this test by spinning a fresh factory with tighter limits.
        await using var factory = new Factory(opts =>
        {
            opts.MaxMessagesPerRoom = 3;
        });
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var roomId = NewRoomId();

        var wsClient = factory.Server.CreateWebSocketClient();
        var uri = new Uri(factory.Server.BaseAddress, $"/api/sidecar/signal/{roomId}");
        using var a = await wsClient.ConnectAsync(uri, cts.Token);
        using var b = await wsClient.ConnectAsync(uri, cts.Token);

        await SendBinaryAsync(a, new byte[] { 1 }, cts.Token);
        await ReceiveOnceAsync(b, ct: cts.Token);
        await SendBinaryAsync(a, new byte[] { 2 }, cts.Token);
        await ReceiveOnceAsync(b, ct: cts.Token);
        await SendBinaryAsync(a, new byte[] { 3 }, cts.Token);
        await ReceiveOnceAsync(b, ct: cts.Token);

        // The 4th frame should trip the budget.
        await SendBinaryAsync(a, new byte[] { 4 }, cts.Token);
        var observedClose = false;
        try
        {
            var (_, type, _) = await ReceiveOnceAsync(b, ct: cts.Token);
            observedClose = type == WebSocketMessageType.Close;
        }
        catch (WebSocketException) { observedClose = true; }
        Assert.True(observedClose, "expected room to close after exceeding MaxMessagesPerRoom");
    }

    [Fact]
    public async Task TtlHardCutoff_ClosesActiveRoom()
    {
        // Tight TTL: even with traffic, the room MUST be force-closed at the deadline.
        await using var factory = new Factory(opts =>
        {
            opts.RoomTtl = TimeSpan.FromSeconds(1);
            opts.SweepInterval = TimeSpan.FromMilliseconds(250);
        });
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var roomId = NewRoomId();

        var wsClient = factory.Server.CreateWebSocketClient();
        var uri = new Uri(factory.Server.BaseAddress, $"/api/sidecar/signal/{roomId}");
        var a = await wsClient.ConnectAsync(uri, cts.Token);
        var b = await wsClient.ConnectAsync(uri, cts.Token);

        // Generate background traffic so we prove the cutoff is wall-clock, not idle-based.
        var trafficCts = CancellationTokenSource.CreateLinkedTokenSource(cts.Token);
        var traffic = Task.Run(async () =>
        {
            try
            {
                while (!trafficCts.IsCancellationRequested && a.State == WebSocketState.Open)
                {
                    await SendBinaryAsync(a, new byte[] { 0xAB }, trafficCts.Token);
                    await Task.Delay(50, trafficCts.Token);
                }
            }
            catch { /* expected on close */ }
        }, trafficCts.Token);

        // Drain b until close.
        var observedClose = false;
        var deadline = DateTime.UtcNow.AddSeconds(8);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var (_, type, _) = await ReceiveOnceAsync(b, ct: cts.Token);
                if (type == WebSocketMessageType.Close) { observedClose = true; break; }
            }
            catch (WebSocketException) { observedClose = true; break; }
        }

        trafficCts.Cancel();
        try { await traffic; } catch { }
        a.Dispose();
        b.Dispose();

        Assert.True(observedClose, "expected room to be force-closed at TTL");
    }

    [Fact]
    public async Task PerIpRateLimit_TripsAfterMaxRoomsPerIp()
    {
        await using var factory = new Factory(opts =>
        {
            opts.MaxRoomsPerIp = 2;
            opts.RateLimitWindow = TimeSpan.FromMinutes(5);
        });
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));

        var wsClient = factory.Server.CreateWebSocketClient();

        // First two creations succeed.
        var ws1 = await wsClient.ConnectAsync(
            new Uri(factory.Server.BaseAddress, $"/api/sidecar/signal/{NewRoomId()}"), cts.Token);
        var ws2 = await wsClient.ConnectAsync(
            new Uri(factory.Server.BaseAddress, $"/api/sidecar/signal/{NewRoomId()}"), cts.Token);

        // Third creation from same IP should fail with 429 (which surfaces as a
        // failed WebSocket handshake).
        await Assert.ThrowsAnyAsync<Exception>(async () =>
        {
            await wsClient.ConnectAsync(
                new Uri(factory.Server.BaseAddress, $"/api/sidecar/signal/{NewRoomId()}"), cts.Token);
        });

        ws1.Dispose();
        ws2.Dispose();
    }

    [Fact]
    public async Task HealthEndpoint_ReturnsRoomCount()
    {
        using var http = _factory.CreateClient();
        var resp = await http.GetAsync("/api/sidecar/health");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadAsStringAsync();
        Assert.Contains("\"rooms\"", body);
    }

    /// <summary>
    /// Custom <see cref="WebApplicationFactory{TEntryPoint}"/> that bootstraps the real
    /// Program with the "Testing" environment (which already disables auth-bearing
    /// rate limits) and lets each test override sidecar-specific options.
    /// </summary>
    /// <summary>Parameterless factory for xUnit IClassFixture (uses default options).</summary>
    public sealed class DefaultFactory : Factory { public DefaultFactory() : base(null) { } }

    public class Factory : WebApplicationFactory<Program>
    {
        private readonly Action<SidecarSignalingOptions>? _configureSidecar;

        public Factory(Action<SidecarSignalingOptions>? configureSidecar = null)
        {
            _configureSidecar = configureSidecar;
        }

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Testing");
            builder.ConfigureServices(services =>
            {
                if (_configureSidecar is not null)
                {
                    services.Configure(_configureSidecar);
                }
            });
        }
    }
}

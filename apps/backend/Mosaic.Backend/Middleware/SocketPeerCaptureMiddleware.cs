using System.Net;

namespace Mosaic.Backend.Middleware;

/// <summary>
/// Captures the immediate TCP peer before forwarded-header processing rewrites
/// <see cref="ConnectionInfo.RemoteIpAddress"/> to the originating client.
/// Proxy-auth trust decisions must use this value, never a forwarded address.
/// </summary>
public sealed class SocketPeerCaptureMiddleware
{
    internal const string SocketPeerAddressItemKey = "Mosaic.SocketPeerAddress";

    private readonly RequestDelegate _next;

    public SocketPeerCaptureMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public Task InvokeAsync(HttpContext context)
    {
        context.Items[SocketPeerAddressItemKey] = context.Connection.RemoteIpAddress;
        return _next(context);
    }

    internal static IPAddress? GetSocketPeerAddress(HttpContext context)
        => context.Items.TryGetValue(SocketPeerAddressItemKey, out var value)
            ? value as IPAddress
            : null;
}

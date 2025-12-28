using Microsoft.AspNetCore.Http;

namespace Mosaic.Backend.Tests.Helpers;

/// <summary>
/// Factory for creating test HTTP contexts with authentication
/// </summary>
public static class TestHttpContext
{
    /// <summary>
    /// Creates an HTTP context with the specified auth subject set
    /// </summary>
    public static HttpContext Create(string authSub)
    {
        var context = new DefaultHttpContext();
        context.Items["AuthSub"] = authSub;
        return context;
    }

    /// <summary>
    /// Creates an HTTP context without authentication
    /// </summary>
    public static HttpContext CreateUnauthenticated()
    {
        return new DefaultHttpContext();
    }
}

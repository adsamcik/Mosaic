using Microsoft.AspNetCore.Http;
using Mosaic.Backend.Middleware;
using Xunit;

namespace Mosaic.Backend.Tests.Middleware;

public class CorrelationIdMiddlewareTests
{
    [Fact]
    public async Task NoHeader_GeneratesCorrelationId()
    {
        var nextCalled = false;
        var middleware = new CorrelationIdMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });
        var ctx = new DefaultHttpContext();

        await middleware.InvokeAsync(ctx);

        Assert.True(nextCalled);
        Assert.NotNull(ctx.GetCorrelationId());
    }

    [Theory]
    [InlineData("abc-123_DEF")]
    [InlineData("a")]
    public async Task ValidHeader_IsAccepted(string id)
    {
        var nextCalled = false;
        var middleware = new CorrelationIdMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });
        var ctx = new DefaultHttpContext();
        ctx.Request.Headers["X-Correlation-Id"] = id;

        await middleware.InvokeAsync(ctx);

        Assert.True(nextCalled);
        Assert.Equal(id, ctx.GetCorrelationId());
    }

    [Theory]
    [InlineData("has space")]
    [InlineData("invalid$chars")]
    [InlineData("punct.with.dots")]
    [InlineData("semi;colon")]
    public async Task InvalidCharset_Returns400(string id)
    {
        var nextCalled = false;
        var middleware = new CorrelationIdMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });
        var ctx = new DefaultHttpContext();
        ctx.Request.Headers["X-Correlation-Id"] = id;
        ctx.Response.Body = new MemoryStream();

        await middleware.InvokeAsync(ctx);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status400BadRequest, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task OverLength_Returns400()
    {
        var nextCalled = false;
        var middleware = new CorrelationIdMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });
        var ctx = new DefaultHttpContext();
        ctx.Request.Headers["X-Correlation-Id"] = new string('a', CorrelationIdMiddleware.MaxCorrelationIdLength + 1);
        ctx.Response.Body = new MemoryStream();

        await middleware.InvokeAsync(ctx);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status400BadRequest, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task AtMaxLength_IsAccepted()
    {
        var nextCalled = false;
        var middleware = new CorrelationIdMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });
        var ctx = new DefaultHttpContext();
        var id = new string('a', CorrelationIdMiddleware.MaxCorrelationIdLength);
        ctx.Request.Headers["X-Correlation-Id"] = id;

        await middleware.InvokeAsync(ctx);

        Assert.True(nextCalled);
        Assert.Equal(id, ctx.GetCorrelationId());
    }
}

using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace Mosaic.Backend.Middleware;

/// <summary>
/// A pass-through authentication handler that supports the Forbid operation.
/// The actual authentication is done by CombinedAuthMiddleware, which sets HttpContext.Items["AuthenticatedUser"].
/// This handler exists solely to provide a default scheme for Forbid() calls in controllers.
/// </summary>
public class PassThroughAuthenticationHandler : AuthenticationHandler<AuthenticationSchemeOptions>
{
    public const string SchemeName = "PassThrough";

    public PassThroughAuthenticationHandler(
        IOptionsMonitor<AuthenticationSchemeOptions> options,
        ILoggerFactory logger,
        UrlEncoder encoder)
        : base(options, logger, encoder)
    {
    }

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        // Check if CombinedAuthMiddleware already authenticated the user
        if (Context.Items.TryGetValue("AuthenticatedUser", out var userObj) && userObj is string username)
        {
            var claims = new[] { new Claim(ClaimTypes.Name, username) };
            var identity = new ClaimsIdentity(claims, SchemeName);
            var principal = new ClaimsPrincipal(identity);
            var ticket = new AuthenticationTicket(principal, SchemeName);
            return Task.FromResult(AuthenticateResult.Success(ticket));
        }

        // No authentication - return no result (not a failure, just no authentication)
        return Task.FromResult(AuthenticateResult.NoResult());
    }

    protected override Task HandleForbiddenAsync(AuthenticationProperties properties)
    {
        // Simply return 403 Forbidden
        Context.Response.StatusCode = 403;
        return Context.Response.WriteAsJsonAsync(new { error = "Access denied" });
    }

    protected override Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        // Simply return 401 Unauthorized
        Context.Response.StatusCode = 401;
        return Context.Response.WriteAsJsonAsync(new { error = "Authentication required" });
    }
}

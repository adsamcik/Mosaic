using System.Security.Cryptography;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;

namespace Mosaic.Backend.Controllers;

/// <summary>
/// Development-only authentication endpoints.
/// Provides simple username-based auth without cryptographic challenge-response.
/// This controller is only registered in Development environment.
/// </summary>
[ApiController]
[Route("api/dev-auth")]
public class DevAuthController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly ILogger<DevAuthController> _logger;

    public DevAuthController(MosaicDbContext db, ILogger<DevAuthController> logger)
    {
        _db = db;
        _logger = logger;
    }

    /// <summary>
    /// Quick login for development. Creates user if not exists.
    /// Sets a session cookie without cryptographic verification.
    /// </summary>
    [HttpPost("login")]
    public async Task<IActionResult> DevLogin([FromBody] DevLoginRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Username))
        {
            return BadRequest(new { error = "Username is required" });
        }

        // Find or create user
        var user = await _db.Users.FirstOrDefaultAsync(u => u.AuthSub == request.Username);
        
        if (user == null)
        {
            // Create a new dev user with minimal data
            user = new User
            {
                Id = Guid.CreateVersion7(),
                AuthSub = request.Username,
                IdentityPubkey = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)),
                UserSalt = RandomNumberGenerator.GetBytes(16),
                AccountSalt = RandomNumberGenerator.GetBytes(16)
            };
            _db.Users.Add(user);
            await _db.SaveChangesAsync();
            _logger.LogInformation("Created dev user: {Username}", request.Username);
        }

        // Create session
        var sessionToken = RandomNumberGenerator.GetBytes(32);
        var tokenHash = SHA256.HashData(sessionToken);

        var session = new Session
        {
            Id = Guid.CreateVersion7(),
            UserId = user.Id,
            TokenHash = tokenHash,
            ExpiresAt = DateTime.UtcNow.AddDays(30),
            UserAgent = Request.Headers.UserAgent.ToString(),
            IpAddress = HttpContext.Connection.RemoteIpAddress?.ToString(),
            DeviceName = "Dev Session"
        };
        _db.Sessions.Add(session);
        await _db.SaveChangesAsync();

        // Set session cookie
        Response.Cookies.Append("mosaic_session", Convert.ToBase64String(sessionToken), new CookieOptions
        {
            HttpOnly = true,
            Secure = false, // Allow HTTP in dev mode
            SameSite = SameSiteMode.Lax,
            Path = "/api",
            MaxAge = TimeSpan.FromDays(30)
        });

        _logger.LogInformation("Dev login successful: {Username}", request.Username);

        return Ok(new DevLoginResponse
        {
            UserId = user.Id,
            Username = user.AuthSub,
            UserSalt = user.UserSalt != null ? Convert.ToBase64String(user.UserSalt) : null,
            AccountSalt = user.AccountSalt != null ? Convert.ToBase64String(user.AccountSalt) : null
        });
    }

    public record DevLoginRequest(string Username);

    public record DevLoginResponse
    {
        public Guid UserId { get; init; }
        public required string Username { get; init; }
        public string? UserSalt { get; init; }
        public string? AccountSalt { get; init; }
    }
}

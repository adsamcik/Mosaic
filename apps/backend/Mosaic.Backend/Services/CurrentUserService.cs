using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;

namespace Mosaic.Backend.Services;

/// <summary>
/// Service for getting or creating the current authenticated user from HttpContext.
/// Extracts the AuthSub from the authentication middleware and ensures a User entity exists.
/// </summary>
public interface ICurrentUserService
{
    /// <summary>
    /// Gets the current user from the database, or creates a new user if one doesn't exist.
    /// </summary>
    /// <param name="context">The HTTP context containing the authenticated user's AuthSub.</param>
    /// <returns>The User entity for the authenticated user.</returns>
    /// <exception cref="UnauthorizedAccessException">Thrown when no AuthSub is present in the context.</exception>
    Task<User> GetOrCreateAsync(HttpContext context);
}

/// <summary>
/// Implementation of ICurrentUserService that manages user creation with quota initialization.
/// </summary>
public class CurrentUserService : ICurrentUserService
{
    private readonly MosaicDbContext _db;
    private readonly IConfiguration _config;

    public CurrentUserService(MosaicDbContext db, IConfiguration config)
    {
        _db = db;
        _config = config;
    }

    /// <inheritdoc />
    public async Task<User> GetOrCreateAsync(HttpContext context)
    {
        var authSub = context.Items["AuthSub"] as string
            ?? throw new UnauthorizedAccessException("No AuthSub found in request context");

        // Reuse user loaded by CombinedAuthMiddleware when available
        var user = context.Items["AuthUser"] as User
            ?? await _db.Users.FirstOrDefaultAsync(u => u.AuthSub == authSub);
        if (user == null)
        {
            // Use transaction to ensure User and UserQuota are created atomically
            await using var tx = await _db.Database.BeginTransactionAsync();
            try
            {
                user = new User
                {
                    Id = Guid.CreateVersion7(),
                    AuthSub = authSub,
                    IdentityPubkey = ""  // Set on first key upload
                };
                _db.Users.Add(user);

                // Create quota with default settings
                _db.UserQuotas.Add(new UserQuota
                {
                    UserId = user.Id,
                    MaxStorageBytes = _config.GetValue<long>("Quota:DefaultMaxBytes")
                });

                await _db.SaveChangesAsync();
                await tx.CommitAsync();
            }
            catch
            {
                await tx.RollbackAsync();
                throw;
            }
        }
        return user;
    }
}

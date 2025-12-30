using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Tests.Helpers;

/// <summary>
/// Mock current user service for testing.
/// Uses the AuthSub from HttpContext.Items to find or create users in the test database.
/// </summary>
public class MockCurrentUserService : ICurrentUserService
{
    private readonly MosaicDbContext _db;
    private readonly long _defaultMaxBytes;

    public MockCurrentUserService(MosaicDbContext db, long defaultMaxBytes = 10L * 1024 * 1024 * 1024)
    {
        _db = db;
        _defaultMaxBytes = defaultMaxBytes;
    }

    public async Task<User> GetOrCreateAsync(HttpContext context)
    {
        var authSub = context.Items["AuthSub"] as string
            ?? throw new UnauthorizedAccessException("No AuthSub found in request context");

        var user = await _db.Users.FirstOrDefaultAsync(u => u.AuthSub == authSub);
        if (user == null)
        {
            user = new User
            {
                Id = Guid.NewGuid(),
                AuthSub = authSub,
                IdentityPubkey = ""
            };
            _db.Users.Add(user);
            _db.UserQuotas.Add(new UserQuota
            {
                UserId = user.Id,
                MaxStorageBytes = _defaultMaxBytes
            });
            await _db.SaveChangesAsync();
        }
        return user;
    }
}

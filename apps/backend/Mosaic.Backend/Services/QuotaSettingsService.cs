using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;

namespace Mosaic.Backend.Services;

/// <summary>
/// System-wide quota and limit defaults.
/// </summary>
public record QuotaDefaults(
    long MaxStorageBytesPerUser,
    int MaxAlbumsPerUser,
    int MaxPhotosPerAlbum,
    long MaxBytesPerAlbum
);

/// <summary>
/// Service for managing quota settings with database persistence and caching.
/// </summary>
public interface IQuotaSettingsService
{
    /// <summary>
    /// Get system-wide quota defaults.
    /// Returns from cache if available, otherwise from database or config.
    /// </summary>
    Task<QuotaDefaults> GetDefaultsAsync();

    /// <summary>
    /// Update system-wide quota defaults.
    /// </summary>
    Task<QuotaDefaults> SetDefaultsAsync(QuotaDefaults defaults, Guid updatedBy);

    /// <summary>
    /// Get effective max storage bytes for a user.
    /// Returns user-specific override if set, otherwise system default.
    /// </summary>
    Task<long> GetEffectiveMaxStorageBytesAsync(Guid userId);

    /// <summary>
    /// Get effective max albums for a user.
    /// Returns user-specific override if set, otherwise system default.
    /// </summary>
    Task<int> GetEffectiveMaxAlbumsAsync(Guid userId);

    /// <summary>
    /// Get effective max photos for an album.
    /// Returns album-specific override if set, otherwise system default.
    /// </summary>
    Task<int> GetEffectiveMaxPhotosAsync(Guid albumId);

    /// <summary>
    /// Get effective max size for an album.
    /// Returns album-specific override if set, otherwise system default.
    /// </summary>
    Task<long> GetEffectiveMaxAlbumSizeAsync(Guid albumId);
}

public class QuotaSettingsService : IQuotaSettingsService
{
    private readonly MosaicDbContext _db;
    private readonly IConfiguration _config;
    private readonly IMemoryCache _cache;
    private readonly ILogger<QuotaSettingsService> _logger;

    private const string QuotaDefaultsKey = "quota.defaults";
    private const string CacheKey = "QuotaDefaults";
    private static readonly TimeSpan CacheDuration = TimeSpan.FromMinutes(5);

    // Config fallback defaults
    private const long DefaultMaxStorageBytes = 10_737_418_240; // 10 GB
    private const int DefaultMaxAlbums = 100;
    private const int DefaultMaxPhotosPerAlbum = 10_000;
    private const long DefaultMaxBytesPerAlbum = 5_368_709_120; // 5 GB

    public QuotaSettingsService(
        MosaicDbContext db,
        IConfiguration config,
        IMemoryCache cache,
        ILogger<QuotaSettingsService> logger)
    {
        _db = db;
        _config = config;
        _cache = cache;
        _logger = logger;
    }

    public async Task<QuotaDefaults> GetDefaultsAsync()
    {
        if (_cache.TryGetValue(CacheKey, out QuotaDefaults? cached) && cached != null)
        {
            return cached;
        }

        var setting = await _db.SystemSettings.FindAsync(QuotaDefaultsKey);
        QuotaDefaults defaults;

        if (setting != null)
        {
            try
            {
                defaults = JsonSerializer.Deserialize<QuotaDefaults>(setting.Value)
                    ?? GetConfigDefaults();
            }
            catch (JsonException ex)
            {
                _logger.LogWarning(ex, "Failed to parse quota defaults from database, using config");
                defaults = GetConfigDefaults();
            }
        }
        else
        {
            defaults = GetConfigDefaults();
        }

        _cache.Set(CacheKey, defaults, CacheDuration);
        return defaults;
    }

    public async Task<QuotaDefaults> SetDefaultsAsync(QuotaDefaults defaults, Guid updatedBy)
    {
        var json = JsonSerializer.Serialize(defaults);
        var setting = await _db.SystemSettings.FindAsync(QuotaDefaultsKey);

        if (setting != null)
        {
            setting.Value = json;
            setting.UpdatedAt = DateTime.UtcNow;
            setting.UpdatedBy = updatedBy;
        }
        else
        {
            _db.SystemSettings.Add(new SystemSetting
            {
                Key = QuotaDefaultsKey,
                Value = json,
                UpdatedAt = DateTime.UtcNow,
                UpdatedBy = updatedBy
            });
        }

        await _db.SaveChangesAsync();
        _cache.Set(CacheKey, defaults, CacheDuration);

        _logger.LogInformation(
            "Quota defaults updated by {UserId}: MaxStorage={MaxStorage}, MaxAlbums={MaxAlbums}, MaxPhotos={MaxPhotos}, MaxAlbumSize={MaxAlbumSize}",
            updatedBy, defaults.MaxStorageBytesPerUser, defaults.MaxAlbumsPerUser,
            defaults.MaxPhotosPerAlbum, defaults.MaxBytesPerAlbum);

        return defaults;
    }

    public async Task<long> GetEffectiveMaxStorageBytesAsync(Guid userId)
    {
        var quota = await _db.UserQuotas.FindAsync(userId);
        if (quota?.MaxStorageBytes > 0)
        {
            return quota.MaxStorageBytes;
        }

        var defaults = await GetDefaultsAsync();
        return defaults.MaxStorageBytesPerUser;
    }

    public async Task<int> GetEffectiveMaxAlbumsAsync(Guid userId)
    {
        var quota = await _db.UserQuotas.FindAsync(userId);
        if (quota?.MaxAlbums.HasValue == true)
        {
            return quota.MaxAlbums.Value;
        }

        var defaults = await GetDefaultsAsync();
        return defaults.MaxAlbumsPerUser;
    }

    public async Task<int> GetEffectiveMaxPhotosAsync(Guid albumId)
    {
        var limits = await _db.AlbumLimits.FindAsync(albumId);
        if (limits?.MaxPhotos.HasValue == true)
        {
            return limits.MaxPhotos.Value;
        }

        var defaults = await GetDefaultsAsync();
        return defaults.MaxPhotosPerAlbum;
    }

    public async Task<long> GetEffectiveMaxAlbumSizeAsync(Guid albumId)
    {
        var limits = await _db.AlbumLimits.FindAsync(albumId);
        if (limits?.MaxSizeBytes.HasValue == true)
        {
            return limits.MaxSizeBytes.Value;
        }

        var defaults = await GetDefaultsAsync();
        return defaults.MaxBytesPerAlbum;
    }

    private QuotaDefaults GetConfigDefaults()
    {
        return new QuotaDefaults(
            MaxStorageBytesPerUser: _config.GetValue("Quota:DefaultMaxBytes", DefaultMaxStorageBytes),
            MaxAlbumsPerUser: _config.GetValue("Quota:DefaultMaxAlbums", DefaultMaxAlbums),
            MaxPhotosPerAlbum: _config.GetValue("Quota:DefaultMaxPhotosPerAlbum", DefaultMaxPhotosPerAlbum),
            MaxBytesPerAlbum: _config.GetValue("Quota:DefaultMaxBytesPerAlbum", DefaultMaxBytesPerAlbum)
        );
    }
}

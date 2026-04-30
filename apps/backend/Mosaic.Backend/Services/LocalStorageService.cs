namespace Mosaic.Backend.Services;

public class LocalStorageService : IStorageService
{
    private readonly string _basePath;

    public LocalStorageService(IConfiguration config)
    {
        _basePath = config["Storage:Path"]
            ?? throw new InvalidOperationException("Storage:Path not configured");

        Directory.CreateDirectory(_basePath);
    }

    /// <summary>
    /// Validates that a storage key doesn't contain path traversal sequences.
    /// </summary>
    /// <exception cref="ArgumentException">Thrown when the key contains invalid characters.</exception>
    private static void ValidateKey(string key)
    {
        if (string.IsNullOrEmpty(key))
        {
            throw new ArgumentException("Storage key cannot be null or empty", nameof(key));
        }

        // Prevent path traversal attacks
        // Explicitly check for both separators regardless of platform
        // (Path.AltDirectorySeparatorChar is '/' on both Windows and Linux)
        if (key.Contains("..") ||
            key.Contains('/') ||
            key.Contains('\\'))
        {
            throw new ArgumentException("Storage key contains invalid path characters", nameof(key));
        }
    }

    public Task<Stream> OpenReadAsync(string key)
    {
        ValidateKey(key);
        var path = Path.Combine(_basePath, key);
        return Task.FromResult<Stream>(File.OpenRead(path));
    }

    public Task DeleteAsync(string key)
    {
        ValidateKey(key);
        var path = Path.Combine(_basePath, key);
        if (File.Exists(path))
        {
            File.Delete(path);
        }
        return Task.CompletedTask;
    }
}

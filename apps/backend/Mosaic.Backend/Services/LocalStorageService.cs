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

    public Task<Stream> OpenReadAsync(string key)
    {
        var path = Path.Combine(_basePath, key);
        return Task.FromResult<Stream>(File.OpenRead(path));
    }

    public Task DeleteAsync(string key)
    {
        var path = Path.Combine(_basePath, key);
        if (File.Exists(path))
        {
            File.Delete(path);
        }
        return Task.CompletedTask;
    }
}

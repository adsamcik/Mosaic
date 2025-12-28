using Mosaic.Backend.Services;

namespace Mosaic.Backend.Tests.Helpers;

/// <summary>
/// Mock storage service for testing shard operations
/// </summary>
public class MockStorageService : IStorageService
{
    private readonly Dictionary<string, byte[]> _files = new();
    public List<string> DeletedKeys { get; } = [];

    /// <summary>
    /// Add a file to the mock storage
    /// </summary>
    public void AddFile(string key, byte[] content)
    {
        _files[key] = content;
    }

    /// <summary>
    /// Add a file with default content
    /// </summary>
    public void AddFile(string key)
    {
        _files[key] = new byte[] { 0x01, 0x02, 0x03, 0x04 };
    }

    public Task<Stream> OpenReadAsync(string key)
    {
        if (!_files.TryGetValue(key, out var content))
        {
            throw new FileNotFoundException($"File not found: {key}");
        }
        return Task.FromResult<Stream>(new MemoryStream(content));
    }

    public Task DeleteAsync(string key)
    {
        _files.Remove(key);
        DeletedKeys.Add(key);
        return Task.CompletedTask;
    }
}

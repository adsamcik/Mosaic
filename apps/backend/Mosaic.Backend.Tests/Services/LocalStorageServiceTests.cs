using Microsoft.Extensions.Configuration;
using Mosaic.Backend.Services;
using Xunit;

namespace Mosaic.Backend.Tests.Services;

public class LocalStorageServiceTests : IDisposable
{
    private readonly string _testPath;
    private readonly LocalStorageService _storage;

    public LocalStorageServiceTests()
    {
        _testPath = Path.Combine(Path.GetTempPath(), "mosaic-test-" + Guid.NewGuid());
        Directory.CreateDirectory(_testPath);

        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Storage:Path"] = _testPath
            })
            .Build();

        _storage = new LocalStorageService(config);
    }

    public void Dispose()
    {
        if (Directory.Exists(_testPath))
        {
            Directory.Delete(_testPath, recursive: true);
        }
        GC.SuppressFinalize(this);
    }

    [Fact]
    public async Task OpenReadAsync_ReturnsStream_WhenFileExists()
    {
        // Arrange
        var key = "test-file.bin";
        var content = new byte[] { 0x01, 0x02, 0x03, 0x04 };
        await File.WriteAllBytesAsync(Path.Combine(_testPath, key), content);

        // Act
        using var stream = await _storage.OpenReadAsync(key);

        // Assert
        Assert.NotNull(stream);
        using var memoryStream = new MemoryStream();
        await stream.CopyToAsync(memoryStream);
        Assert.Equal(content, memoryStream.ToArray());
    }

    [Fact]
    public async Task OpenReadAsync_ThrowsFileNotFound_WhenFileMissing()
    {
        // Arrange
        var key = "nonexistent-file.bin";

        // Act & Assert
        await Assert.ThrowsAsync<FileNotFoundException>(() => _storage.OpenReadAsync(key));
    }

    [Fact]
    public async Task OpenReadAsync_WorksWithSubdirectories()
    {
        // Arrange
        var key = "subdir/nested/file.bin";
        var fullPath = Path.Combine(_testPath, key);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        var content = new byte[] { 0xAB, 0xCD, 0xEF };
        await File.WriteAllBytesAsync(fullPath, content);

        // Act
        using var stream = await _storage.OpenReadAsync(key);

        // Assert
        Assert.NotNull(stream);
    }

    [Fact]
    public async Task DeleteAsync_DeletesFile_WhenExists()
    {
        // Arrange
        var key = "file-to-delete.bin";
        var fullPath = Path.Combine(_testPath, key);
        await File.WriteAllBytesAsync(fullPath, new byte[] { 0x01 });
        Assert.True(File.Exists(fullPath));

        // Act
        await _storage.DeleteAsync(key);

        // Assert
        Assert.False(File.Exists(fullPath));
    }

    [Fact]
    public async Task DeleteAsync_DoesNotThrow_WhenFileMissing()
    {
        // Arrange
        var key = "nonexistent-file.bin";

        // Act - should not throw
        await _storage.DeleteAsync(key);

        // Assert - no exception means success
    }

    [Fact]
    public async Task DeleteAsync_WorksWithSubdirectories()
    {
        // Arrange
        var key = "subdir/file-to-delete.bin";
        var fullPath = Path.Combine(_testPath, key);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        await File.WriteAllBytesAsync(fullPath, new byte[] { 0x01 });
        Assert.True(File.Exists(fullPath));

        // Act
        await _storage.DeleteAsync(key);

        // Assert
        Assert.False(File.Exists(fullPath));
        // Directory should still exist
        Assert.True(Directory.Exists(Path.GetDirectoryName(fullPath)));
    }

    [Fact]
    public void Constructor_CreatesDirectory_WhenMissing()
    {
        // Arrange
        var newPath = Path.Combine(Path.GetTempPath(), "mosaic-new-" + Guid.NewGuid());
        Assert.False(Directory.Exists(newPath));

        try
        {
            var config = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Storage:Path"] = newPath
                })
                .Build();

            // Act
            var _ = new LocalStorageService(config);

            // Assert
            Assert.True(Directory.Exists(newPath));
        }
        finally
        {
            if (Directory.Exists(newPath))
            {
                Directory.Delete(newPath, recursive: true);
            }
        }
    }

    [Fact]
    public void Constructor_ThrowsWhenStoragePathNotConfigured()
    {
        // Arrange
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>())
            .Build();

        // Act & Assert
        Assert.Throws<InvalidOperationException>(() => new LocalStorageService(config));
    }

    [Fact]
    public async Task OpenReadAsync_ReturnsReadableStream()
    {
        // Arrange - 64KB file (fast CI variant)
        var key = "readable-file.bin";
        var content = new byte[64 * 1024]; // 64KB
        new Random(42).NextBytes(content);
        await File.WriteAllBytesAsync(Path.Combine(_testPath, key), content);

        // Act
        using var stream = await _storage.OpenReadAsync(key);

        // Assert
        Assert.True(stream.CanRead);
        Assert.Equal(content.Length, stream.Length);
    }

    [Fact]
    [Trait("Category", "Nightly")]
    public async Task OpenReadAsync_ReturnsReadableStream_LargeFile()
    {
        // Arrange - 1MB file (nightly only for performance)
        var key = "large-file.bin";
        var content = new byte[1024 * 1024]; // 1MB
        new Random(42).NextBytes(content);
        await File.WriteAllBytesAsync(Path.Combine(_testPath, key), content);

        // Act
        using var stream = await _storage.OpenReadAsync(key);

        // Assert
        Assert.True(stream.CanRead);
        Assert.Equal(content.Length, stream.Length);
    }
}

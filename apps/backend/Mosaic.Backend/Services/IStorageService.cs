namespace Mosaic.Backend.Services;

public interface IStorageService
{
    Task<Stream> OpenReadAsync(string key);
    Task DeleteAsync(string key);
}

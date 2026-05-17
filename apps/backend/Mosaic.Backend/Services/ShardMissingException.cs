namespace Mosaic.Backend.Services;

/// <summary>
/// Thrown by <see cref="IStorageService.OpenReadAsync"/> when a shard's backing blob
/// is missing from local storage (e.g. it was trashed by the GC sweep but the database
/// row is still being read transiently). Controllers translate this to HTTP 410 Gone
/// with <c>{ code: "TRASHED" }</c> so clients can distinguish an authoritatively
/// deleted shard from a transient 5xx failure.
///
/// Inherits from <see cref="FileNotFoundException"/> for source-compat with callers
/// (and tests) that catch the base type.
/// </summary>
public sealed class ShardMissingException : FileNotFoundException
{
    public string StorageKey { get; }

    public ShardMissingException(string storageKey)
        : base($"Shard blob not found for storage key '{storageKey}'", storageKey)
    {
        StorageKey = storageKey;
    }

    public ShardMissingException(string storageKey, Exception innerException)
        : base($"Shard blob not found for storage key '{storageKey}'", storageKey, innerException)
    {
        StorageKey = storageKey;
    }
}

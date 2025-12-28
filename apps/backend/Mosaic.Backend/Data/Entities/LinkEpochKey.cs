namespace Mosaic.Backend.Data.Entities;

public class LinkEpochKey
{
    public Guid Id { get; set; }
    public Guid ShareLinkId { get; set; }
    public int EpochId { get; set; }
    public int Tier { get; set; }  // 1, 2, or 3
    public required byte[] WrappedNonce { get; set; }  // 24 bytes
    public required byte[] WrappedKey { get; set; }  // ciphertext + tag

    // Navigation
    public ShareLink ShareLink { get; set; } = null!;
}

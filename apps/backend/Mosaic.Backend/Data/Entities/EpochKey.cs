namespace Mosaic.Backend.Data.Entities;

public class EpochKey
{
    public Guid Id { get; set; }
    public Guid AlbumId { get; set; }
    public Guid RecipientId { get; set; }
    public int EpochId { get; set; }
    public required byte[] EncryptedKeyBundle { get; set; }
    public required byte[] OwnerSignature { get; set; }
    public required byte[] SharerPubkey { get; set; }
    public required byte[] SignPubkey { get; set; }  // Plaintext for server verification
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    // Navigation
    public Album Album { get; set; } = null!;
    public User Recipient { get; set; } = null!;
}

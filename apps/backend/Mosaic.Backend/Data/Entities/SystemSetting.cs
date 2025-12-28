namespace Mosaic.Backend.Data.Entities;

/// <summary>
/// Stores dynamic system-wide configuration as JSON values.
/// Used for settings that can be changed at runtime without restart.
/// </summary>
public class SystemSetting
{
    public required string Key { get; set; }
    public required string Value { get; set; }  // JSON string
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public Guid? UpdatedBy { get; set; }

    // Navigation
    public User? UpdatedByUser { get; set; }
}

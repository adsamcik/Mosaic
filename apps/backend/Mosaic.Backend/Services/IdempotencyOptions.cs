namespace Mosaic.Backend.Services;

public sealed class IdempotencyOptions
{
    public TimeSpan RetentionPeriod { get; set; } = TimeSpan.FromHours(24);

    public TimeSpan CleanupInterval { get; set; } = TimeSpan.FromHours(1);

    public double? RecordTtlHours { get; set; }

    public TimeSpan EffectiveRetentionPeriod
        => RecordTtlHours is > 0
            ? TimeSpan.FromHours(RecordTtlHours.Value)
            : RetentionPeriod > TimeSpan.Zero
                ? RetentionPeriod
                : TimeSpan.FromHours(24);

    public TimeSpan EffectiveCleanupInterval
        => CleanupInterval > TimeSpan.Zero ? CleanupInterval : TimeSpan.FromHours(1);
}

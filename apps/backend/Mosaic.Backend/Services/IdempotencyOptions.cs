namespace Mosaic.Backend.Services;

using Microsoft.Extensions.Options;

public sealed class IdempotencyOptions
{
    /// <summary>
    /// ADR-022 freezes the manifest finalization idempotency window at 30 days so
    /// cross-device upload retries survive the 64-attempt retry budget plus recovery buffer.
    /// </summary>
    public TimeSpan RetentionPeriod { get; set; } = IdempotencyOptionsValidator.MinimumRetentionPeriod;

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

public sealed class IdempotencyOptionsValidator : IValidateOptions<IdempotencyOptions>
{
    public static readonly TimeSpan MinimumRetentionPeriod = TimeSpan.FromDays(30);

    public ValidateOptionsResult Validate(string? name, IdempotencyOptions options)
    {
        if (options.EffectiveRetentionPeriod < MinimumRetentionPeriod)
        {
            return ValidateOptionsResult.Fail(
                "Idempotency:RetentionPeriod must be at least 30 days per ADR-022 manifest finalization idempotency TTL.");
        }

        return ValidateOptionsResult.Success;
    }
}

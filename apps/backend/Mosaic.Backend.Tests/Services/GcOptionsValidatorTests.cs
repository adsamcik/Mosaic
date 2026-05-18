using Microsoft.Extensions.Options;
using Mosaic.Backend.Services;
using Xunit;

namespace Mosaic.Backend.Tests.Services;

/// <summary>
/// Regression for security-review-2026-05-18-03. A dangerously small
/// <see cref="GcOptions.GcInterval"/> (e.g. milliseconds) would cause the
/// GC loop to fire continuously and starve the rest of the service. The
/// validator MUST reject such values at startup; the runtime constructor
/// MUST clamp them if validation is bypassed.
/// </summary>
public class GcOptionsValidatorTests
{
    [Theory]
    [InlineData("00:00:00")]   // zero
    [InlineData("00:00:00.001")] // 1 ms
    [InlineData("00:00:59.999")] // just below 1m
    public void Validate_RejectsValuesBelowOneMinute(string interval)
    {
        var validator = new GcOptionsValidator();
        var options = new GcOptions { GcInterval = TimeSpan.Parse(interval) };

        var result = validator.Validate(name: null, options);

        Assert.True(result.Failed);
        Assert.Contains("self-DoS", result.FailureMessage, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("00:01:00")]   // exact minimum
    [InlineData("00:15:00")]
    [InlineData("01:00:00")]   // default
    [InlineData("1.00:00:00")] // 1 day
    public void Validate_AcceptsValuesAtOrAboveOneMinute(string interval)
    {
        var validator = new GcOptionsValidator();
        var options = new GcOptions { GcInterval = TimeSpan.Parse(interval) };

        var result = validator.Validate(name: null, options);

        Assert.True(result.Succeeded);
    }

    [Fact]
    public void MinimumGcInterval_IsExactlyOneMinute()
    {
        // The wire contract: 1 minute is the documented minimum. Tests
        // and operators rely on this constant; bumping it must be a
        // deliberate, reviewed change.
        Assert.Equal(TimeSpan.FromMinutes(1), GcOptions.MinimumGcInterval);
    }
}

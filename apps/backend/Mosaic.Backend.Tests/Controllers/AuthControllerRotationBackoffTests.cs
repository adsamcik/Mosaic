using Mosaic.Backend.Controllers;
using Xunit;

namespace Mosaic.Backend.Tests.Controllers;

/// <summary>
/// Unit tests for the jittered backoff helper used by the password-rotation
/// retry loop (security-review-2026-05-19-15). The helper desynchronizes
/// retry timing across concurrent rotations so that two rotations that just
/// collided do not retry in lock-step and collide again.
/// </summary>
public class AuthControllerRotationBackoffTests
{
    [Theory]
    [InlineData(250)]
    [InlineData(500)]
    [InlineData(1000)]
    public void ComputeRotationBackoffMs_StaysInClosedIntervalBaseTo1Point5xBase(int baseMs)
    {
        // 100 invocations per base — every result must fall in [base, base*1.5]
        // (0..50% jitter on top of the base). With Random.Shared this samples
        // a meaningful slice of the jitter distribution.
        for (var i = 0; i < 100; i++)
        {
            var actual = AuthController.ComputeRotationBackoffMs(baseMs);
            Assert.InRange(actual, baseMs, baseMs + baseMs / 2);
        }
    }

    [Fact]
    public void ComputeRotationBackoffMs_ProducesMoreThanOneDistinctValue()
    {
        // Sanity check: the function MUST actually jitter. If it always
        // returned the base (e.g. someone "simplified" the helper) we'd
        // regress to the lock-step retry behaviour the fix is preventing.
        var distinct = new HashSet<int>();
        for (var i = 0; i < 200; i++)
        {
            distinct.Add(AuthController.ComputeRotationBackoffMs(1000));
        }
        Assert.True(distinct.Count > 1,
            $"Backoff helper returned only one distinct value over 200 invocations; jitter is broken. Values: {string.Join(",", distinct)}");
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(-1000)]
    public void ComputeRotationBackoffMs_NonPositiveInputReturnsZero(int baseMs)
    {
        Assert.Equal(0, AuthController.ComputeRotationBackoffMs(baseMs));
    }

    [Fact]
    public void ComputeRotationBackoffMs_OneMsBaseReturnsAtLeastBase()
    {
        // Edge case: baseMs=1 — baseMs/2 = 0, so range collapses to {1}.
        for (var i = 0; i < 50; i++)
        {
            Assert.Equal(1, AuthController.ComputeRotationBackoffMs(1));
        }
    }
}

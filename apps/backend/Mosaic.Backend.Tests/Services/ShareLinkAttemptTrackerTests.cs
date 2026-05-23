using Mosaic.Backend.Services;
using Mosaic.Backend.Tests.Helpers;
using Xunit;

namespace Mosaic.Backend.Tests.Services;

public class ShareLinkAttemptTrackerTests
{
    private static FakeTimeProvider NewClock() =>
        new(new DateTimeOffset(2025, 1, 1, 0, 0, 0, TimeSpan.Zero));
    [Fact]
    public void GetLockoutRemaining_ReturnsNull_WhenKeyUnknown()
    {
        var tracker = new ShareLinkAttemptTracker(NewClock());
        Assert.Null(tracker.GetLockoutRemaining("unknown"));
    }

    [Fact]
    public void RecordFailure_DoesNotLock_BelowThreshold()
    {
        var tracker = new ShareLinkAttemptTracker(NewClock());

        for (var i = 0; i < ShareLinkAttemptTracker.MaxAttempts - 1; i++)
        {
            Assert.Null(tracker.RecordFailure("link"));
            Assert.Null(tracker.GetLockoutRemaining("link"));
        }
    }

    [Fact]
    public void RecordFailure_Locks_OnceThresholdReached()
    {
        var tracker = new ShareLinkAttemptTracker(NewClock());

        for (var i = 0; i < ShareLinkAttemptTracker.MaxAttempts - 1; i++)
        {
            tracker.RecordFailure("link");
        }

        var locked = tracker.RecordFailure("link");
        Assert.NotNull(locked);
        Assert.Equal(ShareLinkAttemptTracker.LockoutDuration, locked!.Value);

        var stillLocked = tracker.GetLockoutRemaining("link");
        Assert.NotNull(stillLocked);
        Assert.True(stillLocked!.Value > TimeSpan.Zero);
    }

    [Fact]
    public void RecordFailure_DoesNotLock_WhenFailuresAgeOutOfWindow()
    {
        var fake = NewClock();
        var tracker = new ShareLinkAttemptTracker(fake);

        for (var i = 0; i < ShareLinkAttemptTracker.MaxAttempts - 1; i++)
        {
            tracker.RecordFailure("link");
        }

        fake.Advance(ShareLinkAttemptTracker.AttemptWindow + TimeSpan.FromSeconds(1));

        Assert.Null(tracker.RecordFailure("link"));
        Assert.Null(tracker.GetLockoutRemaining("link"));
    }

    [Fact]
    public void Lockout_Expires_AfterLockoutDuration()
    {
        var fake = NewClock();
        var tracker = new ShareLinkAttemptTracker(fake);

        for (var i = 0; i < ShareLinkAttemptTracker.MaxAttempts; i++)
        {
            tracker.RecordFailure("link");
        }

        Assert.NotNull(tracker.GetLockoutRemaining("link"));

        fake.Advance(ShareLinkAttemptTracker.LockoutDuration + TimeSpan.FromSeconds(1));

        Assert.Null(tracker.GetLockoutRemaining("link"));
    }

    [Fact]
    public void RecordSuccess_ClearsBucket()
    {
        var tracker = new ShareLinkAttemptTracker(NewClock());

        for (var i = 0; i < ShareLinkAttemptTracker.MaxAttempts - 1; i++)
        {
            tracker.RecordFailure("link");
        }

        tracker.RecordSuccess("link");

        Assert.Null(tracker.GetLockoutRemaining("link"));

        // Counter should be reset — a fresh series of failures should not
        // trip lockout immediately.
        Assert.Null(tracker.RecordFailure("link"));
    }

    [Fact]
    public void Buckets_AreIsolated_PerLinkKey()
    {
        var tracker = new ShareLinkAttemptTracker(NewClock());

        for (var i = 0; i < ShareLinkAttemptTracker.MaxAttempts; i++)
        {
            tracker.RecordFailure("link-a");
        }

        Assert.NotNull(tracker.GetLockoutRemaining("link-a"));
        Assert.Null(tracker.GetLockoutRemaining("link-b"));
    }

    [Fact]
    public void RecordFailure_ReturnsRemainingLockoutWindow_WhenAlreadyLocked()
    {
        var fake = NewClock();
        var tracker = new ShareLinkAttemptTracker(fake);

        for (var i = 0; i < ShareLinkAttemptTracker.MaxAttempts; i++)
        {
            tracker.RecordFailure("link");
        }

        fake.Advance(TimeSpan.FromMinutes(10));
        var subsequent = tracker.RecordFailure("link");
        Assert.NotNull(subsequent);
        Assert.True(subsequent!.Value < ShareLinkAttemptTracker.LockoutDuration);
        Assert.True(subsequent.Value > TimeSpan.Zero);
    }

    [Fact]
    public void Empty_Or_Null_Keys_AreNoOps()
    {
        var tracker = new ShareLinkAttemptTracker(NewClock());
        Assert.Null(tracker.RecordFailure(""));
        Assert.Null(tracker.GetLockoutRemaining(""));
        tracker.RecordSuccess("");
    }
}

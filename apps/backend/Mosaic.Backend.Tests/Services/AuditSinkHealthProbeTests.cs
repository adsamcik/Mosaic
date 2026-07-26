using System.Text;
using Mosaic.Backend.Logging.Hooks;
using Mosaic.Backend.Services;
using Xunit;

namespace Mosaic.Backend.Tests.Services;

public sealed class AuditSinkHealthProbeTests : IDisposable
{
    private readonly string _directory = Path.Combine(
        Path.GetTempPath(),
        $"mosaic-audit-health-{Guid.NewGuid():N}");

    public AuditSinkHealthProbeTests()
    {
        Directory.CreateDirectory(_directory);
    }

    [Fact]
    public void IsWritable_ReturnsTrue_WhenActualSinkAndRolloverDirectoryAreWritable()
    {
        var activePath = Path.Combine(_directory, "audit-active.log");
        var monitor = new AuditSinkWriteMonitor();
        var hook = new RestrictivePermissionsHook(monitor);
        using var tracked = hook.OnFileOpened(
            activePath,
            new FileStream(
                activePath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.Read),
            Encoding.UTF8);
        var probe = new FileAuditSinkHealthProbe(_directory, monitor);

        Assert.True(probe.IsWritable());
    }

    [Fact]
    public void IsWritable_ReturnsFalse_WhenActualSinkFlushFailsButDirectoryIsWritable()
    {
        var activePath = Path.Combine(_directory, "audit-active.log");
        File.WriteAllBytes(activePath, [0]);
        var monitor = new AuditSinkWriteMonitor();
        using var tracked = monitor.Track(activePath, new FlushFailingStream());
        var probe = new FileAuditSinkHealthProbe(_directory, monitor);

        // A directory-only probe would pass here. The real tracked sink must
        // make readiness fail without reading or returning audit log content.
        Assert.False(probe.IsWritable());
    }

    [Fact]
    public void IsWritable_ReturnsFalse_WhenTrackedActiveFileDisappears()
    {
        var activePath = Path.Combine(_directory, "audit-active.log");
        File.WriteAllBytes(activePath, [0]);
        var monitor = new AuditSinkWriteMonitor();
        using var tracked = monitor.Track(activePath, new MemoryStream());
        File.Delete(activePath);
        var probe = new FileAuditSinkHealthProbe(_directory, monitor);

        Assert.False(probe.IsWritable());
    }

    public void Dispose()
    {
        if (!Directory.Exists(_directory))
        {
            return;
        }

        foreach (var path in Directory.EnumerateFiles(_directory))
        {
            File.SetAttributes(path, FileAttributes.Normal);
        }

        Directory.Delete(_directory, recursive: true);
    }

    private sealed class FlushFailingStream : MemoryStream
    {
        public override void Flush()
        {
            throw new IOException("simulated active audit sink failure");
        }
    }
}

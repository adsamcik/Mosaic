using System.Net;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Mosaic.Backend.Services;
using Xunit;

namespace Mosaic.Backend.Tests.Services;

/// <summary>
/// Unit tests for <see cref="MosaicMetrics"/> — the observability surface
/// behind <c>GET /metrics</c>. Verifies counter semantics, GC duration
/// histogram bookkeeping, and the Prometheus-text exposition format
/// (since we hand-roll the exporter instead of pulling in
/// <c>OpenTelemetry.Exporter.Prometheus</c>).
/// </summary>
public sealed class MosaicMetricsTests
{
    [Fact]
    public void RecordUpload_IncrementsCounter()
    {
        using var metrics = new MosaicMetrics();

        Assert.Equal(0, metrics.UploadsTotalValue);

        metrics.RecordUpload();
        metrics.RecordUpload();
        metrics.RecordUpload();

        Assert.Equal(3, metrics.UploadsTotalValue);
    }

    [Fact]
    public void RecordAuthFailure_IncrementsCounter()
    {
        using var metrics = new MosaicMetrics();

        metrics.RecordAuthFailure();
        metrics.RecordAuthFailure();

        Assert.Equal(2, metrics.AuthFailuresTotalValue);
    }

    [Fact]
    public void RecordOrphanBlobDeleteFailure_IncrementsCounter()
    {
        using var metrics = new MosaicMetrics();

        metrics.RecordOrphanBlobDeleteFailure();
        metrics.RecordOrphanBlobDeleteFailure();
        metrics.RecordOrphanBlobDeleteFailure();
        metrics.RecordOrphanBlobDeleteFailure();

        Assert.Equal(4, metrics.OrphanBlobDeleteFailuresValue);
    }

    [Fact]
    public void RecordGcDuration_AccumulatesSumAndCount()
    {
        using var metrics = new MosaicMetrics();

        metrics.RecordGcDuration(TimeSpan.FromSeconds(0.5));
        metrics.RecordGcDuration(TimeSpan.FromSeconds(1.25));
        metrics.RecordGcDuration(TimeSpan.FromSeconds(2.0));

        Assert.Equal(3, metrics.GcCountValue);
        Assert.Equal(3.75, metrics.GcDurationSumSecondsValue, precision: 5);
    }

    [Fact]
    public void RenderPrometheusText_EmitsAllSeriesInExpositionFormat()
    {
        using var metrics = new MosaicMetrics();

        metrics.RecordUpload();
        metrics.RecordUpload();
        metrics.RecordAuthFailure();
        metrics.RecordOrphanBlobDeleteFailure();
        metrics.RecordGcDuration(TimeSpan.FromSeconds(1.5));

        var text = metrics.RenderPrometheusText();

        // Each series must include a HELP + TYPE preamble and a value line.
        Assert.Contains("# TYPE mosaic_uploads_total counter", text);
        Assert.Contains("mosaic_uploads_total 2", text);

        Assert.Contains("# TYPE mosaic_auth_failures_total counter", text);
        Assert.Contains("mosaic_auth_failures_total 1", text);

        Assert.Contains("# TYPE mosaic_orphan_blob_delete_failures_total counter", text);
        Assert.Contains("mosaic_orphan_blob_delete_failures_total 1", text);

        Assert.Contains("# TYPE mosaic_gc_duration_seconds summary", text);
        Assert.Contains("mosaic_gc_duration_seconds_count 1", text);
        // Sum is formatted with invariant culture (decimal point, not comma).
        Assert.Contains("mosaic_gc_duration_seconds_sum 1.500000", text);
    }

    [Fact]
    public async Task Counters_AreThreadSafe()
    {
        // Sanity check: Interlocked-backed counters must survive
        // concurrent increments without losing updates.
        using var metrics = new MosaicMetrics();
        const int threads = 8;
        const int perThread = 1000;

        var startGate = new ManualResetEventSlim();
        var tasks = Enumerable.Range(0, threads).Select(_ => Task.Run(() =>
        {
            startGate.Wait();
            for (var i = 0; i < perThread; i++)
            {
                metrics.RecordUpload();
            }
        })).ToArray();

        startGate.Set();
        await Task.WhenAll(tasks);

        Assert.Equal(threads * perThread, metrics.UploadsTotalValue);
    }
}

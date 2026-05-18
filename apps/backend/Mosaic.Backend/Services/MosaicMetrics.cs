using System.Diagnostics.Metrics;
using System.Globalization;
using System.Text;

namespace Mosaic.Backend.Services;

/// <summary>
/// Minimal observability surface for v1.0.1 (s25). Exposes a small set of
/// process-wide counters and one histogram via two mechanisms:
///
/// <list type="bullet">
/// <item>
///   <see cref="System.Diagnostics.Metrics.Meter"/> instruments — picked up
///   by any future OpenTelemetry / dotnet-counters exporter. No external
///   dependency required (BCL only).
/// </item>
/// <item>
///   Shadow scalar fields (<c>Interlocked</c>-updated longs and a CAS-updated
///   double sum) that <see cref="RenderPrometheusText"/> reads. This gives us
///   a deterministic, lock-free snapshot for the hand-rolled
///   <c>GET /metrics</c> Prometheus-text exporter in <c>Program.cs</c> without
///   pulling in <c>OpenTelemetry.Exporter.Prometheus</c> as a new dependency.
/// </item>
/// </list>
///
/// Registered as a singleton so the same instance is shared by the upload
/// pipeline, the auth handler (failure increments), the garbage-collection
/// background service, and the <c>/metrics</c> endpoint.
/// </summary>
public sealed class MosaicMetrics : IDisposable
{
    public const string MeterName = "Mosaic.Backend";

    private readonly Meter _meter;

    private readonly Counter<long> _uploadsCounter;
    private readonly Counter<long> _authFailuresCounter;
    private readonly Counter<long> _orphanBlobDeleteFailuresCounter;
    private readonly Counter<long> _sessionsCleanedCounter;
    private readonly Counter<long> _authChallengesCleanedCounter;
    private readonly Histogram<double> _gcDurationHistogram;

    private long _uploadsTotal;
    private long _authFailuresTotal;
    private long _orphanBlobDeleteFailures;
    private long _sessionsCleanedTotal;
    private long _authChallengesCleanedTotal;
    private long _gcCount;
    private double _gcDurationSumSeconds;

    public MosaicMetrics()
    {
        _meter = new Meter(MeterName, "1.0.0");

        _uploadsCounter = _meter.CreateCounter<long>(
            name: "mosaic_uploads_total",
            unit: null,
            description: "Total successful blob uploads (Tus file complete).");

        _authFailuresCounter = _meter.CreateCounter<long>(
            name: "mosaic_auth_failures_total",
            unit: null,
            description: "Total authentication signature verification failures.");

        _orphanBlobDeleteFailuresCounter = _meter.CreateCounter<long>(
            name: "mosaic_orphan_blob_delete_failures_total",
            unit: null,
            description: "Total storage-delete failures encountered while purging orphan/trashed blobs in GC.");

        _sessionsCleanedCounter = _meter.CreateCounter<long>(
            name: "mosaic_sessions_cleaned_total",
            unit: null,
            description: "Total session rows purged by the periodic retention sweep (revoked > 30d OR expired > 7d).");

        _authChallengesCleanedCounter = _meter.CreateCounter<long>(
            name: "mosaic_auth_challenges_cleaned_total",
            unit: null,
            description: "Total expired auth-challenge rows purged by the periodic cleanup sweep.");

        _gcDurationHistogram = _meter.CreateHistogram<double>(
            name: "mosaic_gc_duration_seconds",
            unit: "s",
            description: "Wall-clock duration of one garbage-collection pass, in seconds.");
    }

    /// <summary>
    /// Record one successful blob upload (called from
    /// <see cref="TusEventHandlers.OnFileCompleteAsync"/> after the
    /// shard row is committed).
    /// </summary>
    public void RecordUpload()
    {
        Interlocked.Increment(ref _uploadsTotal);
        _uploadsCounter.Add(1);
    }

    /// <summary>
    /// Record one authentication-signature verification failure. Called
    /// from the auth pipeline on each rejected request.
    /// </summary>
    public void RecordAuthFailure()
    {
        Interlocked.Increment(ref _authFailuresTotal);
        _authFailuresCounter.Add(1);
    }

    /// <summary>
    /// Record a failed orphan/trashed-blob storage delete during GC.
    /// Previously these failures were warning-logged only — now they are
    /// surfaced as an alertable counter so a broken storage backend
    /// shows up in monitoring instead of being lost in the log noise.
    /// </summary>
    public void RecordOrphanBlobDeleteFailure()
    {
        Interlocked.Increment(ref _orphanBlobDeleteFailures);
        _orphanBlobDeleteFailuresCounter.Add(1);
    }

    /// <summary>
    /// Record a batch of session rows purged by
    /// <see cref="SessionCleanupHostedService"/>. Called once per sweep iteration
    /// when at least one row was deleted (v1.0.x s40).
    /// </summary>
    public void RecordSessionsCleaned(int count)
    {
        if (count <= 0)
        {
            return;
        }

        Interlocked.Add(ref _sessionsCleanedTotal, count);
        _sessionsCleanedCounter.Add(count);
    }

    /// <summary>
    /// Record a batch of expired auth-challenge rows purged by
    /// <see cref="AuthChallengeCleanupHostedService"/> (v1.0.x s44-y1).
    /// </summary>
    public void RecordAuthChallengesCleaned(int count)
    {
        if (count <= 0)
        {
            return;
        }

        Interlocked.Add(ref _authChallengesCleanedTotal, count);
        _authChallengesCleanedCounter.Add(count);
    }

    /// <summary>
    /// Record the duration of one completed GC pass.
    /// </summary>
    public void RecordGcDuration(TimeSpan duration)
    {
        var seconds = duration.TotalSeconds;
        Interlocked.Increment(ref _gcCount);

        // Atomic double-add via compare-exchange. Histogram.Record is the
        // canonical instrument; the shadow sum + count are kept so the
        // Prometheus exporter can emit *_sum / *_count without owning a
        // MeterListener.
        double current;
        double next;
        do
        {
            current = _gcDurationSumSeconds;
            next = current + seconds;
        }
        while (Interlocked.CompareExchange(ref _gcDurationSumSeconds, next, current) != current);

        _gcDurationHistogram.Record(seconds);
    }

    public long UploadsTotalValue => Interlocked.Read(ref _uploadsTotal);
    public long AuthFailuresTotalValue => Interlocked.Read(ref _authFailuresTotal);
    public long OrphanBlobDeleteFailuresValue => Interlocked.Read(ref _orphanBlobDeleteFailures);
    public long SessionsCleanedTotalValue => Interlocked.Read(ref _sessionsCleanedTotal);
    public long AuthChallengesCleanedTotalValue => Interlocked.Read(ref _authChallengesCleanedTotal);
    public long GcCountValue => Interlocked.Read(ref _gcCount);
    public double GcDurationSumSecondsValue => Volatile.Read(ref _gcDurationSumSeconds);

    /// <summary>
    /// Render the current metric snapshot in Prometheus 0.0.4 text
    /// exposition format. Counter names end in <c>_total</c>; the GC
    /// histogram is reported as the canonical <c>*_sum</c> / <c>*_count</c>
    /// pair (no buckets — a small enough surface that p95/p99 are computed
    /// downstream from cumulative deltas if needed).
    /// </summary>
    public string RenderPrometheusText()
    {
        var ci = CultureInfo.InvariantCulture;
        var sb = new StringBuilder(512);

        sb.AppendLine("# HELP mosaic_uploads_total Total successful blob uploads.");
        sb.AppendLine("# TYPE mosaic_uploads_total counter");
        sb.Append("mosaic_uploads_total ").Append(UploadsTotalValue.ToString(ci)).Append('\n');

        sb.AppendLine("# HELP mosaic_auth_failures_total Total authentication signature verification failures.");
        sb.AppendLine("# TYPE mosaic_auth_failures_total counter");
        sb.Append("mosaic_auth_failures_total ").Append(AuthFailuresTotalValue.ToString(ci)).Append('\n');

        sb.AppendLine("# HELP mosaic_orphan_blob_delete_failures_total Storage-delete failures during orphan/trashed blob GC.");
        sb.AppendLine("# TYPE mosaic_orphan_blob_delete_failures_total counter");
        sb.Append("mosaic_orphan_blob_delete_failures_total ").Append(OrphanBlobDeleteFailuresValue.ToString(ci)).Append('\n');

        sb.AppendLine("# HELP mosaic_sessions_cleaned_total Session rows purged by the periodic retention sweep.");
        sb.AppendLine("# TYPE mosaic_sessions_cleaned_total counter");
        sb.Append("mosaic_sessions_cleaned_total ").Append(SessionsCleanedTotalValue.ToString(ci)).Append('\n');

        sb.AppendLine("# HELP mosaic_auth_challenges_cleaned_total Expired auth-challenge rows purged by the periodic cleanup sweep.");
        sb.AppendLine("# TYPE mosaic_auth_challenges_cleaned_total counter");
        sb.Append("mosaic_auth_challenges_cleaned_total ").Append(AuthChallengesCleanedTotalValue.ToString(ci)).Append('\n');

        sb.AppendLine("# HELP mosaic_gc_duration_seconds Duration of a garbage-collection pass.");
        sb.AppendLine("# TYPE mosaic_gc_duration_seconds summary");
        sb.Append("mosaic_gc_duration_seconds_sum ").Append(GcDurationSumSecondsValue.ToString("0.000000", ci)).Append('\n');
        sb.Append("mosaic_gc_duration_seconds_count ").Append(GcCountValue.ToString(ci)).Append('\n');

        return sb.ToString();
    }

    public void Dispose() => _meter.Dispose();
}

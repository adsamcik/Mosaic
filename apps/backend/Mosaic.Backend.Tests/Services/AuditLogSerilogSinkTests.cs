using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using Mosaic.Backend.Services;
using Mosaic.Backend.Tests.Helpers;
using Serilog;
using Serilog.Extensions.Logging;
using Serilog.Filters;
using Xunit;

namespace Mosaic.Backend.Tests.Services;

/// <summary>
/// v1.0.2 audit-event-sink — verifies that <see cref="AuditLogService.WriteAsync"/>
/// emits a structured log event tagged with the audit category so the dedicated
/// Serilog file sink configured in <c>Program.cs</c> picks it up, and that
/// non-audit logs from the same logger are excluded by the audit filter.
/// </summary>
public sealed class AuditLogSerilogSinkTests : IDisposable
{
    private readonly string _tempDir;
    private readonly string _auditLogPath;

    public AuditLogSerilogSinkTests()
    {
        _tempDir = Path.Combine(
            Path.GetDirectoryName(typeof(AuditLogSerilogSinkTests).Assembly.Location)!,
            "audit-sink-tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_tempDir);
        _auditLogPath = Path.Combine(_tempDir, "audit-.log");
    }

    public void Dispose()
    {
        try
        {
            Log.CloseAndFlush();
            if (Directory.Exists(_tempDir))
            {
                Directory.Delete(_tempDir, recursive: true);
            }
        }
        catch
        {
            // best-effort cleanup
        }
    }

    private ILoggerFactory CreateFactoryWithAuditSink()
    {
        // Mirror the filter wired up in Program.cs: a sub-logger that ONLY
        // includes events tagged with the audit Category property.
        var serilog = new LoggerConfiguration()
            .MinimumLevel.Information()
            .Enrich.FromLogContext()
            .WriteTo.Logger(lc => lc
                .Filter.ByIncludingOnly(Matching.WithProperty<string>(
                    AuditLogService.CategoryPropertyName,
                    v => v == AuditLogService.AuditCategoryValue))
                .WriteTo.File(
                    path: _auditLogPath,
                    rollingInterval: RollingInterval.Day,
                    shared: true,
                    outputTemplate:
                        "{Timestamp:o} {Level:u3} {Message:lj} {Properties:j}{NewLine}"))
            .CreateLogger();

        return new SerilogLoggerFactory(serilog, dispose: true);
    }

    private string ReadAuditLogContents()
    {
        // Force Serilog to flush buffered writes before reading.
        Log.CloseAndFlush();

        var sb = new System.Text.StringBuilder();
        foreach (var file in Directory.EnumerateFiles(_tempDir, "audit-*.log"))
        {
            using var fs = new FileStream(
                file,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(fs);
            sb.Append(reader.ReadToEnd());
        }
        return sb.ToString();
    }

    [Fact]
    public async Task WriteAsync_emits_audit_tagged_log_to_dedicated_sink()
    {
        using var db = TestDbContextFactory.Create();
        using var factory = CreateFactoryWithAuditSink();
        var logger = factory.CreateLogger<AuditLogService>();
        var time = new Microsoft.Extensions.Time.Testing.FakeTimeProvider(
            DateTimeOffset.Parse("2025-04-12T08:15:00Z"));
        var service = new AuditLogService(db, time, logger);

        await service.WriteAsync(new AuditLogEvent
        {
            EventType = AuditEventTypes.AuthLoginSucceeded,
            Outcome = "success",
            ActorUserId = Guid.Parse("00000000-0000-0000-0000-00000000abcd"),
            TargetType = "user",
            TargetId = "00000000-0000-0000-0000-00000000abcd",
            RequestId = "req-test-1",
        });

        // The DB row is still the source of truth.
        var stored = await db.AuditLogEntries
            .Where(e => e.EventType == AuditEventTypes.AuthLoginSucceeded)
            .ToListAsync();
        Assert.Single(stored);

        // ...and the Serilog file sink must have captured a tagged record.
        var content = ReadAuditLogContents();
        Assert.Contains(AuditEventTypes.AuthLoginSucceeded, content);
        Assert.Contains("success", content);
        // The Category property pushed via LogContext should appear in the
        // {Properties:j} portion of the output template — Serilog renders
        // structured properties as a JSON-ish object; we don't depend on the
        // exact serialisation format, just that the tag is present.
        Assert.Contains(AuditLogService.AuditCategoryValue, content);
        Assert.Contains(AuditLogService.CategoryPropertyName, content);
        Assert.Contains("req-test-1", content);
    }

    [Fact]
    public async Task Non_audit_logs_are_excluded_from_audit_sink()
    {
        using var db = TestDbContextFactory.Create();
        using var factory = CreateFactoryWithAuditSink();
        var unrelated = factory.CreateLogger("Mosaic.Backend.SomeOtherService");

        unrelated.LogInformation("plain informational message no-category-marker-12345");
        unrelated.LogWarning("warning without audit tag deadbeef-warning");

        // Also issue a real audit write to prove the sink works alongside the exclusions.
        var service = new AuditLogService(
            db,
            new Microsoft.Extensions.Time.Testing.FakeTimeProvider(DateTimeOffset.UtcNow),
            factory.CreateLogger<AuditLogService>());
        await service.WriteAsync(new AuditLogEvent
        {
            EventType = AuditEventTypes.AuthLogout,
            Outcome = "success",
            ActorUserId = Guid.NewGuid(),
        });

        var content = ReadAuditLogContents();

        Assert.DoesNotContain("no-category-marker-12345", content);
        Assert.DoesNotContain("deadbeef-warning", content);
        Assert.Contains(AuditEventTypes.AuthLogout, content);
    }
}

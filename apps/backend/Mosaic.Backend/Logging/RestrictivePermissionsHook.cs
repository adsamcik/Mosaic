using System.Runtime.InteropServices;
using System.Text;
using Mosaic.Backend.Services;
using Serilog.Sinks.File;

namespace Mosaic.Backend.Logging.Hooks;

/// <summary>
/// Serilog file-sink lifecycle hook that restricts newly-opened audit log
/// files to owner-only (0600) permissions on Unix-like platforms.
///
/// Rationale (security-review-2026-05-24-05): the Serilog file sink does not
/// expose a direct ``permissions`` option, so on Linux/macOS files inherit
/// the process umask and may be group/world readable. Audit logs contain
/// stable user identifiers and operational metadata that should not be
/// readable by unprivileged accounts on the host. We chmod to 0600 on file
/// open. On Windows this hook is a no-op — Windows uses ACLs (not POSIX
/// mode bits) and ``File.SetUnixFileMode`` throws there.
///
/// Any failure to set the mode is logged via Serilog's SelfLog (wired in
/// Program.cs) and swallowed: failing to harden permissions must NOT block
/// audit writes — a recorded event with permissive permissions is strictly
/// better than a dropped event.
/// </summary>
public sealed class RestrictivePermissionsHook : FileLifecycleHooks
{
    private const UnixFileMode OwnerReadWrite =
        UnixFileMode.UserRead | UnixFileMode.UserWrite;
    private readonly AuditSinkWriteMonitor? _writeMonitor;

    public RestrictivePermissionsHook(AuditSinkWriteMonitor? writeMonitor = null)
    {
        _writeMonitor = writeMonitor;
    }

    public override Stream OnFileOpened(string path, Stream underlyingStream, Encoding encoding)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux) ||
            RuntimeInformation.IsOSPlatform(OSPlatform.OSX) ||
            RuntimeInformation.IsOSPlatform(OSPlatform.FreeBSD))
        {
            try
            {
                File.SetUnixFileMode(path, OwnerReadWrite);
            }
            catch (Exception ex) when (
                ex is IOException or UnauthorizedAccessException or PlatformNotSupportedException)
            {
                Serilog.Debugging.SelfLog.WriteLine(
                    "RestrictivePermissionsHook: failed to chmod 0600 on '{0}': {1}",
                    path, ex.Message);
            }
        }

        var openedStream = base.OnFileOpened(path, underlyingStream, encoding);
        return _writeMonitor?.Track(path, openedStream) ?? openedStream;
    }
}

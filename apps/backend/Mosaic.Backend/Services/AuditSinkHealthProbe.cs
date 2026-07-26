namespace Mosaic.Backend.Services;

public interface IAuditSinkHealthProbe
{
    bool IsWritable();
}

/// <summary>
/// Tracks the exact stream opened by Serilog's rolling audit-file sink. The
/// wrapper serializes readiness flushes with sink writes and remembers write
/// failures that Serilog would otherwise report only through SelfLog.
/// </summary>
public sealed class AuditSinkWriteMonitor
{
    private readonly object _gate = new();
    private TrackedAuditStream? _activeStream;

    /// <summary>Wraps a newly opened active/rolled sink stream.</summary>
    public Stream Track(string path, Stream stream)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        ArgumentNullException.ThrowIfNull(stream);

        var tracked = new TrackedAuditStream(this, Path.GetFullPath(path), stream);
        lock (_gate)
        {
            _activeStream = tracked;
        }

        return tracked;
    }

    /// <summary>
    /// Flushes the actual active sink handle and checks that its path still
    /// exists and is not marked read-only. No audit bytes are read or emitted.
    /// </summary>
    public bool IsActiveSinkWritable()
    {
        TrackedAuditStream? active;
        lock (_gate)
        {
            active = _activeStream;
        }

        return active?.Probe() == true;
    }

    private void Release(TrackedAuditStream stream)
    {
        lock (_gate)
        {
            if (ReferenceEquals(_activeStream, stream))
            {
                _activeStream = null;
            }
        }
    }

    private sealed class TrackedAuditStream : Stream
    {
        private static readonly UnixFileMode AnyWriteMode =
            UnixFileMode.UserWrite | UnixFileMode.GroupWrite | UnixFileMode.OtherWrite;

        private readonly AuditSinkWriteMonitor _owner;
        private readonly string _path;
        private readonly Stream _inner;
        private readonly object _operationGate = new();
        private bool _disposed;
        private bool _writeFaulted;

        public TrackedAuditStream(AuditSinkWriteMonitor owner, string path, Stream inner)
        {
            _owner = owner;
            _path = path;
            _inner = inner;
        }

        public bool Probe()
        {
            lock (_operationGate)
            {
                if (_disposed || _writeFaulted || !_inner.CanWrite || !File.Exists(_path))
                {
                    return false;
                }

                try
                {
                    if ((File.GetAttributes(_path) & FileAttributes.ReadOnly) != 0)
                    {
                        return false;
                    }

                    if (OperatingSystem.IsLinux()
                        || OperatingSystem.IsMacOS()
                        || OperatingSystem.IsFreeBSD())
                    {
                        var mode = File.GetUnixFileMode(_path);
                        if ((mode & AnyWriteMode) == 0)
                        {
                            return false;
                        }
                    }

                    if (_inner is FileStream fileStream)
                    {
                        fileStream.Flush(flushToDisk: true);
                    }
                    else
                    {
                        _inner.Flush();
                    }

                    return true;
                }
                catch (Exception ex) when (IsSinkIoFailure(ex))
                {
                    _writeFaulted = true;
                    return false;
                }
            }
        }

        public override bool CanRead => !_disposed && _inner.CanRead;
        public override bool CanSeek => !_disposed && _inner.CanSeek;
        public override bool CanWrite => !_disposed && _inner.CanWrite;
        public override long Length => _inner.Length;

        public override long Position
        {
            get => _inner.Position;
            set => _inner.Position = value;
        }

        public override void Flush()
        {
            lock (_operationGate)
            {
                EnsureNotDisposed();
                try
                {
                    _inner.Flush();
                }
                catch (Exception ex) when (IsSinkIoFailure(ex))
                {
                    _writeFaulted = true;
                    throw;
                }
            }
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            lock (_operationGate)
            {
                EnsureNotDisposed();
                return _inner.Read(buffer, offset, count);
            }
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            lock (_operationGate)
            {
                EnsureNotDisposed();
                return _inner.Seek(offset, origin);
            }
        }

        public override void SetLength(long value)
        {
            lock (_operationGate)
            {
                EnsureNotDisposed();
                _inner.SetLength(value);
            }
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            lock (_operationGate)
            {
                EnsureNotDisposed();
                try
                {
                    _inner.Write(buffer, offset, count);
                    if (count > 0)
                    {
                        _writeFaulted = false;
                    }
                }
                catch (Exception ex) when (IsSinkIoFailure(ex))
                {
                    _writeFaulted = true;
                    throw;
                }
            }
        }

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            lock (_operationGate)
            {
                EnsureNotDisposed();
                try
                {
                    _inner.Write(buffer);
                    if (!buffer.IsEmpty)
                    {
                        _writeFaulted = false;
                    }
                }
                catch (Exception ex) when (IsSinkIoFailure(ex))
                {
                    _writeFaulted = true;
                    throw;
                }
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                lock (_operationGate)
                {
                    if (!_disposed)
                    {
                        _disposed = true;
                        _inner.Dispose();
                    }
                }

                _owner.Release(this);
            }

            base.Dispose(disposing);
        }

        private void EnsureNotDisposed()
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
        }

        private static bool IsSinkIoFailure(Exception exception)
            => exception is IOException
                or UnauthorizedAccessException
                or ObjectDisposedException
                or NotSupportedException;
    }
}

/// <summary>
/// Checks both the actual active audit sink stream and the backing directory
/// needed for the next daily/size rollover.
/// </summary>
public sealed class FileAuditSinkHealthProbe : IAuditSinkHealthProbe
{
    private readonly string _directory;
    private readonly AuditSinkWriteMonitor _sinkMonitor;

    public FileAuditSinkHealthProbe(string directory, AuditSinkWriteMonitor sinkMonitor)
    {
        _directory = Path.GetFullPath(directory);
        _sinkMonitor = sinkMonitor;
    }

    public bool IsWritable()
    {
        if (!_sinkMonitor.IsActiveSinkWritable())
        {
            return false;
        }

        var probePath = Path.Combine(
            _directory,
            $".mosaic-audit-health-{Environment.ProcessId}-{Guid.NewGuid():N}");
        try
        {
            using (var stream = new FileStream(
                       probePath,
                       FileMode.CreateNew,
                       FileAccess.Write,
                       FileShare.None,
                       bufferSize: 1,
                       FileOptions.WriteThrough))
            {
                stream.WriteByte(0);
                stream.Flush(flushToDisk: true);
            }

            return true;
        }
        catch (IOException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
        finally
        {
            try { File.Delete(probePath); } catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}

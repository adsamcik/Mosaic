namespace Mosaic.Backend.Crypto;

using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Wasmtime;

/// <summary>
/// Hosts the canonical Rust crypto core through Wasmtime.
/// </summary>
public sealed class RustCoreHost : IDisposable
{
    private const string WasmBindgenModule = "./mosaic_wasm_bg.js";
    private const string WasmFileName = "mosaic_wasm_bg.wasm";

    private readonly Engine _engine;
    private readonly Module _module;
    private readonly ILogger<RustCoreHost> _logger;

    public RustCoreHost(ILogger<RustCoreHost> logger)
    {
        _logger = logger;

        var memoryBefore = GC.GetTotalMemory(forceFullCollection: false);
        var stopwatch = Stopwatch.StartNew();

        var wasmPath = ResolveWasmPath();
        _engine = new Engine();
        _module = Module.FromFile(_engine, wasmPath);

        stopwatch.Stop();
        ModuleLoadElapsed = stopwatch.Elapsed;
        EngineMemoryFootprintBytes = Math.Max(0, GC.GetTotalMemory(forceFullCollection: false) - memoryBefore);

        _logger.LogInformation(
            "Loaded Rust core WASM module from {WasmPath} in {ElapsedMilliseconds} ms; managed memory delta {MemoryBytes} bytes",
            wasmPath,
            ModuleLoadElapsed.TotalMilliseconds,
            EngineMemoryFootprintBytes);
    }

    public TimeSpan ModuleLoadElapsed { get; }

    public long EngineMemoryFootprintBytes { get; }

    public bool VerifyAuthChallenge(ReadOnlySpan<byte> transcript, ReadOnlySpan<byte> signature, ReadOnlySpan<byte> publicKey)
    {
        if (signature.Length != 64 || publicKey.Length != 32)
        {
            return false;
        }

        using var store = new Store(_engine);
        using var linker = new Linker(_engine);
        DefineWasmBindgenImports(store, linker);

        var instance = linker.Instantiate(store, _module);
        var memory = instance.GetMemory("memory")
            ?? throw new InvalidOperationException("Rust core WASM export 'memory' is missing.");
        var malloc = instance.GetFunction<int, int, int>("__wbindgen_export2")
            ?? throw new InvalidOperationException("Rust core WASM malloc export '__wbindgen_export2' is missing.");
        var verify = instance.GetFunction<int, int, int, int, int, int, int>("verifyAuthChallengeSignature")
            ?? throw new InvalidOperationException("Rust core WASM export 'verifyAuthChallengeSignature' is missing.");

        var transcriptPtr = 0;
        var signaturePtr = 0;
        var publicKeyPtr = 0;

        try
        {
            transcriptPtr = CopyToWasm(memory, malloc, transcript);
            signaturePtr = CopyToWasm(memory, malloc, signature);
            publicKeyPtr = CopyToWasm(memory, malloc, publicKey);

            var result = verify(
                transcriptPtr,
                transcript.Length,
                signaturePtr,
                signature.Length,
                publicKeyPtr,
                publicKey.Length);

            return result == 0;
        }
        catch (WasmtimeException ex)
        {
            _logger.LogWarning(ex, "Rust core rejected auth challenge verification invocation");
            return false;
        }
    }

    public void Dispose()
    {
        _module.Dispose();
        _engine.Dispose();
    }

    private static int CopyToWasm(Memory memory, Func<int, int, int> malloc, ReadOnlySpan<byte> bytes)
    {
        var ptr = malloc(bytes.Length, 1);
        bytes.CopyTo(memory.GetSpan(ptr, bytes.Length));
        return ptr;
    }

    private static void DefineWasmBindgenImports(Store store, Linker linker)
    {
        DefineIdentityImport(store, linker, "__wbg_bytesresult_new");
        DefineIdentityImport(store, linker, "__wbg_decryptedshardresult_new");
        DefineIdentityImport(store, linker, "__wbg_streamingframeresult_new");
        DefineIdentityImport(store, linker, "__wbg_streamingenveloperesult_new");

        linker.Define(WasmBindgenModule, "__wbindgen_object_drop_ref", Function.FromCallback(
            store,
            (_, _, _) => { },
            [ValueKind.Int32],
            []));

        linker.Define(WasmBindgenModule, "__wbg_getRandomValues_76dfc69825c9c552", Function.FromCallback(
            store,
            (caller, arguments, _) =>
            {
                var memory = caller.GetMemory("memory")
                    ?? throw new InvalidOperationException("Rust core WASM memory is unavailable.");
                RandomNumberGenerator.Fill(memory.GetSpan(arguments[0].AsInt32(), arguments[1].AsInt32()));
            },
            [ValueKind.Int32, ValueKind.Int32],
            []));

        linker.Define(WasmBindgenModule, "__wbg___wbindgen_throw_6b64449b9b9ed33c", Function.FromCallback(
            store,
            (caller, arguments, _) =>
            {
                var memory = caller.GetMemory("memory");
                var message = memory is null
                    ? "Rust core WASM threw"
                    : Encoding.UTF8.GetString(memory.GetSpan(arguments[0].AsInt32(), arguments[1].AsInt32()));
                throw new InvalidOperationException(message);
            },
            [ValueKind.Int32, ValueKind.Int32],
            []));

        linker.Define(WasmBindgenModule, "__wbg_Error_960c155d3d49e4c2", Function.FromCallback(
            store,
            (_, _, results) => results[0] = 0,
            [ValueKind.Int32, ValueKind.Int32],
            [ValueKind.Int32]));

        linker.Define(WasmBindgenModule, "__wbindgen_cast_0000000000000001", Function.FromCallback(
            store,
            (_, _, results) => results[0] = 0,
            [ValueKind.Float64],
            [ValueKind.Int32]));
    }

    private static void DefineIdentityImport(Store store, Linker linker, string name)
    {
        linker.Define(WasmBindgenModule, name, Function.FromCallback(
            store,
            (_, arguments, results) => results[0] = arguments[0].AsInt32(),
            [ValueKind.Int32],
            [ValueKind.Int32]));
    }

    private static string ResolveWasmPath()
    {
        var candidates = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "Resources", WasmFileName),
            Path.Combine(AppContext.BaseDirectory, WasmFileName),
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "apps", "web", "src", "generated", "mosaic-wasm", WasmFileName)),
            Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "apps", "web", "src", "generated", "mosaic-wasm", WasmFileName)),
            Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "..", "..", "web", "src", "generated", "mosaic-wasm", WasmFileName)),
        };

        foreach (var candidate in candidates)
        {
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        throw new FileNotFoundException(
            $"Could not find canonical Rust core WASM module '{WasmFileName}'. Checked: {string.Join(", ", candidates)}");
    }
}

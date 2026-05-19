namespace Mosaic.Backend.Security;

using Microsoft.Extensions.Hosting;

/// <summary>
/// Server-side floor for Argon2id KDF parameters supplied by clients at
/// registration / password-rotation time.
///
/// SECURITY (security-review-2026-05-20-01): Even though all key derivation
/// happens client-side under the zero-knowledge model, the server must
/// reject KDF profiles that fall below a safe floor. Otherwise a weak or
/// malicious client could register an account with 8 MiB / 1 iter Argon2 —
/// far below the OWASP recommended 64 MiB / 3 iter baseline — and silently
/// degrade the brute-force resistance of every wrapped key chained off
/// L0 = Argon2id(password, salt).
///
/// The floor is environment-aware:
///   * Production / Development: 64 MiB / 3 iter (matches client defaults).
///   * Testing: 8 MiB / 1 iter, matching the `VITE_E2E_WEAK_KEYS=true`
///     frontend used by E2E pool fixtures. The Testing environment is
///     never exposed to real users (see `dev.ps1 -Testing`).
/// </summary>
public sealed class KdfPolicy
{
    public int MinMemoryKib { get; }
    public int MinIterations { get; }
    public int MinParallelism { get; }
    public int MaxMemoryKib { get; }
    public int MaxIterations { get; }
    public int MaxParallelism { get; }
    public byte AlgVersion { get; }

    public KdfPolicy(IHostEnvironment env)
        : this(env.IsEnvironment("Testing"))
    {
    }

    private KdfPolicy(bool isTestingEnvironment)
    {
        // Testing-only floor mirrors `mosaic-crypto/weak-kdf`
        // (MIN_KDF_MEMORY_KIB = 8 MiB, MIN_KDF_ITERATIONS = 1). The
        // production floor matches `AuthController.DefaultKdfMemoryKib`
        // (64 MiB) and `AuthController.DefaultKdfIterations` (3 iter).
        MinMemoryKib = isTestingEnvironment ? 8_192 : 65_536;
        MinIterations = isTestingEnvironment ? 1 : 3;
        MinParallelism = 1;
        MaxMemoryKib = 1_048_576;
        MaxIterations = 32;
        MaxParallelism = 16;
        AlgVersion = 0x13;
    }

    /// <summary>
    /// Construct a policy with the production floor regardless of the
    /// runtime environment. Intended only for unit-test scenarios that
    /// need to assert the production behavior in isolation.
    /// </summary>
    public static KdfPolicy ForProduction() => new(isTestingEnvironment: false);

    /// <summary>
    /// Construct a policy with the testing floor regardless of the
    /// runtime environment. Intended only for unit-test scenarios that
    /// need to assert the testing behavior in isolation.
    /// </summary>
    public static KdfPolicy ForTesting() => new(isTestingEnvironment: true);

    /// <summary>
    /// Returns true iff the supplied KDF profile sits within the
    /// configured [Min, Max] window on every parameter AND uses the
    /// exact Argon2id algorithm version Mosaic supports (0x13).
    /// </summary>
    public bool IsValid(long memoryKib, int iterations, int parallelism, byte algVersion) =>
        memoryKib >= MinMemoryKib &&
        memoryKib <= MaxMemoryKib &&
        iterations >= MinIterations &&
        iterations <= MaxIterations &&
        parallelism >= MinParallelism &&
        parallelism <= MaxParallelism &&
        algVersion == AlgVersion;
}

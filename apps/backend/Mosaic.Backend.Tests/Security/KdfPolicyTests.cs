using Microsoft.Extensions.Hosting;
using Mosaic.Backend.Security;
using NSubstitute;
using Xunit;

namespace Mosaic.Backend.Tests.Security;

/// <summary>
/// Regression tests for <see cref="KdfPolicy"/>
/// (security-review-2026-05-20-01). The pre-fix server permitted
/// Argon2id profiles down to 8 MiB / 1 iter regardless of environment;
/// an attacker (or weak client built with `weak-kdf`) could register
/// with that floor and silently degrade L0 brute-force resistance.
/// </summary>
public class KdfPolicyTests
{
    private const byte Argon2idV13 = 0x13;

    private static KdfPolicy PolicyForEnvironment(string envName)
    {
        var env = Substitute.For<IHostEnvironment>();
        env.EnvironmentName.Returns(envName);
        return new KdfPolicy(env);
    }

    // ---- Production / Development environment floor (64 MiB / 3 iter) ----

    [Fact]
    public void Production_Rejects_WeakKdf_8MiB_1Iter()
    {
        var policy = PolicyForEnvironment("Production");
        Assert.False(policy.IsValid(memoryKib: 8_192, iterations: 1, parallelism: 1, algVersion: Argon2idV13));
    }

    [Fact]
    public void Production_Rejects_MemoryAtFloorMinusOne()
    {
        var policy = PolicyForEnvironment("Production");
        Assert.False(policy.IsValid(memoryKib: 65_535, iterations: 3, parallelism: 1, algVersion: Argon2idV13));
    }

    [Fact]
    public void Production_Rejects_IterationsAtFloorMinusOne()
    {
        var policy = PolicyForEnvironment("Production");
        Assert.False(policy.IsValid(memoryKib: 65_536, iterations: 2, parallelism: 1, algVersion: Argon2idV13));
    }

    [Fact]
    public void Production_Accepts_DefaultProfile_64MiB_3Iter()
    {
        var policy = PolicyForEnvironment("Production");
        Assert.True(policy.IsValid(memoryKib: 65_536, iterations: 3, parallelism: 1, algVersion: Argon2idV13));
    }

    [Fact]
    public void Development_Uses_ProductionFloor()
    {
        // Development is treated as production for KDF purposes; only the
        // explicit Testing environment relaxes the floor.
        var policy = PolicyForEnvironment("Development");
        Assert.False(policy.IsValid(memoryKib: 8_192, iterations: 1, parallelism: 1, algVersion: Argon2idV13));
        Assert.True(policy.IsValid(memoryKib: 65_536, iterations: 3, parallelism: 1, algVersion: Argon2idV13));
    }

    // ---- Testing environment floor (8 MiB / 1 iter, matches VITE_E2E_WEAK_KEYS) ----

    [Fact]
    public void Testing_Accepts_WeakKdf_8MiB_1Iter()
    {
        var policy = PolicyForEnvironment("Testing");
        Assert.True(policy.IsValid(memoryKib: 8_192, iterations: 1, parallelism: 1, algVersion: Argon2idV13));
    }

    [Fact]
    public void Testing_Rejects_BelowTestingFloor()
    {
        var policy = PolicyForEnvironment("Testing");
        Assert.False(policy.IsValid(memoryKib: 4_096, iterations: 1, parallelism: 1, algVersion: Argon2idV13));
    }

    // ---- Shared ceiling enforcement (must hold in both environments) ----

    [Theory]
    [InlineData("Production")]
    [InlineData("Testing")]
    public void Both_Reject_MemoryAboveCeiling(string envName)
    {
        var policy = PolicyForEnvironment(envName);
        Assert.False(policy.IsValid(memoryKib: 9_999_999_999L, iterations: 3, parallelism: 1, algVersion: Argon2idV13));
    }

    [Theory]
    [InlineData("Production")]
    [InlineData("Testing")]
    public void Both_Reject_IterationsAboveCeiling(string envName)
    {
        var policy = PolicyForEnvironment(envName);
        Assert.False(policy.IsValid(memoryKib: 65_536, iterations: 33, parallelism: 1, algVersion: Argon2idV13));
    }

    [Theory]
    [InlineData("Production")]
    [InlineData("Testing")]
    public void Both_Reject_ParallelismAboveCeiling(string envName)
    {
        var policy = PolicyForEnvironment(envName);
        Assert.False(policy.IsValid(memoryKib: 65_536, iterations: 3, parallelism: 17, algVersion: Argon2idV13));
    }

    [Theory]
    [InlineData("Production")]
    [InlineData("Testing")]
    public void Both_Reject_NonV13_AlgVersion(string envName)
    {
        var policy = PolicyForEnvironment(envName);
        Assert.False(policy.IsValid(memoryKib: 65_536, iterations: 3, parallelism: 1, algVersion: 0x10));
    }

    // ---- Static factories ----

    [Fact]
    public void ForProduction_MatchesProductionEnvironmentPolicy()
    {
        var prodEnv = PolicyForEnvironment("Production");
        var prodStatic = KdfPolicy.ForProduction();
        Assert.Equal(prodEnv.MinMemoryKib, prodStatic.MinMemoryKib);
        Assert.Equal(prodEnv.MinIterations, prodStatic.MinIterations);
    }

    [Fact]
    public void ForTesting_MatchesTestingEnvironmentPolicy()
    {
        var testEnv = PolicyForEnvironment("Testing");
        var testStatic = KdfPolicy.ForTesting();
        Assert.Equal(testEnv.MinMemoryKib, testStatic.MinMemoryKib);
        Assert.Equal(testEnv.MinIterations, testStatic.MinIterations);
    }
}

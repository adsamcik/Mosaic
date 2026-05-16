namespace Mosaic.Backend.Tests.Crypto;

using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Crypto;
using Xunit;

public class RustCoreHostTests
{
    [Fact]
    public void VerifyAuthChallenge_AcceptsCanonicalAuthChallengeVector()
    {
        using var host = new RustCoreHost(NullLogger<RustCoreHost>.Instance);

        var transcript = Convert.FromHexString("4d6f736169635f417574685f4368616c6c656e67655f763100000016746573745f75736572406d6f736169632e6c6f63616cb1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0");
        var signature = Convert.FromHexString("b2c05b06c42ab1674252951788e1c671b9bd7350926b7bbc11166aac231ca2311d9f6433b2fcca9bc546516ed5eaf0c1e6858df9b2c86ed772a498cc76cf3802");
        var publicKey = Convert.FromHexString("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c");

        Assert.True(host.VerifyAuthChallenge(transcript, signature, publicKey));
    }
}

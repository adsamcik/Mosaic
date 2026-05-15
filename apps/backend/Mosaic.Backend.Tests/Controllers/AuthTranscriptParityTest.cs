using System.Text.Json;
using Mosaic.Backend.Crypto;
using Xunit;

namespace Mosaic.Backend.Tests.Controllers;

public sealed class AuthTranscriptParityTest
{
    [Fact]
    public void BackendTranscriptMatchesCanonicalRustVector()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(FindVectorPath()));
        var root = document.RootElement;
        var inputs = root.GetProperty("inputs");
        var expected = root.GetProperty("expected");

        var username = inputs.GetProperty("username").GetString()!;
        var challenge = Convert.FromHexString(inputs.GetProperty("challengeHex").GetString()!);
        var timestampMs = inputs.GetProperty("timestampMs").GetInt64();
        var transcriptNoTimestamp = Convert.FromHexString(expected.GetProperty("transcriptNoTimestampHex").GetString()!);
        var transcriptWithTimestamp = Convert.FromHexString(expected.GetProperty("transcriptWithTimestampHex").GetString()!);

        var backendTranscriptNoTimestamp = AuthChallengeTranscriptBuilder.BuildTranscript(username, challenge, null);
        var backendTranscriptWithTimestamp = AuthChallengeTranscriptBuilder.BuildTranscript(username, challenge, timestampMs);

        Assert.Equal(32, challenge.Length);
        Assert.Equal(transcriptNoTimestamp, backendTranscriptNoTimestamp);
        Assert.Equal(transcriptWithTimestamp, backendTranscriptWithTimestamp);
        Assert.Equal(transcriptNoTimestamp, transcriptWithTimestamp);
        Assert.Equal(backendTranscriptNoTimestamp, backendTranscriptWithTimestamp);
    }

    private static string FindVectorPath()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(directory.FullName, "tests", "vectors", "auth_challenge.json");
            if (File.Exists(candidate))
            {
                return candidate;
            }

            directory = directory.Parent;
        }

        throw new FileNotFoundException("Could not find tests\\vectors\\auth_challenge.json from test output directory.");
    }
}

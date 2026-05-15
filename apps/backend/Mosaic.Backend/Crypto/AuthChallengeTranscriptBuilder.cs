namespace Mosaic.Backend.Crypto;

using System.Buffers.Binary;

/// <summary>
/// Builds the canonical LocalAuth challenge transcript byte string.
///
/// MUST be kept byte-identical with crates/mosaic-crypto/src/lib.rs ::
/// build_auth_challenge_transcript. The parity test AuthTranscriptParityTest
/// verifies this invariant against the canonical Rust-produced vector at
/// tests/vectors/auth_challenge.json.
///
/// Since deep-04 F5 (Wave 2D, commit 27f192c), the timestamp_ms parameter is
/// accepted for wire compatibility but is NOT mixed into the transcript. Replay
/// protection is provided by Wave 2A fix 2A-9 (atomic claim).
/// </summary>
public static class AuthChallengeTranscriptBuilder
{
    private const string AuthChallengeContext = "Mosaic_Auth_Challenge_v1";

    public static byte[] BuildTranscript(string username, byte[] challenge, long? timestampMs)
    {
        _ = timestampMs; // intentionally unused — see class doc

        var context = System.Text.Encoding.UTF8.GetBytes(AuthChallengeContext);
        var usernameBytes = System.Text.Encoding.UTF8.GetBytes(username);
        var usernameLenBytes = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(usernameLenBytes, (uint)usernameBytes.Length);

        var transcript = new byte[context.Length + usernameLenBytes.Length + usernameBytes.Length + challenge.Length];
        var offset = 0;
        Buffer.BlockCopy(context, 0, transcript, offset, context.Length);
        offset += context.Length;
        Buffer.BlockCopy(usernameLenBytes, 0, transcript, offset, usernameLenBytes.Length);
        offset += usernameLenBytes.Length;
        Buffer.BlockCopy(usernameBytes, 0, transcript, offset, usernameBytes.Length);
        offset += usernameBytes.Length;
        Buffer.BlockCopy(challenge, 0, transcript, offset, challenge.Length);

        return transcript;
    }
}

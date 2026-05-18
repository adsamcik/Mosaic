using System.ComponentModel.DataAnnotations;
using Mosaic.Backend.Models.Manifests;
using Xunit;

namespace Mosaic.Backend.Tests.Controllers;

/// <summary>
/// Regression tests for security-review-2026-05-18-04. The server-side
/// <c>[MaxLength]</c> on <see cref="CreateManifestRequest.EncryptedMetaSidecar"/>
/// must match the SPEC-EncryptedMetaSidecar wire ceiling
/// (65,536 plaintext + 64 header + 16 tag = 65,616 bytes). The prior
/// limit of 1 MiB allowed malicious clients to store oversized sidecars
/// that compliant clients would refuse to decode.
/// </summary>
public class ManifestRequestSizeLimitsTests
{
    private static IList<ValidationResult> ValidateRequest(CreateManifestRequest request)
    {
        var results = new List<ValidationResult>();
        var context = new ValidationContext(request);
        // Recursive=false is fine: MaxLength lives directly on the
        // record parameter.
        Validator.TryValidateObject(request, context, results, validateAllProperties: true);
        return results;
    }

    private static CreateManifestRequest BuildRequest(byte[]? sidecar)
        => new(
            ProtocolVersion: 1,
            AlbumId: Guid.NewGuid(),
            AssetType: "Image",
            EncryptedMeta: new byte[32],
            EncryptedMetaSidecar: sidecar,
            Signature: Convert.ToBase64String(new byte[64]),
            SignerPubkey: Convert.ToBase64String(new byte[32]),
            ShardIds: new List<string>());

    [Fact]
    public void EncryptedMetaSidecarMaxBytes_MatchesProtocolSpec()
    {
        // 65,536 plaintext + 64 header + 16 Poly1305 tag = 65,616.
        Assert.Equal(65_536, ManifestSizeLimits.SidecarPlaintextMaxBytes);
        Assert.Equal(64, ManifestSizeLimits.EnvelopeHeaderBytes);
        Assert.Equal(16, ManifestSizeLimits.Poly1305TagBytes);
        Assert.Equal(65_616, ManifestSizeLimits.EncryptedMetaSidecarMaxBytes);
    }

    [Fact]
    public void Validation_Accepts_NullSidecar()
    {
        var results = ValidateRequest(BuildRequest(null));
        Assert.DoesNotContain(results,
            r => r.MemberNames.Any(m => m == nameof(CreateManifestRequest.EncryptedMetaSidecar)));
    }

    [Fact]
    public void Validation_Accepts_SidecarAtExactLimit()
    {
        var atLimit = new byte[ManifestSizeLimits.EncryptedMetaSidecarMaxBytes];
        var results = ValidateRequest(BuildRequest(atLimit));
        Assert.DoesNotContain(results,
            r => r.MemberNames.Any(m => m == nameof(CreateManifestRequest.EncryptedMetaSidecar)));
    }

    [Fact]
    public void Validation_Rejects_SidecarOneByteOverLimit()
    {
        var overLimit = new byte[ManifestSizeLimits.EncryptedMetaSidecarMaxBytes + 1];
        var results = ValidateRequest(BuildRequest(overLimit));
        Assert.Contains(results,
            r => r.MemberNames.Any(m => m == nameof(CreateManifestRequest.EncryptedMetaSidecar)));
    }

    [Fact]
    public void Validation_Rejects_PreviouslyAccepted1MiBSidecar()
    {
        // The old (pre-fix) limit was 1 MiB. Confirm such a payload now
        // fails — this is the regression assertion that closes the
        // asymmetric-limit finding.
        var oneMiB = new byte[1_048_576];
        var results = ValidateRequest(BuildRequest(oneMiB));
        Assert.Contains(results,
            r => r.MemberNames.Any(m => m == nameof(CreateManifestRequest.EncryptedMetaSidecar)));
    }
}

# SPEC: Android Manual Upload Cross-Client Proof

## Status

Locked at v1 as a Band 3 contract proof. Implemented in `7f0161c`
(`feat(android): wire manual upload client-core handoff`) and
`1a8f145` (`test(cross-client): prove android manual upload contract`).
The shared executable fixture lives at
`tests/contracts/android-manual-upload-cross-client.json` and is asserted by
the Android shell, backend controller, and web Vitest fixture tests
referenced below. A full device/browser E2E proof remains out of scope here
and is tracked by the Band 8 final validation matrix.

## Scope

This proof aligns the Android manual upload handoff, Rust client-core upload
identifiers, backend opaque manifest creation contract, and web Rust-adapter seam
consumption at the shared contract level.

Included:

- shared executable fixture: `tests/contracts/android-manual-upload-cross-client.json`;
- Android shell fixture test proving the handoff DTO is privacy-safe and opaque;
- backend controller fixture test proving the manifest endpoint accepts only
  encrypted metadata, signatures, signer pubkeys, shard ids, and tier mapping;
- web Vitest fixture test proving the current adapter/worker-facing services send
  the backend manifest shape and download shard bytes without decoding.

Excluded:

- Android app UI, Photo Picker Activity Result wiring, WorkManager queue drain,
  Tus upload implementation, and device storage;
- full browser-visible "Android upload appears in web gallery" E2E;
- full all-tests, full Playwright, and final Band 8 matrix validation.

## Exact Opaque Data Flow

```text
Android Photo Picker grant
  -> immediate app-private staging
  -> AndroidManualUploadCoordinator.queueOnePhoto(...)
  -> ManualUploadClientCoreHandoffRequest
     {
       uploadJobId?: opaque string,
       albumId: opaque server album UUID string,
       assetId?: opaque local asset string,
       queueRecordId: opaque local queue string,
       stagedSource: app-private mosaic-staged:// reference,
       byteCount: non-negative byte length,
       stage: STAGED_SOURCE_READY | QUEUED_FOR_ENCRYPTION
     }
  -> Rust client-core upload reducer DTOs
     {
       localJobId / uploadId / albumId / assetId,
       epochId,
       completedShards: [
         { tier, index, shardId, sha256 }
       ],
       manifestReceipt: { manifestId, version }
     }
  -> backend POST /api/manifests
     {
       albumId,
       encryptedMeta: base64 bytes over JSON transport / byte[] in .NET,
       signature,
       signerPubkey,
       shardIds,
       tieredShards?: [{ shardId, tier }]
     }
  -> backend stores Manifest.EncryptedMeta byte[] and ManifestShard links only
  -> web sync receives ManifestRecord
     {
       id,
       albumId,
       versionCreated,
       isDeleted,
       encryptedMeta,
       signature,
       signerPubkey,
       shardIds
     }
  -> web crypto worker verifies/decrypts encryptedMeta client-side
  -> web shard service downloads /api/shards/{shardId} as Uint8Array
```

The shared fixture pins the concrete proof values:

```json
{
  "androidHandoff": {
    "uploadJobId": "upload-job-band3-cross-client",
    "albumId": "018f05a4-8b31-7c00-8c00-0000000000a3",
    "assetId": "asset-band3-cross-client",
    "queueRecordId": "queue-band3-cross-client",
    "stagedSource": "mosaic-staged://band3-cross-client/source",
    "byteCount": 6144,
    "stage": "STAGED_SOURCE_READY"
  },
  "backendManifestRequest": {
    "albumId": "018f05a4-8b31-7c00-8c00-0000000000a3",
    "encryptedMetaBase64": "wwEA/xAgMEBVZneI",
    "signature": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+Pw==",
    "signerPubkey": "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8=",
    "shardIds": [
      "018f05a4-8b31-7c00-8c00-000000000301",
      "018f05a4-8b31-7c00-8c00-000000000302",
      "018f05a4-8b31-7c00-8c00-000000000303"
    ],
    "tieredShards": [
      { "shardId": "018f05a4-8b31-7c00-8c00-000000000301", "tier": 1 },
      { "shardId": "018f05a4-8b31-7c00-8c00-000000000302", "tier": 2 },
      { "shardId": "018f05a4-8b31-7c00-8c00-000000000303", "tier": 3 }
    ]
  }
}
```

## Zero-Knowledge Invariants

- Android handoff DTOs and queue records contain no filenames, captions, EXIF,
  GPS, device metadata, decrypted metadata, raw keys, raw picker URIs, or media
  bytes.
- Android may hold an app-private `mosaic-staged://` reference locally, but that
  staged source never crosses the backend contract.
- Rust client-core snapshots/effects carry only opaque ids, tiers, shard indexes,
  encrypted SHA-256 values, manifest receipt ids, versions, and retry/sync state.
- Backend manifest creation accepts encrypted metadata bytes and shard references
  only; it does not parse metadata plaintext and does not echo opaque fields in
  the creation response.
- Web receives encrypted manifest fields and shard ids, verifies/decrypts via the
  crypto worker client-side, and downloads shard bytes as `Uint8Array` without
  server-side plaintext assumptions.

## Component Tree

```text
apps/android-shell
  src/main/kotlin/org/mosaic/android/foundation/ManualUploadCoordinator.kt
  src/main/kotlin/org/mosaic/android/foundation/UploadQueueRecord.kt
  src/test/kotlin/org/mosaic/android/foundation/AndroidShellFoundationTest.kt

crates/mosaic-client
  src/state_machine.rs

apps/backend
  Mosaic.Backend/Models/Manifests/ManifestRequests.cs
  Mosaic.Backend/Controllers/ManifestsController.cs
  Mosaic.Backend.Tests/Controllers/ManifestsControllerTests.cs

apps/web
  src/lib/client-core-adapter.ts
  src/lib/manifest-service.ts
  src/lib/shard-service.ts
  tests/android-manual-upload-cross-client-contract.test.ts

tests/contracts
  android-manual-upload-cross-client.json
```

## Verification Plan

Focused proof gates:

1. `.\scripts\test-android-shell.ps1`
2. `dotnet test apps\backend\Mosaic.Backend.Tests --filter FullyQualifiedName~ManifestsControllerTests.Create_AcceptsCrossClientManualUploadFixture_AndPreservesOpaqueFields`
3. `cd apps\web; npm run test:run -- tests/android-manual-upload-cross-client-contract.test.ts`
4. `git diff --check`

## Remaining Gap to Real Device E2E

A full Android-upload-visible-on-web E2E requires a real Android module/device
harness that can:

1. launch the Android app and grant Photo Picker access;
2. stage selected media into app-private storage;
3. run the WorkManager foreground `dataSync` upload drain;
4. encrypt shards/metadata through generated UniFFI bindings;
5. upload encrypted shard bytes through Tus and create the manifest;
6. open the web app and verify sync renders the uploaded asset.

Those prerequisites are absent in this repository slice, so Band 3 exits with a
contract proof. Band 8 remains responsible for the final device/browser matrix
once the Android app and harness exist.

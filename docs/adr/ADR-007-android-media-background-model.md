# ADR-007: Use Photo Picker for manual upload and least-privilege MediaStore/WorkManager for future auto-import

## Status

Accepted

## Context

Android support is limited to Android. The initial product value is encrypted upload/import for sharing, not replacing the web gallery or building a general backup agent. Android has strict URI lifetime, permission, foreground-service, and background execution constraints.

Manual user-selected upload and future automatic camera-roll import have different security and lifecycle requirements.

## Decision

Manual Android upload uses Android Photo Picker. The app opens selected URIs immediately and either streams content into Rust encryption or copies it into encrypted app-private staging if work may outlive URI access.

Future camera-roll auto-import uses MediaStore discovery and WorkManager with a foreground `dataSync` notification during long active transfers. Auto-import is explicit opt-in, permission-gated by Android API level, and scoped to selected albums.

Durable queue records may store:

- opaque local asset IDs and generation/version markers,
- selected destination album ID and epoch/capability ID,
- queue state, retry count, timestamps, byte counts, encrypted staged blob references,
- encrypted shard references after successful encryption/upload.

Durable queue records must not store plaintext filenames, captions, EXIF, GPS data, camera/device metadata, decrypted photo metadata, keys, or raw content URIs as the only source needed for retry.

## Options Considered

### Persist Photo Picker URIs and process later

- Pros: simple queue model.
- Cons: URI access can expire; unreliable after process death; risks stuck uploads.
- Conviction: 2/10.

### Request broad storage permissions for all media

- Pros: easier scanner implementation.
- Cons: poor privacy posture; unnecessary for manual upload; likely Play policy/user-trust risk.
- Conviction: 2/10.

### Separate manual Photo Picker and future MediaStore auto-import paths

- Pros: least privilege; realistic Android lifecycle behavior; clean manual MVP.
- Cons: two adapter paths to test.
- Conviction: 9/10.

## Consequences

- Android MVP does not require automatic background import.
- Auto-import architecture exists as a separate least-privilege capability and can be implemented later without redesigning session handles.
- Queue privacy tests must scan app-private DB/logs for plaintext media signatures, EXIF, filenames, keys, and forbidden metadata.
- WorkManager tests must cover process death, reboot/user-unlock, retry/backoff, cancellation, constraints, and notification permission denial.

## Reversibility

Low-cost for auto-import details because automation is not implemented in the MVP. Manual upload must remain Photo Picker based unless a later ADR justifies broader permissions.

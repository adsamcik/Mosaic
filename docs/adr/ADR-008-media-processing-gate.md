# ADR-008: Gate Rust media processing behind cross-platform prototype results

## Status

Accepted

## Context

Mosaic needs thumbnails, previews, normalized display originals, metadata stripping, metadata preservation policy, and possible source-original archival. Moving media processing into Rust could improve parity across web and Android, but image codecs carry security, portability, licensing, binary-size, color-management, and performance risks.

The Android encrypted upload MVP should not be blocked on solving all media processing questions.

## Decision

Media processing is a separate `mosaic-media` module and is not part of the Rust crypto/domain/client core. Rust media adoption requires a prototype that measures JPEG, PNG, WebP, HEIC/HEIF, and AVIF on web and Android.

The MVP may use platform-native media adapters if they satisfy:

- no plaintext media or metadata reaches the server,
- normalized gallery tiers are metadata-stripped,
- preserved recognized metadata is encrypted in manifest/sidecar records,
- metadata preservation/export settings are honored,
- outputs pass security and visual correctness tests.

The media prototype must compare AVIF and WebP as canonical output candidates. Security and metadata correctness outrank quality; quality outranks performance/size.

### Android manual upload closeout evidence

As of 2026-04-28, the Android one-photo encrypted upload MVP can proceed with
platform-native codec adapters while using Rust for the media-core rules that
must match Mosaic protocol behavior:

- dependency-free container inspection for JPEG, PNG, and WebP,
- canonical thumbnail/preview/original tier dimension planning,
- recognized metadata sidecar construction from inspected media metadata,
- metadata sidecar encryption through the existing epoch-handle envelope path,
- stable UniFFI exports for Android bridge tests.

This closes the media-core readiness evidence needed before the manual Android
upload MVP. It does not adopt Rust codecs. The broader Rust codec prototype
remains required before replacing native adapters with Rust encode/decode
implementations, especially for HEIC/HEIF and AVIF cross-platform measurements.

## Options Considered

### Put all codecs and image processing in Rust immediately

- Pros: maximum parity if successful.
- Cons: high risk; can block Android upload; codec dependencies expand attack surface.
- Conviction: 4/10.

### Keep media processing permanently platform-native

- Pros: fastest per-platform implementation; uses OS/browser codecs.
- Cons: behavior can diverge; metadata stripping/preservation needs duplicated tests.
- Conviction: 6/10.

### Gate Rust media behind a non-blocking prototype

- Pros: evidence-driven; does not block Android upload; keeps a path to parity.
- Cons: requires a later adoption decision and duplicate temporary adapters.
- Conviction: 9/10.

## Consequences

- `mosaic-media` cannot be a dependency of `mosaic-crypto`.
- HEIC/HEIF/AVIF support is measured before adoption, not assumed.
- Source-original archival is optional, encrypted, off by default, and quota-counted.
- Media fixtures must use generated, public-domain, or test-licensed files only.
- Byte-identical media output across platforms is not required if visual equivalence and metadata/security tests pass.

## Reversibility

High. Rust media can be adopted, delayed, narrowed, or abandoned based on prototype evidence without invalidating the Rust crypto/domain/client architecture.

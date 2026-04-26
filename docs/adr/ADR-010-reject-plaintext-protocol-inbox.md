# ADR-010: Reject generic plaintext protocol import inboxes

## Status

Accepted

## Context

Common device upload protocols such as WebDAV, SFTP, SMB, S3-compatible upload, and generic Tus clients can move bytes from Android devices to a server. They cannot perform Mosaic-specific client-side encryption, tier generation, metadata policy enforcement, manifest signing, epoch-key selection, or zero-knowledge upload finalization.

Accepting raw photos into a server-side import inbox would make the server handle plaintext media.

## Decision

Mosaic will not support a generic plaintext protocol import inbox.

Upload integrations must either:

- run Mosaic client-core encryption and manifest logic before bytes reach the backend, or
- be rejected as incompatible with the zero-knowledge model.

Tus remains an internal encrypted-shard transport after client-side encryption. It is not a generic plaintext photo upload API.

## Options Considered

### WebDAV/SFTP/SMB/S3 plaintext inbox

- Pros: broad compatibility with Android automation apps.
- Cons: server receives plaintext; metadata leakage; requires server media processing; contradicts Mosaic's threat model.
- Conviction: 1/10.

### Generic encrypted blob inbox without Mosaic manifests

- Pros: avoids plaintext on server if external tool encrypts.
- Cons: no album membership/key semantics; no signed manifests; no tier metadata; poor UX and recovery.
- Conviction: 3/10.

### Mosaic-aware Android app using shared Rust client core

- Pros: preserves E2EE; supports manifests, tiers, metadata policy, expiration, and sharing semantics.
- Cons: requires building and maintaining an Android client.
- Conviction: 9/10.

## Consequences

- Android upload work proceeds through a Mosaic-native app, not protocol adapters that bypass client crypto.
- Backend APIs must reject any endpoint or field that suggests plaintext import.
- Documentation should clarify that third-party protocol upload tools are unsuitable unless they embed the Mosaic client core.

## Reversibility

Hard within the current threat model. Adding plaintext server import would require redefining Mosaic's zero-knowledge promise and is rejected for v1.

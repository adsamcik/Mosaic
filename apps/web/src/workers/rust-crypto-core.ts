import initRustWasm, * as rustWasm from '../generated/mosaic-wasm/mosaic_wasm.js';

const RUST_OK = 0;
const MANIFEST_SIGNATURE_BYTES = 64;
const IDENTITY_PUBLIC_KEY_BYTES = 32;
const ENVELOPE_HEADER_BYTES = 64;
const MANIFEST_CONTEXT = new TextEncoder().encode('Mosaic_Manifest_v1');

export interface RustHeaderResult {
  readonly code: number;
  readonly epochId: number;
  readonly shardIndex: number;
  readonly tier: number;
  free(): void;
}

export interface RustCryptoCore {
  parseEnvelopeHeader(bytes: Uint8Array): RustHeaderResult;
  verifyManifestWithIdentity(
    transcriptBytes: Uint8Array,
    signature: Uint8Array,
    publicKey: Uint8Array,
  ): number;
}

let rustCryptoCorePromise: Promise<RustCryptoCore> | null = null;

export function getRustCryptoCore(): Promise<RustCryptoCore> {
  rustCryptoCorePromise ??= initRustWasm().then(() => rustWasm);
  return rustCryptoCorePromise;
}

export function buildLegacyManifestTranscript(
  manifest: Uint8Array,
): Uint8Array {
  const transcript = new Uint8Array(MANIFEST_CONTEXT.length + manifest.length);
  transcript.set(MANIFEST_CONTEXT, 0);
  transcript.set(manifest, MANIFEST_CONTEXT.length);
  return transcript;
}

export function verifyLegacyManifestWithRust(
  rust: RustCryptoCore,
  manifest: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (
    signature.length !== MANIFEST_SIGNATURE_BYTES ||
    publicKey.length !== IDENTITY_PUBLIC_KEY_BYTES
  ) {
    return false;
  }

  const transcript = buildLegacyManifestTranscript(manifest);
  return (
    rust.verifyManifestWithIdentity(transcript, signature, publicKey) === RUST_OK
  );
}

export function parseEnvelopeHeaderFromRust(
  rust: RustCryptoCore,
  envelope: Uint8Array,
): { epochId: number; shardId: number; tier: number } {
  const result = rust.parseEnvelopeHeader(envelope.slice(0, ENVELOPE_HEADER_BYTES));
  try {
    if (result.code !== RUST_OK) {
      throw new Error(`Rust envelope header parse failed with code ${result.code}`);
    }

    return {
      epochId: result.epochId,
      shardId: result.shardIndex,
      tier: result.tier,
    };
  } finally {
    result.free();
  }
}

/**
 * Golden-vector runner — Slice 0D test infrastructure
 *
 * Loads the cross-client corpus authored by Slice 0B at `tests/vectors/*.json`,
 * validates each entry against `tests/vectors/golden-vector.schema.json` with
 * zod, and exposes typed accessors plus a generic differential runner.
 *
 * Used by every later migration slice (1-8) to prove byte-exact compatibility
 * between TS, Rust, WASM, and UniFFI clients.
 *
 * Vitest runs in Node, so we use `node:fs` and `import.meta.url` for FS access.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Vector kinds — keep in sync with files in `tests/vectors/`.
// ---------------------------------------------------------------------------

export const VECTOR_KINDS = [
  'account_unlock',
  'auth_challenge',
  'auth_keypair',
  'content_encrypt',
  'epoch_derive',
  'identity',
  'link_keys',
  'link_secret',
  'manifest_transcript',
  'sealed_bundle',
  'shard_envelope',
  'tier_key_wrap',
] as const;

export type VectorKind = (typeof VECTOR_KINDS)[number];

const VECTOR_FILE_BY_KIND: Record<VectorKind, string> = {
  account_unlock: 'account_unlock.json',
  auth_challenge: 'auth_challenge.json',
  auth_keypair: 'auth_keypair.json',
  content_encrypt: 'content_encrypt.json',
  epoch_derive: 'epoch_derive.json',
  identity: 'identity.json',
  link_keys: 'link_keys.json',
  link_secret: 'link_secret.json',
  manifest_transcript: 'manifest_transcript.json',
  sealed_bundle: 'sealed_bundle.json',
  shard_envelope: 'shard_envelope.json',
  tier_key_wrap: 'tier_key_wrap.json',
};

// ---------------------------------------------------------------------------
// Common envelope schema — matches tests/vectors/golden-vector.schema.json.
// We only validate the shape we actually consume in tests; the upstream schema
// already covers the rest in cargo + the schema test.
// ---------------------------------------------------------------------------

const negativeCaseSchema = z.object({
  name: z.string().min(1),
  mutations: z.array(z.string().min(1)).min(1),
  errorCode: z.string().regex(/^[A-Z0-9_]+$/),
});

const serverBoundOutputSchema = z.object({
  name: z.string().min(1),
  classification: z.enum([
    'random',
    'encrypted',
    'public-cryptographic',
    'opaque-id',
    'operational-metadata',
    'expiration-lifecycle-metadata',
  ]),
  reason: z.string().min(1),
});

const forbiddenServerOutputSchema = z.object({
  name: z.string().min(1),
  reason: z.string().min(1),
  errorCode: z.string().regex(/^[A-Z0-9_]+$/),
});

const baseVectorSchema = z.object({
  schemaVersion: z.literal(1),
  rust_canonical: z.boolean().optional().default(false),
  operation: z.string().regex(/^[a-z0-9]+(\.[a-z0-9-]+)+$/),
  protocolVersion: z.string().regex(/^mosaic-v[0-9]+$/),
  description: z.string().min(1),
  algorithms: z.record(z.string(), z.string().min(1)),
  domainLabels: z.array(z.string().regex(/^mosaic\.v[0-9]+\.[a-z0-9.-]+$/)),
  inputs: z.record(z.string(), z.unknown()),
  expected: z.record(z.string(), z.unknown()),
  negativeCases: z.array(negativeCaseSchema),
  serverBoundOutputs: z.array(serverBoundOutputSchema),
  forbiddenServerOutputs: z.array(forbiddenServerOutputSchema),
});

// ---------------------------------------------------------------------------
// Per-kind input/output shapes. These are intentionally narrow — they match
// the corpus authored by Slice 0B — so callers get strong typing.
// ---------------------------------------------------------------------------

const accountUnlockInputs = z.object({
  userSaltHex: z.string(),
  accountSaltHex: z.string(),
  l0MasterKeyHex: z.string(),
  wrappedAccountKeyHex: z.string(),
});
const accountUnlockOutputs = z.object({
  l1RootKeyHex: z.string(),
  accountKeyHex: z.string(),
  unwrapSucceeds: z.boolean(),
});

const authChallengeInputs = z.object({
  authSigningSeedHex: z.string(),
  authPublicKeyHex: z.string(),
  username: z.string(),
  challengeHex: z.string(),
  timestampMs: z.number(),
});
const authChallengeOutputs = z.object({
  transcriptNoTimestampHex: z.string(),
  transcriptWithTimestampHex: z.string(),
  signatureNoTimestampHex: z.string(),
  signatureWithTimestampHex: z.string(),
});

const authKeypairInputs = z.object({
  l0MasterKeyHex: z.string(),
});
const authKeypairOutputs = z.object({
  authSigningSeedHex: z.string(),
  authPublicKeyHex: z.string(),
});

const contentEncryptInputs = z.object({
  contentKeyHex: z.string(),
  epochId: z.number().int(),
  nonceHex: z.string(),
  plaintextHex: z.string(),
});
const contentEncryptOutputs = z.object({
  ciphertextHex: z.string(),
  decryptedHex: z.string(),
});

const epochDeriveInputs = z.object({
  epochSeedHex: z.string(),
});
const epochDeriveOutputs = z.object({
  thumbKeySha256: z.string(),
  previewKeySha256: z.string(),
  fullKeySha256: z.string(),
  contentKeySha256: z.string(),
});

const identityInputs = z.object({
  identitySeedHex: z.string(),
  identityMessageHex: z.string(),
});
const identityOutputs = z.object({
  signingPubkeyHex: z.string(),
  encryptionPubkeyHex: z.string(),
  signatureHex: z.string(),
});

const linkKeysInputs = z.object({
  linkSecretHex: z.string(),
});
const linkKeysOutputs = z.object({
  linkIdHex: z.string(),
  wrappingKeyHex: z.string(),
});

const linkSecretInputs = z.object({}).passthrough();
const linkSecretOutputs = z.object({
  lengthBytes: z.number().int().positive(),
});

const manifestTranscriptShard = z.object({
  chunkIndex: z.number().int().nonnegative(),
  tier: z.number().int(),
  shardIdHex: z.string(),
  sha256Hex: z.string(),
});
const manifestTranscriptInputs = z.object({
  albumIdHex: z.string(),
  epochId: z.number().int(),
  encryptedMetaHex: z.string(),
  shards: z.array(manifestTranscriptShard).min(1),
});
const manifestTranscriptOutputs = z.object({
  transcriptHex: z.string(),
});

const sealedBundleInputs = z.object({
  sealedHex: z.string(),
  signatureHex: z.string(),
  sharerPubkeyHex: z.string(),
  recipientIdentitySeedHex: z.string(),
  expectedOwnerEd25519PubHex: z.string(),
  validation: z.object({
    albumId: z.string(),
    minEpochId: z.number().int(),
    allowLegacyEmptyAlbumId: z.boolean(),
  }),
});
const sealedBundleOutputs = z.object({
  bundleVersion: z.number().int(),
  bundleAlbumId: z.string(),
  bundleEpochId: z.number().int(),
  bundleRecipientPubkeyHex: z.string(),
  bundleEpochSeedHex: z.string(),
  bundleSignPublicKeyHex: z.string(),
});

const shardEnvelopeTier = z.object({
  tier: z.number().int(),
  shardIndex: z.number().int(),
  tierKeyHex: z.string(),
  nonceHex: z.string(),
  plaintextHex: z.string(),
});
const shardEnvelopeInputs = z.object({
  epochId: z.number().int(),
  tiers: z.array(shardEnvelopeTier).min(1),
});
const shardEnvelopeExpectedTier = z.object({
  tier: z.number().int(),
  envelopeHex: z.string(),
});
const shardEnvelopeOutputs = z.object({
  tiers: z.array(shardEnvelopeExpectedTier).min(1),
});

const tierKeyWrapInputs = z.object({
  linkSecretHex: z.string(),
  tierKeyHex: z.string(),
  tierByte: z.number().int(),
  nonceHex: z.string(),
});
const tierKeyWrapOutputs = z.object({
  tier: z.number().int(),
  nonceHex: z.string(),
  encryptedKeyHex: z.string(),
  unwrappedKeyHex: z.string(),
});

const KIND_SCHEMAS = {
  account_unlock: { inputs: accountUnlockInputs, outputs: accountUnlockOutputs },
  auth_challenge: { inputs: authChallengeInputs, outputs: authChallengeOutputs },
  auth_keypair: { inputs: authKeypairInputs, outputs: authKeypairOutputs },
  content_encrypt: { inputs: contentEncryptInputs, outputs: contentEncryptOutputs },
  epoch_derive: { inputs: epochDeriveInputs, outputs: epochDeriveOutputs },
  identity: { inputs: identityInputs, outputs: identityOutputs },
  link_keys: { inputs: linkKeysInputs, outputs: linkKeysOutputs },
  link_secret: { inputs: linkSecretInputs, outputs: linkSecretOutputs },
  manifest_transcript: {
    inputs: manifestTranscriptInputs,
    outputs: manifestTranscriptOutputs,
  },
  sealed_bundle: { inputs: sealedBundleInputs, outputs: sealedBundleOutputs },
  shard_envelope: { inputs: shardEnvelopeInputs, outputs: shardEnvelopeOutputs },
  tier_key_wrap: { inputs: tierKeyWrapInputs, outputs: tierKeyWrapOutputs },
} as const;

export type VectorInputs<K extends VectorKind> = z.infer<
  (typeof KIND_SCHEMAS)[K]['inputs']
>;
export type VectorOutputs<K extends VectorKind> = z.infer<
  (typeof KIND_SCHEMAS)[K]['outputs']
>;

/** Loaded vector with parsed fields. */
export interface LoadedVector<K extends VectorKind> {
  readonly kind: K;
  readonly description: string;
  readonly operation: string;
  readonly protocolVersion: string;
  readonly rustCanonical: boolean;
  readonly inputs: VectorInputs<K>;
  readonly outputs: VectorOutputs<K>;
  readonly negativeCases: ReadonlyArray<{
    readonly name: string;
    readonly mutations: ReadonlyArray<string>;
    readonly errorCode: string;
  }>;
}

// Convenience union covering every vector kind with its strong shape.
export type VectorOf<K extends VectorKind> = LoadedVector<K>;

// ---------------------------------------------------------------------------
// Filesystem discovery
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/web/tests/_helpers/ → ../../../tests/vectors/
const CORPUS_DIR_DEFAULT = resolve(HERE, '..', '..', '..', '..', 'tests', 'vectors');

let cachedCorpusDir: string | null = null;

/**
 * Resolve the vector corpus directory. Defaults to the repository's
 * `tests/vectors/` folder relative to this helper's file location.
 *
 * Override via `MOSAIC_VECTOR_CORPUS_DIR` env var if a slice ever needs to
 * point at a different snapshot (e.g. an experimental corpus during a
 * migration cycle).
 */
export function resolveCorpusDir(): string {
  if (cachedCorpusDir) return cachedCorpusDir;
  const fromEnv = process.env.MOSAIC_VECTOR_CORPUS_DIR;
  cachedCorpusDir = fromEnv && fromEnv.length > 0 ? fromEnv : CORPUS_DIR_DEFAULT;
  return cachedCorpusDir;
}

/**
 * List the JSON files present in the corpus, excluding the schema file.
 * Useful for cross-checking that every kind we know about is on disk.
 */
export function listCorpusFiles(): string[] {
  const dir = resolveCorpusDir();
  return readdirSync(dir)
    .filter(
      (name) =>
        name.endsWith('.json') &&
        name !== 'golden-vector.schema.json' &&
        !name.startsWith('_') &&
        !name.startsWith('.'),
    )
    .sort();
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const loadCache = new Map<VectorKind, LoadedVector<VectorKind>>();

/**
 * Load and parse a single vector by kind. Performs:
 * 1. Filesystem read
 * 2. JSON parse
 * 3. Base envelope validation against the published schema (zod port)
 * 4. Per-kind narrow input/output validation
 *
 * Throws a descriptive `Error` on any validation failure so callers can
 * surface helpful messages in test output.
 */
export function loadVector<K extends VectorKind>(kind: K): LoadedVector<K> {
  const cached = loadCache.get(kind);
  if (cached) return cached as LoadedVector<K>;

  const filename = VECTOR_FILE_BY_KIND[kind];
  const path = resolve(resolveCorpusDir(), filename);

  let rawJson: string;
  try {
    rawJson = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `golden-vector-runner: failed to read corpus file for kind "${kind}" at ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson) as unknown;
  } catch (err) {
    throw new Error(
      `golden-vector-runner: failed to parse JSON for kind "${kind}" at ${path}: ${(err as Error).message}`,
    );
  }

  const baseResult = baseVectorSchema.safeParse(parsed);
  if (!baseResult.success) {
    throw new Error(
      `golden-vector-runner: base-schema validation failed for kind "${kind}": ${baseResult.error.message}`,
    );
  }
  const base = baseResult.data;

  const kindSchemas = KIND_SCHEMAS[kind];
  const inputsResult = kindSchemas.inputs.safeParse(base.inputs);
  if (!inputsResult.success) {
    throw new Error(
      `golden-vector-runner: inputs validation failed for kind "${kind}": ${inputsResult.error.message}`,
    );
  }
  const outputsResult = kindSchemas.outputs.safeParse(base.expected);
  if (!outputsResult.success) {
    throw new Error(
      `golden-vector-runner: expected validation failed for kind "${kind}": ${outputsResult.error.message}`,
    );
  }

  const loaded: LoadedVector<K> = {
    kind,
    description: base.description,
    operation: base.operation,
    protocolVersion: base.protocolVersion,
    rustCanonical: base.rust_canonical ?? false,
    inputs: inputsResult.data as VectorInputs<K>,
    outputs: outputsResult.data as VectorOutputs<K>,
    negativeCases: base.negativeCases.map((nc) => ({
      name: nc.name,
      mutations: nc.mutations,
      errorCode: nc.errorCode,
    })),
  };

  loadCache.set(kind, loaded as LoadedVector<VectorKind>);
  return loaded;
}

/** Reset the in-process loader cache (test hook). */
export function resetVectorCache(): void {
  loadCache.clear();
  cachedCorpusDir = null;
}

// ---------------------------------------------------------------------------
// Hex utilities — exposed here so per-slice tests don't reinvent them.
// ---------------------------------------------------------------------------

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length input (${hex.length})`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(
        `hexToBytes: invalid hex pair at offset ${String(i * 2)}: "${hex.slice(i * 2, i * 2 + 2)}"`,
      );
    }
    out[i] = byte;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Differential runner
// ---------------------------------------------------------------------------

/** Result of a forward-direction implementation run. */
export interface DifferentialResult {
  /** Whatever bytes/values the impl produced — passed verbatim to the asserter. */
  readonly produced: unknown;
}

export interface RunDifferentialArgs<K extends VectorKind> {
  /** Vector kind to load. */
  readonly kind: K;
  /**
   * Forward-direction runner. Receives the vector's parsed `inputs` and must
   * return whatever shape `asserter` expects.
   *
   * Skipped entirely in `verifyOnly` mode.
   */
  readonly runImpl?: (
    inputs: VectorInputs<K>,
    expected: VectorOutputs<K>,
  ) => Promise<DifferentialResult> | DifferentialResult;
  /**
   * Asserter — compares forward-direction output against the vector's
   * `outputs` field. Throws on mismatch.
   *
   * Skipped entirely in `verifyOnly` mode.
   */
  readonly asserter?: (
    produced: unknown,
    expected: VectorOutputs<K>,
    inputs: VectorInputs<K>,
  ) => void | Promise<void>;
  /**
   * Reverse-direction (open/decrypt/verify) runner. Always invoked when
   * provided. In `verifyOnly` mode this is the only implementation that
   * runs — useful for non-deterministic operations like sealed-bundle seal
   * or share-link wrap, where forward bytes vary per invocation.
   */
  readonly runVerify?: (
    inputs: VectorInputs<K>,
    expected: VectorOutputs<K>,
  ) => Promise<void> | void;
  /**
   * Set true to skip the forward direction. Required for vectors marked
   * `rust_canonical: true` (no TS forward path exists yet) and for
   * non-deterministic operations.
   */
  readonly verifyOnly?: boolean;
}

/**
 * Generic differential runner shared by per-slice tests. Loads `kind`, runs
 * the supplied impls, and asserts.
 *
 * Returns the loaded vector so callers can pull out negativeCases for further
 * adversarial assertions in the same test block.
 */
export async function runDifferential<K extends VectorKind>(
  args: RunDifferentialArgs<K>,
): Promise<LoadedVector<K>> {
  const vector = loadVector(args.kind);

  const verifyOnly =
    args.verifyOnly === true ||
    // rust_canonical vectors lack a TS forward path until Phase 2 lands; treat
    // them as verify-only by default unless the caller explicitly opts in.
    (vector.rustCanonical && !args.runImpl);

  if (!verifyOnly) {
    if (!args.runImpl) {
      throw new Error(
        `runDifferential(${args.kind}): runImpl is required when verifyOnly=false`,
      );
    }
    if (!args.asserter) {
      throw new Error(
        `runDifferential(${args.kind}): asserter is required when verifyOnly=false`,
      );
    }
    const result = await args.runImpl(vector.inputs, vector.outputs);
    await args.asserter(result.produced, vector.outputs, vector.inputs);
  }

  if (args.runVerify) {
    await args.runVerify(vector.inputs, vector.outputs);
  }

  return vector;
}

/**
 * Microbenchmark suite — Slice 0D test infrastructure
 *
 * Measures the TypeScript reference (`@mosaic/crypto` + libsodium) baseline
 * for the operations Slice 5 will replace with Rust WASM. The committed
 * baseline JSON at `apps/web/tests/_perf/baseline-ts.json` is the comparison
 * target for the Slice 5 perf gate (≤10% regression budget).
 *
 * These benches exercise the TS reference directly (not through the Comlink
 * worker) for two reasons:
 *   1. happy-dom does not ship a Worker constructor, so a worker-routed bench
 *      cannot run in vitest's default environment.
 *   2. We want to isolate the crypto cost from the Comlink serialization cost.
 *      Slice 5's comparison bench will route through the worker on both the
 *      Rust and TS paths so the JS↔WASM boundary cost is part of the budget.
 *
 * Run: `npm --prefix apps/web run bench`
 */

import { bench, describe } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  AccessTier,
  decryptShard,
  deriveKeys,
  deriveTierKeys,
  encryptShard,
  generateEpochKey,
  generateLinkSecret,
  getArgon2Params,
  signManifest,
  wrapTierKeyForLink,
} from '@mosaic/crypto';

await sodium.ready;

const PASSWORD = 'correct horse battery staple';
const USER_SALT = sodium.randombytes_buf(16);
const ACCOUNT_SALT = sodium.randombytes_buf(16);

const FIVE_MIB = new Uint8Array(5 * 1024 * 1024);
crypto.getRandomValues(FIVE_MIB.subarray(0, 65536));
const MANIFEST_PLAINTEXT = sodium.randombytes_buf(512);

const epochSeed = sodium.randombytes_buf(32);
const tierKeys = deriveTierKeys(epochSeed);
const epochKey = generateEpochKey(0);
const fullEnvelopeFiveMiB = encryptShard(FIVE_MIB, tierKeys.fullKey, 0, 0, AccessTier.FULL);
const thumbEnvelopeManifest = encryptShard(
  MANIFEST_PLAINTEXT,
  tierKeys.thumbKey,
  0,
  0,
  AccessTier.THUMB,
);

const manifestEnvelopes100 = Array.from({ length: 100 }, () =>
  encryptShard(sodium.randombytes_buf(512), tierKeys.thumbKey, 0, 0, AccessTier.THUMB),
);
const manifestEnvelopes1000 = Array.from({ length: 1000 }, () =>
  encryptShard(sodium.randombytes_buf(512), tierKeys.thumbKey, 0, 0, AccessTier.THUMB),
);

const linkSecret = generateLinkSecret();
const linkWrappingKey = sodium.crypto_generichash(
  32,
  sodium.from_string('mosaic:link:wrap:v1'),
  linkSecret,
);

describe('crypto baseline (TS reference)', () => {
  bench(
    'argon2id login (deriveKeys / account unlock)',
    async () => {
      await deriveKeys(PASSWORD, USER_SALT, ACCOUNT_SALT, getArgon2Params());
    },
    { iterations: 5, warmupIterations: 1, time: 0 },
  );

  bench(
    'shard encrypt 5MiB (FULL tier)',
    () => {
      encryptShard(FIVE_MIB, tierKeys.fullKey, 0, 0, AccessTier.FULL);
    },
    { iterations: 10, warmupIterations: 2 },
  );

  bench(
    'shard decrypt 5MiB (FULL tier)',
    () => {
      decryptShard(fullEnvelopeFiveMiB, tierKeys.fullKey);
    },
    { iterations: 10, warmupIterations: 2 },
  );

  bench(
    'manifest decrypt loop (100 entries)',
    () => {
      for (const env of manifestEnvelopes100) {
        decryptShard(env, tierKeys.thumbKey);
      }
    },
    { iterations: 10, warmupIterations: 2 },
  );

  bench(
    'manifest decrypt loop (1000 entries)',
    () => {
      for (const env of manifestEnvelopes1000) {
        decryptShard(env, tierKeys.thumbKey);
      }
    },
    { iterations: 5, warmupIterations: 1 },
  );

  bench(
    'manifest sign (Ed25519 over 512-byte payload)',
    () => {
      signManifest(MANIFEST_PLAINTEXT, epochKey.signSecretKey);
    },
    { iterations: 100, warmupIterations: 10 },
  );

  bench(
    'share-link tier-key wrap',
    () => {
      wrapTierKeyForLink(tierKeys.thumbKey, AccessTier.THUMB, linkWrappingKey);
    },
    { iterations: 100, warmupIterations: 10 },
  );

  bench(
    'thumb-tier shard encrypt (small payload)',
    () => {
      encryptShard(MANIFEST_PLAINTEXT, tierKeys.thumbKey, 0, 0, AccessTier.THUMB);
    },
    { iterations: 100, warmupIterations: 10 },
  );

  bench(
    'thumb-tier shard decrypt (small payload)',
    () => {
      decryptShard(thumbEnvelopeManifest, tierKeys.thumbKey);
    },
    { iterations: 100, warmupIterations: 10 },
  );
});

/**
 * DbWorker — persistence-safe-snapshot redaction guard.
 *
 * Locks down the "Web client" checklist item from
 * `docs/specs/SPEC-CrossPlatformHardening.md` (lines ~136-138):
 *
 *   "OPFS/SQLite persistence contains encrypted data and
 *    persistence-safe snapshots only; no raw handles, raw picker URIs,
 *    plaintext media, plaintext metadata, or key material."
 *
 * The test asserts that the bytes the DB worker hands to the crypto
 * bridge for OPFS persistence carry no known raw-secret field name
 * (`epochSeed`, `signSecret`, `linkSecret`, `password`, `accountKey`,
 * raw `nonce`, etc.). With a passthrough bridge the input to
 * `bridge.wrap` IS the SQLite snapshot, so substring checks against
 * those bytes catch:
 *   - schema regressions that introduce a secret-bearing column;
 *   - INSERT-path regressions that serialize a key-bearing object into
 *     a JSON column;
 *   - source-level regressions that bake the field name into a query.
 *
 * Pairs with the static guard at
 * `tests/architecture/web-no-direct-console.{ps1,sh}` which keeps
 * direct `console.*` calls out of the same boundary.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import type {
  DbCryptoBridge,
  DecryptedManifest,
  PhotoMeta,
} from '../src/workers/types';

vi.mock('comlink', () => ({
  expose: vi.fn(),
}));

import { DbWorker, SNAPSHOT_VERSION } from '../src/workers/db.worker';

interface DbWorkerInternals {
  db: Database;
  crypto: DbCryptoBridge;
  saveToOPFS: () => Promise<void>;
}

/**
 * Production schema (snapshot of the v0->v8 photos/albums DDL from
 * `db.worker.ts`). Mirrors the schema set up by `runMigrations()` so
 * the runtime substring assertion below sees the same byte layout
 * SQLite would emit in the live worker.
 */
function createProductionSchema(db: Database): void {
  db.run(`
    CREATE TABLE albums (
      id TEXT PRIMARY KEY,
      current_version INTEGER DEFAULT 0
    );

    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      album_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      taken_at TEXT,
      lat REAL,
      lng REAL,
      tags TEXT,
      created_at TEXT,
      updated_at TEXT,
      shard_ids TEXT,
      epoch_id INTEGER,
      description TEXT,
      thumbnail TEXT,
      thumb_width INTEGER,
      thumb_height INTEGER,
      blurhash TEXT,
      thumbnail_shard_id TEXT,
      thumbnail_shard_hash TEXT,
      preview_shard_id TEXT,
      preview_shard_hash TEXT,
      original_shard_ids TEXT,
      original_shard_hashes TEXT,
      thumbhash TEXT,
      is_video INTEGER DEFAULT 0,
      duration REAL,
      rotation INTEGER DEFAULT 0,
      version_created INTEGER DEFAULT 0
    );
  `);
}

function makeBridgeStub() {
  return {
    wrap: vi.fn(async (plaintext: Uint8Array) => {
      // Passthrough — the test wants to inspect the plaintext snapshot
      // bytes. Production wraps this through Rust XChaCha20-Poly1305.
      return new Uint8Array(plaintext);
    }),
    unwrap: vi.fn(async (wrapped: Uint8Array) => new Uint8Array(wrapped)),
  } satisfies DbCryptoBridge & {
    wrap: ReturnType<typeof vi.fn>;
    unwrap: ReturnType<typeof vi.fn>;
  };
}

/**
 * Stand up a fake OPFS root so `saveToOPFS` runs end-to-end without
 * a real `navigator.storage`. Captures the bytes that would have
 * landed on disk so the on-disk envelope shape can also be asserted.
 */
function installFakeOPFS(): { writes: Uint8Array[] } {
  const writes: Uint8Array[] = [];
  const writable = {
    write: vi.fn(async (data: ArrayBuffer | Uint8Array) => {
      const u8 =
        data instanceof Uint8Array
          ? new Uint8Array(data)
          : new Uint8Array(data);
      writes.push(u8);
    }),
    close: vi.fn(async () => {
      // no-op
    }),
  };
  const fileHandle = {
    createWritable: vi.fn(async () => writable),
    getFile: vi.fn(async () => ({
      arrayBuffer: async () => new ArrayBuffer(0),
    })),
  };
  const root = {
    getFileHandle: vi.fn(async () => fileHandle),
    removeEntry: vi.fn(async () => {
      // no-op
    }),
  };
  vi.stubGlobal('navigator', {
    storage: { getDirectory: vi.fn(async () => root) },
  });
  return { writes };
}

function makeManifest(overrides: Partial<PhotoMeta> = {}): DecryptedManifest {
  const meta: PhotoMeta = {
    id: 'photo-d1',
    assetId: 'asset-d1',
    albumId: 'album-d1',
    filename: 'vacation.jpg',
    mimeType: 'image/jpeg',
    width: 4032,
    height: 3024,
    takenAt: '2026-04-30T10:00:00.000Z',
    lat: 40.0,
    lng: -73.0,
    tags: ['family', 'beach'],
    createdAt: '2026-04-30T10:00:00.000Z',
    updatedAt: '2026-04-30T10:00:00.000Z',
    shardIds: ['shard-a', 'shard-b'],
    epochId: 7,
    description: 'Day at the beach',
    thumbhash: 'thumbhash-base64-placeholder',
    thumbnailShardId: 'shard-thumb',
    thumbnailShardHash: 'aaaa1111',
    previewShardId: 'shard-preview',
    previewShardHash: 'bbbb2222',
    originalShardIds: ['shard-orig-1', 'shard-orig-2'],
    originalShardHashes: ['cccc3333', 'dddd4444'],
    rotation: 0,
    ...overrides,
  };
  return {
    id: meta.id,
    albumId: meta.albumId,
    versionCreated: 1,
    isDeleted: false,
    meta,
    shardIds: meta.shardIds,
  };
}

/**
 * Field names that MUST NEVER appear in a persisted SQLite snapshot.
 * SQLite stores schema strings (table/column names) as plain UTF-8 in
 * the file's `sqlite_master` page, and JSON-encoded text columns
 * preserve any object key names verbatim — so a regression that
 * persists key/seed material under any of these names will leave
 * detectable substrings in the snapshot bytes.
 */
const FORBIDDEN_SECRET_NAMES = [
  // Camel-case TS field names
  'epochSeed',
  'signSecret',
  'signSeed',
  'linkSecret',
  'accountKey',
  'identitySeed',
  'sessionKey',
  'authSecret',
  // Snake-case SQL column candidates
  'epoch_seed',
  'sign_secret',
  'sign_seed',
  'link_secret',
  'account_key',
  'identity_seed',
  'session_key',
  'auth_secret',
  // Generic
  'password',
  'passphrase',
];

describe('DbWorker — persistence-safe-snapshot rule (Lane D1)', () => {
  let db: Database;
  let worker: DbWorker;
  let bridge: ReturnType<typeof makeBridgeStub>;
  let opfs: { writes: Uint8Array[] };

  beforeEach(async () => {
    opfs = installFakeOPFS();
    const SQL = await initSqlJs();
    db = new SQL.Database();
    createProductionSchema(db);

    worker = new DbWorker();
    bridge = makeBridgeStub();
    const internal = worker as unknown as DbWorkerInternals;
    internal.db = db;
    internal.crypto = bridge;
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('the persisted snapshot bytes contain no known raw-secret field name', async () => {
    // Seed a fully-populated manifest so every column carries data
    // (defends against a regression that only leaks when a particular
    // optional column is non-null).
    await worker.insertManifests([makeManifest()]);
    await worker.setAlbumVersion('album-d1', 1);

    expect(bridge.wrap).toHaveBeenCalled();
    const lastWrapInput = bridge.wrap.mock.calls.at(-1)?.[0];
    expect(lastWrapInput).toBeInstanceOf(Uint8Array);
    const snapshot = lastWrapInput as Uint8Array;
    expect(snapshot.byteLength).toBeGreaterThan(0);

    // Decode as latin-1 so binary SQLite header bytes don't truncate
    // the searchable text — every byte maps to a code point and
    // substring matching sees ASCII column names exactly.
    const text = new TextDecoder('latin1').decode(snapshot);

    for (const name of FORBIDDEN_SECRET_NAMES) {
      expect(
        text.includes(name),
        `Persisted SQLite snapshot must not contain '${name}'.\nSPEC-CrossPlatformHardening.md "Web client" checklist forbids key material in OPFS persistence.`,
      ).toBe(false);
    }

    // Raw `nonce` (XChaCha20 nonce) and `iv` (legacy IV) must never
    // appear OUTSIDE the bridge envelope. The bridge's output (which
    // wraps the snapshot above) carries the nonce in its first 24
    // bytes — but those bytes live in the wrapped form, not the
    // plaintext snapshot we're inspecting here.
    expect(text).not.toMatch(/\bnonce\b/i);
    // The literal column-name token "iv" matched as a word boundary
    // would false-positive on natural words; we only forbid the JSON
    // object-key form `"iv"` and the snake-case column form.
    expect(text).not.toContain('"iv"');
    expect(text).not.toContain('iv_bytes');
  });

  it('the on-disk OPFS bytes carry the SNAPSHOT_VERSION envelope', async () => {
    await worker.setAlbumVersion('album-d1', 1);

    expect(opfs.writes.length).toBeGreaterThan(0);
    const onDisk = opfs.writes.at(-1) as Uint8Array;

    // Slice 8 envelope: `[u8 SNAPSHOT_VERSION][...wrapKey blob...]`.
    expect(onDisk[0]).toBe(SNAPSHOT_VERSION);

    // With the passthrough bridge the wrapped tail equals the SQLite
    // export. In production it is XChaCha20-Poly1305 ciphertext, which
    // (a) carries the nonce inside the bridge envelope and (b) makes
    // the snapshot opaque on disk.
    expect(onDisk.byteLength).toBeGreaterThan(1);
  });

  it('source-level: db.worker.ts schema declares no secret-bearing column', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const dbWorkerPath = resolve(here, '../src/workers/db.worker.ts');
    const rawSource = readFileSync(dbWorkerPath, 'utf8');

    // Strip line and block comments so historical doc strings (e.g.
    // "replaces the legacy sessionKey field") don't trip the guard —
    // we only care about executable schema/SQL/value-binding code.
    const source = rawSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    // Schema-declaration shape: `<name> TEXT`, `<name> INTEGER`, etc.
    // Any forbidden field name appearing as a column type declaration
    // would be a Tier-A regression.
    const schemaTokenRegex =
      /\b(TEXT|INTEGER|BLOB|REAL|NUMERIC)\b\s*(?:NOT NULL|DEFAULT|PRIMARY|UNIQUE|,|\)|;|$)/i;
    void schemaTokenRegex; // referenced for grep visibility

    for (const name of FORBIDDEN_SECRET_NAMES) {
      const columnDecl = new RegExp(
        `\\b${name}\\b\\s+(TEXT|INTEGER|BLOB|REAL|NUMERIC)\\b`,
        'i',
      );
      expect(
        columnDecl.test(source),
        `db.worker.ts must not declare a column named '${name}' (regression of SPEC "Web client" checklist).`,
      ).toBe(false);
    }

    // Belt-and-braces: no CREATE TABLE / ALTER TABLE statement may add
    // a "nonce" column to the local cache.
    expect(source).not.toMatch(/(CREATE TABLE|ALTER TABLE)[^;]*\bnonce\b/i);
  });

  it('insertManifests persists tag/description text but never the secret field names', async () => {
    // Adversarial fixture: a user types the literal string "password"
    // into a description. That string IS allowed to round-trip — what
    // we forbid is the *field name* appearing in the schema or in a
    // structural JSON key. Verify: the description survives, but no
    // forbidden secret field-name substring leaks into a structural
    // position.
    const description = 'this contains the literal word password';
    await worker.insertManifests([makeManifest({ description })]);
    await worker.setAlbumVersion('album-d1', 1);

    const snapshot = bridge.wrap.mock.calls.at(-1)?.[0] as Uint8Array;
    const text = new TextDecoder('latin1').decode(snapshot);

    // The user's description (treated as data) does appear:
    expect(text).toContain('this contains the literal word');

    // But the schema must not name any column "password" — verify
    // there is no SQL token shape `password TEXT`/`password INTEGER`.
    expect(text).not.toMatch(/\bpassword\s+(TEXT|INTEGER|BLOB|REAL|NUMERIC)/i);
    expect(text).not.toMatch(
      /\b(epochSeed|signSecret|linkSecret|accountKey|identitySeed)\s*=/,
    );
  });
});

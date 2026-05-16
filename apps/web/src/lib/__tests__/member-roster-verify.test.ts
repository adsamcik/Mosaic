/**
 * Member-roster verify path tests (batch C2c-2 — C2).
 *
 * Covers the visitor-side decision tree that closes audit
 * `threat-model C-3`: a server can no longer fabricate role badges
 * because the client refuses to trust the members list unless an
 * owner-signed roster matches the live data byte-for-byte.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  verifyRosterSignature,
  type RosterAlbumInput,
  type RosterMemberInput,
  type RosterVerifyDeps,
} from '../member-roster-verify';

const ALBUM_A_UUID = 'a0a1a2a3-a4a5-a6a7-a8a9-aaabacadaeaf';
const MEMBER_X_UUID = '10111213-1415-1617-1819-1a1b1c1d1e1f';
const VALID_SIGNATURE = btoa(String.fromCharCode(...new Array(64).fill(0xab)));
const NONEMPTY_PUBKEY = new Uint8Array(32).fill(7);

function makeDeps(overrides: Partial<RosterVerifyDeps> = {}): RosterVerifyDeps {
  return {
    fetchEpochKey: vi.fn(async () => ({ signPublicKey: NONEMPTY_PUBKEY })),
    verifySignature: vi.fn(async () => true),
    ...overrides,
  };
}

describe('verifyRosterSignature decision tree', () => {
  it('returns { unsigned } when the album has no roster signature yet', async () => {
    const album: RosterAlbumInput = {
      id: ALBUM_A_UUID,
      memberRosterSignature: null,
      memberRosterSignerEpochId: null,
      memberRosterVersion: null,
    };
    const result = await verifyRosterSignature(album, [], makeDeps());
    expect(result).toEqual({ verified: false, reason: 'unsigned' });
  });

  it('returns { unsigned } when only one of (sig, epoch, version) is present', async () => {
    const partial: RosterAlbumInput = {
      id: ALBUM_A_UUID,
      memberRosterSignature: VALID_SIGNATURE,
      memberRosterSignerEpochId: null,
      memberRosterVersion: 1,
    };
    const result = await verifyRosterSignature(partial, [], makeDeps());
    expect(result).toEqual({ verified: false, reason: 'unsigned' });
  });

  it('rejects malformed base64 signature', async () => {
    const album: RosterAlbumInput = {
      id: ALBUM_A_UUID,
      memberRosterSignature: 'not-base64-=&!',
      memberRosterSignerEpochId: 1,
      memberRosterVersion: 1,
    };
    const result = await verifyRosterSignature(album, [], makeDeps());
    expect(result).toEqual({ verified: false, reason: 'bad-base64' });
  });

  it('rejects wrong-length signature', async () => {
    const album: RosterAlbumInput = {
      id: ALBUM_A_UUID,
      memberRosterSignature: btoa(String.fromCharCode(...new Array(63).fill(0))),
      memberRosterSignerEpochId: 1,
      memberRosterVersion: 1,
    };
    const result = await verifyRosterSignature(album, [], makeDeps());
    expect(result).toEqual({ verified: false, reason: 'bad-length' });
  });

  it('rejects unknown role strings in the members list', async () => {
    const album: RosterAlbumInput = {
      id: ALBUM_A_UUID,
      memberRosterSignature: VALID_SIGNATURE,
      memberRosterSignerEpochId: 1,
      memberRosterVersion: 1,
    };
    const members: RosterMemberInput[] = [{ userId: MEMBER_X_UUID, role: 'admin' }];
    const result = await verifyRosterSignature(album, members, makeDeps());
    expect(result).toEqual({ verified: false, reason: 'unknown-role' });
  });

  it('returns { unknown-signer-epoch } when fetchEpochKey throws', async () => {
    const album: RosterAlbumInput = {
      id: ALBUM_A_UUID,
      memberRosterSignature: VALID_SIGNATURE,
      memberRosterSignerEpochId: 99,
      memberRosterVersion: 1,
    };
    const deps = makeDeps({
      fetchEpochKey: vi.fn(async () => {
        throw new Error('not found');
      }),
    });
    const result = await verifyRosterSignature(album, [], deps);
    expect(result).toEqual({ verified: false, reason: 'unknown-signer-epoch' });
  });

  it('rejects all-zero (invalid) signer pubkey', async () => {
    const album: RosterAlbumInput = {
      id: ALBUM_A_UUID,
      memberRosterSignature: VALID_SIGNATURE,
      memberRosterSignerEpochId: 1,
      memberRosterVersion: 1,
    };
    const deps = makeDeps({
      fetchEpochKey: vi.fn(async () => ({ signPublicKey: new Uint8Array(32) })),
    });
    const result = await verifyRosterSignature(album, [], deps);
    expect(result).toEqual({ verified: false, reason: 'empty-signer-pubkey' });
  });

  it('returns { signature-invalid } when worker verify returns false', async () => {
    const album: RosterAlbumInput = {
      id: ALBUM_A_UUID,
      memberRosterSignature: VALID_SIGNATURE,
      memberRosterSignerEpochId: 1,
      memberRosterVersion: 1,
    };
    const deps = makeDeps({
      verifySignature: vi.fn(async () => false),
    });
    const result = await verifyRosterSignature(
      album,
      [{ userId: MEMBER_X_UUID, role: 'editor' }],
      deps,
    );
    expect(result).toEqual({ verified: false, reason: 'signature-invalid' });
  });

  it('returns { verify-error } when worker verify throws', async () => {
    const album: RosterAlbumInput = {
      id: ALBUM_A_UUID,
      memberRosterSignature: VALID_SIGNATURE,
      memberRosterSignerEpochId: 1,
      memberRosterVersion: 1,
    };
    const deps = makeDeps({
      verifySignature: vi.fn(async () => {
        throw new Error('worker dead');
      }),
    });
    const result = await verifyRosterSignature(
      album,
      [{ userId: MEMBER_X_UUID, role: 'owner' }],
      deps,
    );
    expect(result).toEqual({ verified: false, reason: 'verify-error' });
  });

  it('returns verified=true and surfaces version + signer epoch on success', async () => {
    const album: RosterAlbumInput = {
      id: ALBUM_A_UUID,
      memberRosterSignature: VALID_SIGNATURE,
      memberRosterSignerEpochId: 7,
      memberRosterVersion: 42,
    };
    const result = await verifyRosterSignature(
      album,
      [{ userId: MEMBER_X_UUID, role: 'editor' }],
      makeDeps(),
    );
    expect(result).toEqual({
      verified: true,
      rosterVersion: 42,
      signerEpochId: 7,
    });
  });

  it('passes the (album, signer_epoch, version, sorted members) transcript to verifySignature', async () => {
    const verifySpy = vi.fn<
      (
        transcriptBytes: Uint8Array,
        signature: Uint8Array,
        pubkey: Uint8Array,
      ) => Promise<boolean>
    >(async () => true);
    const album: RosterAlbumInput = {
      id: ALBUM_A_UUID,
      memberRosterSignature: VALID_SIGNATURE,
      memberRosterSignerEpochId: 9,
      memberRosterVersion: 3,
    };
    await verifyRosterSignature(
      album,
      [{ userId: MEMBER_X_UUID, role: 'owner' }],
      makeDeps({ verifySignature: verifySpy }),
    );
    expect(verifySpy).toHaveBeenCalledTimes(1);
    const call = verifySpy.mock.calls[0];
    expect(call).toBeDefined();
    const [transcript, sig, pubkey] = call!;
    // Transcript must be at least the 55-byte header + 17-byte member entry = 72 bytes.
    expect(transcript.length).toBe(72);
    expect(sig.length).toBe(64);
    expect(pubkey.length).toBe(32);
  });

  it('does not call verifySignature when an earlier check fails', async () => {
    const verifySpy = vi.fn(async () => true);
    const album: RosterAlbumInput = {
      id: ALBUM_A_UUID,
      memberRosterSignature: 'not-base64-=&!',
      memberRosterSignerEpochId: 1,
      memberRosterVersion: 1,
    };
    await verifyRosterSignature(album, [], makeDeps({ verifySignature: verifySpy }));
    expect(verifySpy).not.toHaveBeenCalled();
  });
});

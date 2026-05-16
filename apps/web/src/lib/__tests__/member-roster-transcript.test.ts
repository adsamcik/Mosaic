/**
 * Member roster transcript byte-parity tests (batch C2c — C2).
 *
 * Locks the TS producer against the canonical Rust producer
 * `mosaic_domain::canonical_member_roster_transcript_bytes` using
 * identical fixture values. If either side ever drifts, cross-client
 * roster signature verification breaks immediately. The matching Rust
 * test lives at
 * `crates/mosaic-domain/tests/member_roster_transcript.rs`.
 */

import { describe, expect, it } from 'vitest';

import {
  MEMBER_ROLE_EDITOR_BYTE,
  MEMBER_ROLE_OWNER_BYTE,
  MEMBER_ROLE_VIEWER_BYTE,
  MEMBER_ROSTER_ENTRY_LENGTH,
  MEMBER_ROSTER_HEADER_LENGTH,
  buildMemberRosterTranscriptBytes,
  roleByteToString,
  roleStringToByte,
} from '../member-roster-transcript';

// Same fixture as the Rust test: ALBUM_A=0xa0..0xaf, MEMBER_X=0x10..0x1f,
// MEMBER_Y=0x20..0x2f, MEMBER_Z=0x30..0x3f.
const ALBUM_A_UUID = 'a0a1a2a3-a4a5-a6a7-a8a9-aaabacadaeaf';
const MEMBER_X_UUID = '10111213-1415-1617-1819-1a1b1c1d1e1f';
const MEMBER_Y_UUID = '20212223-2425-2627-2829-2a2b2c2d2e2f';
const MEMBER_Z_UUID = '30313233-3435-3637-3839-3a3b3c3d3e3f';

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

describe('member-roster transcript byte parity with Rust canonical producer', () => {
  it('empty roster has the 55-byte header layout', () => {
    const bytes = buildMemberRosterTranscriptBytes({
      albumId: ALBUM_A_UUID,
      epochId: 1,
      rosterVersion: 0,
      members: [],
    });
    expect(bytes.length).toBe(MEMBER_ROSTER_HEADER_LENGTH);
    expect(bytes.length).toBe(55);

    // 22-byte UTF-8 context prefix
    const prefix = new TextDecoder().decode(bytes.slice(0, 22));
    expect(prefix).toBe('Mosaic_MemberRoster_v1');

    expect(bytes[22]).toBe(0x01); // transcript version
    expect(Array.from(bytes.slice(23, 39))).toEqual([
      0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae,
      0xaf,
    ]);
    expect(Array.from(bytes.slice(39, 43))).toEqual([0x01, 0, 0, 0]); // epoch_id u32 LE = 1
    // roster_version i64 LE = 0
    expect(Array.from(bytes.slice(43, 51))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // member_count u32 LE = 0
    expect(Array.from(bytes.slice(51, 55))).toEqual([0, 0, 0, 0]);
  });

  it('three-member roster has the 106-byte layout', () => {
    const bytes = buildMemberRosterTranscriptBytes({
      albumId: ALBUM_A_UUID,
      epochId: 7,
      rosterVersion: 42,
      members: [
        { userId: MEMBER_X_UUID, roleByte: MEMBER_ROLE_OWNER_BYTE },
        { userId: MEMBER_Y_UUID, roleByte: MEMBER_ROLE_EDITOR_BYTE },
        { userId: MEMBER_Z_UUID, roleByte: MEMBER_ROLE_VIEWER_BYTE },
      ],
    });
    expect(bytes.length).toBe(55 + 3 * MEMBER_ROSTER_ENTRY_LENGTH);
    expect(bytes.length).toBe(106);

    // epoch_id = 7
    expect(Array.from(bytes.slice(39, 43))).toEqual([0x07, 0, 0, 0]);
    // roster_version = 42
    expect(Array.from(bytes.slice(43, 51))).toEqual([0x2a, 0, 0, 0, 0, 0, 0, 0]);
    // member_count = 3
    expect(Array.from(bytes.slice(51, 55))).toEqual([0x03, 0, 0, 0]);

    // Member X (id starts at offset 55, role at 71)
    expect(bytes[71]).toBe(MEMBER_ROLE_OWNER_BYTE);
    expect(bytes[71 + 17]).toBe(MEMBER_ROLE_EDITOR_BYTE);
    expect(bytes[71 + 17 + 17]).toBe(MEMBER_ROLE_VIEWER_BYTE);
  });

  it('matches the Rust producer hex byte-for-byte (3-member fixture)', () => {
    const bytes = buildMemberRosterTranscriptBytes({
      albumId: ALBUM_A_UUID,
      epochId: 7,
      rosterVersion: 42,
      members: [
        { userId: MEMBER_X_UUID, roleByte: MEMBER_ROLE_OWNER_BYTE },
        { userId: MEMBER_Y_UUID, roleByte: MEMBER_ROLE_EDITOR_BYTE },
        { userId: MEMBER_Z_UUID, roleByte: MEMBER_ROLE_VIEWER_BYTE },
      ],
    });
    const expected =
      '4d6f736169635f4d656d62657252' +
      '6f737465725f7631' + // "Mosaic_MemberRoster_v1"
      '01' + // version
      'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf' + // album
      '07000000' + // epoch_id LE
      '2a00000000000000' + // roster_version LE
      '03000000' + // member_count LE
      '101112131415161718191a1b1c1d1e1f' +
      '01' + // X / owner
      '202122232425262728292a2b2c2d2e2f' +
      '02' + // Y / editor
      '303132333435363738393a3b3c3d3e3f' +
      '03'; // Z / viewer
    expect(toHex(bytes)).toBe(expected);
  });

  it('sorts members ascending regardless of insertion order', () => {
    const a = buildMemberRosterTranscriptBytes({
      albumId: ALBUM_A_UUID,
      epochId: 1,
      rosterVersion: 0,
      members: [
        { userId: MEMBER_X_UUID, roleByte: MEMBER_ROLE_OWNER_BYTE },
        { userId: MEMBER_Y_UUID, roleByte: MEMBER_ROLE_EDITOR_BYTE },
        { userId: MEMBER_Z_UUID, roleByte: MEMBER_ROLE_VIEWER_BYTE },
      ],
    });
    const b = buildMemberRosterTranscriptBytes({
      albumId: ALBUM_A_UUID,
      epochId: 1,
      rosterVersion: 0,
      members: [
        { userId: MEMBER_Z_UUID, roleByte: MEMBER_ROLE_VIEWER_BYTE },
        { userId: MEMBER_X_UUID, roleByte: MEMBER_ROLE_OWNER_BYTE },
        { userId: MEMBER_Y_UUID, roleByte: MEMBER_ROLE_EDITOR_BYTE },
      ],
    });
    expect(toHex(a)).toBe(toHex(b));
  });

  it('rejects duplicate member_id', () => {
    expect(() =>
      buildMemberRosterTranscriptBytes({
        albumId: ALBUM_A_UUID,
        epochId: 1,
        rosterVersion: 0,
        members: [
          { userId: MEMBER_X_UUID, roleByte: MEMBER_ROLE_OWNER_BYTE },
          { userId: MEMBER_X_UUID, roleByte: MEMBER_ROLE_EDITOR_BYTE },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it('rejects malformed album_id', () => {
    expect(() =>
      buildMemberRosterTranscriptBytes({
        albumId: 'not-a-uuid',
        epochId: 1,
        rosterVersion: 0,
        members: [],
      }),
    ).toThrow(/UUID/);
  });

  it('rejects out-of-range epoch_id', () => {
    expect(() =>
      buildMemberRosterTranscriptBytes({
        albumId: ALBUM_A_UUID,
        epochId: -1,
        rosterVersion: 0,
        members: [],
      }),
    ).toThrow(/u32/);
  });

  it('rejects non-integer roster_version', () => {
    expect(() =>
      buildMemberRosterTranscriptBytes({
        albumId: ALBUM_A_UUID,
        epochId: 1,
        rosterVersion: 1.5,
        members: [],
      }),
    ).toThrow(/integer/);
  });

  it('differs on album_id / epoch_id / roster_version / role / member change', () => {
    const base = buildMemberRosterTranscriptBytes({
      albumId: ALBUM_A_UUID,
      epochId: 5,
      rosterVersion: 1,
      members: [{ userId: MEMBER_X_UUID, roleByte: MEMBER_ROLE_EDITOR_BYTE }],
    });
    const a2 = buildMemberRosterTranscriptBytes({
      albumId: '00112233-4455-6677-8899-aabbccddeeff',
      epochId: 5,
      rosterVersion: 1,
      members: [{ userId: MEMBER_X_UUID, roleByte: MEMBER_ROLE_EDITOR_BYTE }],
    });
    const a3 = buildMemberRosterTranscriptBytes({
      albumId: ALBUM_A_UUID,
      epochId: 6,
      rosterVersion: 1,
      members: [{ userId: MEMBER_X_UUID, roleByte: MEMBER_ROLE_EDITOR_BYTE }],
    });
    const a4 = buildMemberRosterTranscriptBytes({
      albumId: ALBUM_A_UUID,
      epochId: 5,
      rosterVersion: 2,
      members: [{ userId: MEMBER_X_UUID, roleByte: MEMBER_ROLE_EDITOR_BYTE }],
    });
    const a5 = buildMemberRosterTranscriptBytes({
      albumId: ALBUM_A_UUID,
      epochId: 5,
      rosterVersion: 1,
      members: [{ userId: MEMBER_X_UUID, roleByte: MEMBER_ROLE_OWNER_BYTE }],
    });
    const a6 = buildMemberRosterTranscriptBytes({
      albumId: ALBUM_A_UUID,
      epochId: 5,
      rosterVersion: 1,
      members: [
        { userId: MEMBER_X_UUID, roleByte: MEMBER_ROLE_EDITOR_BYTE },
        { userId: MEMBER_Y_UUID, roleByte: MEMBER_ROLE_VIEWER_BYTE },
      ],
    });
    expect(toHex(base)).not.toBe(toHex(a2));
    expect(toHex(base)).not.toBe(toHex(a3));
    expect(toHex(base)).not.toBe(toHex(a4));
    expect(toHex(base)).not.toBe(toHex(a5));
    expect(toHex(base)).not.toBe(toHex(a6));
  });
});

describe('role string ↔ byte mapping', () => {
  it('maps known role strings to wire bytes', () => {
    expect(roleStringToByte('owner')).toBe(MEMBER_ROLE_OWNER_BYTE);
    expect(roleStringToByte('editor')).toBe(MEMBER_ROLE_EDITOR_BYTE);
    expect(roleStringToByte('viewer')).toBe(MEMBER_ROLE_VIEWER_BYTE);
  });

  it('returns null for unknown role strings', () => {
    expect(roleStringToByte('admin')).toBeNull();
    expect(roleStringToByte('')).toBeNull();
    expect(roleStringToByte('OWNER')).toBeNull();
  });

  it('round-trips role bytes back to strings', () => {
    expect(roleByteToString(1)).toBe('owner');
    expect(roleByteToString(2)).toBe('editor');
    expect(roleByteToString(3)).toBe('viewer');
    expect(roleByteToString(0)).toBeNull();
    expect(roleByteToString(4)).toBeNull();
    expect(roleByteToString(0xff)).toBeNull();
  });

  it('byte constants are wire-pinned to (1, 2, 3)', () => {
    expect(MEMBER_ROLE_OWNER_BYTE).toBe(1);
    expect(MEMBER_ROLE_EDITOR_BYTE).toBe(2);
    expect(MEMBER_ROLE_VIEWER_BYTE).toBe(3);
  });
});

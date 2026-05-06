import { beforeAll, describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { createDecryptCache, type DecryptContext } from '../decrypt-cache';

beforeAll(async () => { await sodium.ready; });

function ctx(epochId: string, fill: number = 0xab): DecryptContext {
  return { epochId, epochKey: new Uint8Array(32).fill(fill) };
}

describe('DecryptCache', () => {
  it('roundtrips put → get', () => {
    const c = createDecryptCache(4);
    const e = ctx('e1');
    c.put(e);
    expect(c.get('e1')).toBe(e);
  });

  it('returns null on miss', () => {
    const c = createDecryptCache(4);
    expect(c.get('nope')).toBeNull();
  });

  it('evicts least-recently-used when over bound', () => {
    const c = createDecryptCache(2);
    const a = ctx('a', 1);
    const b = ctx('b', 2);
    const d = ctx('d', 3);
    c.put(a); c.put(b);
    c.get('a');           // bump a → MRU; b is LRU now
    c.put(d);             // should evict b
    expect(c.get('a')).not.toBeNull();
    expect(c.get('b')).toBeNull();
    expect(c.get('d')).not.toBeNull();
    expect(c._size()).toBe(2);
  });

  it('zeroes the epoch key on LRU eviction', () => {
    const c = createDecryptCache(1);
    const a = ctx('a', 0xff);
    const b = ctx('b', 0x77);
    c.put(a);
    // Snapshot the buffer reference so we can inspect after eviction.
    const aKey = a.epochKey;
    expect(aKey.some((x) => x !== 0)).toBe(true);
    c.put(b); // evicts a
    expect(Array.from(aKey)).toEqual(Array.from(new Uint8Array(32)));
  });

  it('clear() zeroes every key and empties the map', () => {
    const c = createDecryptCache(4);
    const a = ctx('a', 0xa1);
    const b = ctx('b', 0xb2);
    c.put(a); c.put(b);
    const aKey = a.epochKey;
    const bKey = b.epochKey;
    c.clear();
    expect(c._size()).toBe(0);
    expect(c.get('a')).toBeNull();
    expect(c.get('b')).toBeNull();
    expect(Array.from(aKey).every((x) => x === 0)).toBe(true);
    expect(Array.from(bKey).every((x) => x === 0)).toBe(true);
  });

  it('zeroes prior key when a different buffer replaces an existing epoch entry', () => {
    const c = createDecryptCache(4);
    const first = ctx('e', 0x11);
    c.put(first);
    const firstKey = first.epochKey;
    c.put(ctx('e', 0x22));
    expect(Array.from(firstKey).every((x) => x === 0)).toBe(true);
  });

  it('rejects invalid maxEntries', () => {
    expect(() => createDecryptCache(0)).toThrow();
    expect(() => createDecryptCache(-1)).toThrow();
    expect(() => createDecryptCache(1.5)).toThrow();
  });
});

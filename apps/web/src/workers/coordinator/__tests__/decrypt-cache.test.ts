import { describe, expect, it } from 'vitest';
import { createDecryptCache, type DecryptContext } from '../decrypt-cache';
import type { EpochHandleId } from '../../types';

function ctx(epochId: string, handleId: string = `epch_${epochId}`): DecryptContext {
  return { epochId, epochKey: { kind: 'epoch-handle', handleId: handleId as EpochHandleId } };
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
    const a = ctx('a', 'epch_a');
    const b = ctx('b', 'epch_b');
    const d = ctx('d', 'epch_d');
    c.put(a); c.put(b);
    c.get('a');           // bump a → MRU; b is LRU now
    c.put(d);             // should evict b
    expect(c.get('a')).not.toBeNull();
    expect(c.get('b')).toBeNull();
    expect(c.get('d')).not.toBeNull();
    expect(c._size()).toBe(2);
  });

  it('evicts opaque handle entries without exposing raw key bytes', () => {
    const c = createDecryptCache(1);
    const a = ctx('a', 'epch_a');
    const b = ctx('b', 'epch_b');
    c.put(a);
    c.put(b); // evicts a
    expect(c.get('a')).toBeNull();
    expect(c.get('b')).toBe(b);
    expect(a.epochKey).toEqual({ kind: 'epoch-handle', handleId: 'epch_a' });
  });

  it('clear() empties the map', () => {
    const c = createDecryptCache(4);
    const a = ctx('a', 'epch_a');
    const b = ctx('b', 'epch_b');
    c.put(a); c.put(b);
    c.clear();
    expect(c._size()).toBe(0);
    expect(c.get('a')).toBeNull();
    expect(c.get('b')).toBeNull();
  });

  it('replaces an existing epoch entry', () => {
    const c = createDecryptCache(4);
    const first = ctx('e', 'epch_first');
    c.put(first);
    const second = ctx('e', 'epch_second');
    c.put(second);
    expect(c.get('e')).toBe(second);
  });

  it('rejects invalid maxEntries', () => {
    expect(() => createDecryptCache(0)).toThrow();
    expect(() => createDecryptCache(-1)).toThrow();
    expect(() => createDecryptCache(1.5)).toThrow();
  });
});

/**
 * Regression test for v1.0.1 isolated-v3-10 (W-A6-6): anonymous share-link
 * downloads failed with `DataCloneError` because the visitor
 * `SourceStrategy` was nested inside the `StartJobInput` argument to
 * `coordinator.worker.startJob`. Comlink only inspects the proxy marker on
 * TOP-LEVEL arguments — nested proxied objects fall through to structured
 * clone, which then fails on the strategy's function members
 * (`fetchShard`, `fetchShards`, `resolveKey`, `decryptResolvedShard`).
 *
 * The fix hoists the strategy to a separate, top-level argument and wraps it
 * in `Comlink.proxy()` at the call sites that cross a real Worker boundary
 * (`coordinator-download-runner.ts`, `useVisitorAlbumDownload.ts`).
 *
 * ZK-safe: the strategies in this test never carry real key material; they
 * only verify the wire shape.
 */
import { describe, expect, it } from 'vitest';
import * as Comlink from 'comlink';

import type { SourceStrategy } from '../../workers/coordinator/source-strategy';

function makeFakeStrategy(): SourceStrategy {
  return {
    kind: 'share-link',
    getScopeKey: () => 'visitor:0000000000000000000000000000000000',
    fetchShard: async () => new Uint8Array(),
    fetchShards: async () => [],
    resolveKey: async () => ({
      kind: 'link-tier-handle',
      handleId: 'fake-handle-id' as never,
    }),
  };
}

describe('visitor SourceStrategy postMessage boundary', () => {
  it('structured clone of an object that nests a SourceStrategy fails (regression baseline)', () => {
    const strategy = makeFakeStrategy();
    const startInput = {
      albumId: 'alb',
      photos: [],
      source: strategy,
    };
    expect(() => structuredClone(startInput)).toThrow(/DataCloneError|could not be cloned/i);
  });

  it('Comlink.proxy on the nested field does NOT make the input cloneable', () => {
    // This is the exact wire shape that the old `coordinator-download-runner`
    // produced: `Comlink.proxy(strategy)` nested in a wrapper object. The
    // proxy marker only lives on the nested value, so the outer structured
    // clone still tries to walk the function members and throws.
    const proxied = Comlink.proxy(makeFakeStrategy());
    const wrapped = { albumId: 'alb', photos: [], source: proxied };
    expect(() => structuredClone(wrapped)).toThrow(/DataCloneError|could not be cloned/i);
  });

  it('hoisting the strategy to a top-level argument removes the clone barrier', () => {
    // Post-fix: the strategy is passed as a SEPARATE argument and the
    // sibling input object contains only plain data. The plain input must
    // be structured-cloneable on its own; Comlink handles the proxy on
    // the strategy independently.
    const inputWithoutSource = {
      albumId: 'alb',
      photos: [{ photoId: 'p', filename: 'p.jpg', shards: [] }],
      outputMode: { kind: 'zip' as const, fileName: 'a.zip' },
    };
    expect(() => structuredClone(inputWithoutSource)).not.toThrow();
  });

  it('Comlink.proxy applied to the strategy as a top-level value preserves the marker', () => {
    const strategy = makeFakeStrategy();
    const proxied = Comlink.proxy(strategy);
    // The marker is what Comlink.toWireValue checks at the top level to
    // emit a MessagePort instead of attempting a structured clone.
    expect(proxied).toBe(strategy);
    expect((proxied as unknown as Record<symbol, unknown>)[Comlink.proxyMarker]).toBe(true);
  });
});

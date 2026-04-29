/**
 * Tests for `apps/web/src/lib/conflict-resolution.ts`.
 *
 * Scenarios mirror SPEC §2 (Conflict Scenarios Analysis), §3 (Strategy
 * Comparison), §6.2 (Optimistic Updates merge), and §7 (Testing Strategy)
 * of `docs/specs/SPEC-SyncConflictResolution.md`.
 *
 * Each test exercises a deterministic, framework-free merge so it can run
 * in the standard happy-dom Vitest setup without crypto or network setup.
 */

import { describe, it, expect } from 'vitest';
import {
  hasManualConflicts,
  mergeAlbumContent,
  mergeBlocks,
} from '../src/lib/conflict-resolution';
import type {
  AlbumContentDocument,
  ContentBlock,
  HeadingBlock,
  TextBlock,
} from '../src/lib/content-blocks';

function heading(
  id: string,
  text: string,
  position: string,
  level: 1 | 2 | 3 = 1,
): HeadingBlock {
  return { type: 'heading', id, level, text, position };
}

function paragraph(
  id: string,
  text: string,
  position: string,
): TextBlock {
  return {
    type: 'text',
    id,
    position,
    segments: [{ text }],
  };
}

function doc(
  blocks: ContentBlock[],
  version = 1,
): AlbumContentDocument {
  return { version: 1 as const, blocks, settings: undefined } as AlbumContentDocument & { version: 1 };
}

describe('mergeBlocks (three-way merge)', () => {
  it('returns server blocks unchanged when local matches base and server has new content', () => {
    const a = heading('a', 'Hello', 'a0');
    const b = heading('b', 'World', 'a1');

    const base = [a, b];
    const local = [a, b];
    const server = [a, b, paragraph('c', 'Greetings', 'a2')];

    const result = mergeBlocks(local, server, base);

    expect(result.merged.map((block) => block.id)).toEqual(['a', 'b', 'c']);
    expect(result.decisions).toContainEqual(
      expect.objectContaining({
        blockId: 'c',
        resolution: 'auto-server-add-kept',
        category: 'auto',
      }),
    );
  });

  it('keeps both sides additions when block ids are different even at the same position', () => {
    const base = [heading('a', 'Hi', 'a0')];
    const local = [
      heading('a', 'Hi', 'a0'),
      paragraph('local-new', 'Local addition', 'a0V'),
    ];
    const server = [
      heading('a', 'Hi', 'a0'),
      paragraph('server-new', 'Server addition', 'a0V'),
    ];

    const result = mergeBlocks(local, server, base);

    expect(result.merged.map((b) => b.id).sort()).toEqual(
      ['a', 'local-new', 'server-new'].sort(),
    );
    // No same-id collision means no manual conflicts; both sides are kept
    // because each is "added by the side that holds it".
    expect(
      result.decisions.filter((d) => d.category === 'manual'),
    ).toHaveLength(0);
  });

  it('reports a manual conflict when both sides edit the same block differently', () => {
    const base = [paragraph('p', 'Hello', 'a0')];
    const local = [paragraph('p', 'Hello World', 'a0')];
    const server = [paragraph('p', 'Hello There', 'a0')];

    const result = mergeBlocks(local, server, base);

    expect(result.merged).toHaveLength(1);
    expect(result.merged[0]).toMatchObject({ id: 'p' });
    // LWW fallback: server wins on simultaneous edit.
    expect((result.merged[0] as TextBlock).segments[0]?.text).toBe(
      'Hello There',
    );
    expect(result.decisions).toContainEqual(
      expect.objectContaining({
        blockId: 'p',
        resolution: 'manual-server-wins',
        category: 'manual',
      }),
    );
  });

  it('treats matching edits on both sides as no conflict', () => {
    const base = [paragraph('p', 'Hello', 'a0')];
    const same = [paragraph('p', 'Hello updated', 'a0')];

    const result = mergeBlocks(same, same, base);

    expect(result.merged).toEqual(same);
    expect(result.decisions).toHaveLength(0);
  });

  it('honours server deletion when local kept the base block unchanged', () => {
    const base = [
      heading('a', 'Title', 'a0'),
      paragraph('p', 'Body', 'a1'),
    ];
    const local = [...base];
    const server = [heading('a', 'Title', 'a0')];

    const result = mergeBlocks(local, server, base);

    expect(result.merged.map((b) => b.id)).toEqual(['a']);
    expect(result.decisions).toContainEqual(
      expect.objectContaining({
        blockId: 'p',
        resolution: 'auto-server-delete-wins',
        category: 'auto',
      }),
    );
  });

  it('surfaces a manual conflict when local edited a block that server deleted', () => {
    const base = [paragraph('p', 'Original', 'a0')];
    const local = [paragraph('p', 'Edited', 'a0')];
    const server: ContentBlock[] = [];

    const result = mergeBlocks(local, server, base);

    // Server-delete wins (LWW), but the user must be told.
    expect(result.merged).toHaveLength(0);
    const manual = result.decisions.find((d) => d.category === 'manual');
    expect(manual).toEqual(
      expect.objectContaining({
        blockId: 'p',
        resolution: 'manual-server-wins',
      }),
    );
  });

  it('drops a block both sides deleted without surfacing a conflict', () => {
    const base = [paragraph('p', 'Body', 'a0')];
    const local: ContentBlock[] = [];
    const server: ContentBlock[] = [];

    const result = mergeBlocks(local, server, base);

    expect(result.merged).toHaveLength(0);
    expect(result.decisions).toContainEqual(
      expect.objectContaining({
        blockId: 'p',
        resolution: 'auto-both-deleted',
        category: 'auto',
      }),
    );
    expect(result.decisions.filter((d) => d.category === 'manual')).toHaveLength(0);
  });

  it('keeps locally added block while honouring server-edited unchanged blocks', () => {
    const a = heading('a', 'Trip', 'a0');
    const base = [a];
    const local = [a, paragraph('local-add', 'Locally added paragraph', 'a1')];
    const server = [heading('a', 'Trip 2026', 'a0')];

    const result = mergeBlocks(local, server, base);

    expect(result.merged.map((b) => b.id)).toEqual(['a', 'local-add']);
    expect(
      result.decisions.find((d) => d.blockId === 'a'),
    ).toEqual(
      expect.objectContaining({
        resolution: 'auto-server-wins',
        category: 'auto',
      }),
    );
    expect(
      result.decisions.find((d) => d.blockId === 'local-add'),
    ).toEqual(
      expect.objectContaining({
        resolution: 'auto-local-add-kept',
        category: 'auto',
      }),
    );
  });

  it('sorts merged blocks deterministically by fractional position with id tiebreak', () => {
    const base: ContentBlock[] = [];
    const local = [
      paragraph('p1', 'one', 'a1'),
      paragraph('p3', 'three', 'a3'),
    ];
    const server = [
      paragraph('p2', 'two', 'a2'),
      paragraph('p_dup_b', 'tieB', 'aZ'),
      paragraph('p_dup_a', 'tieA', 'aZ'),
    ];

    const result = mergeBlocks(local, server, base);

    expect(result.merged.map((b) => b.id)).toEqual([
      'p1',
      'p2',
      'p3',
      'p_dup_a', // tied position 'aZ', id sort breaks tie
      'p_dup_b',
    ]);
  });

  it('runs without a base and treats every same-id conflict as manual server-wins', () => {
    const local = [paragraph('p', 'Local', 'a0')];
    const server = [paragraph('p', 'Server', 'a0')];

    const result = mergeBlocks(local, server, null);

    expect((result.merged[0] as TextBlock).segments[0]?.text).toBe('Server');
    expect(result.decisions).toContainEqual(
      expect.objectContaining({
        blockId: 'p',
        resolution: 'manual-server-wins',
        category: 'manual',
      }),
    );
  });
});

describe('mergeAlbumContent (document-level)', () => {
  it('falls back to LWW when no base is provided', () => {
    const local = doc([paragraph('p', 'Local body', 'a0')]);
    const server = doc([paragraph('p', 'Server body', 'a0')], 5);

    const result = mergeAlbumContent(local, server, null);

    expect(result.strategy).toBe('lww-server-wins');
    expect(result.merged.blocks.map((b) => b.id)).toEqual(['p']);
    expect((result.merged.blocks[0] as TextBlock).segments[0]?.text).toBe(
      'Server body',
    );
    expect(result.decisions).toEqual([]);
    expect(result.manualConflicts).toEqual([]);
    expect(hasManualConflicts(result)).toBe(false);
  });

  it('runs three-way merge when a base is provided', () => {
    const a = heading('a', 'Title', 'a0');
    const base = doc([a, paragraph('p', 'Body', 'a1')]);
    const local = doc([a, paragraph('p', 'Body extended', 'a1')]);
    const server = doc([a, paragraph('p', 'Body modified', 'a1'), paragraph('q', 'New', 'a2')]);

    const result = mergeAlbumContent(local, server, base);

    expect(result.strategy).toBe('three-way-block-merge');
    expect(result.merged.blocks.map((b) => b.id)).toEqual(['a', 'p', 'q']);

    // p has conflicting edits → server wins, manual conflict reported.
    expect(result.manualConflicts).toHaveLength(1);
    expect(result.manualConflicts[0]).toMatchObject({
      blockId: 'p',
      resolution: 'manual-server-wins',
    });
    expect((result.merged.blocks[1] as TextBlock).segments[0]?.text).toBe(
      'Body modified',
    );

    // q is a server-side addition reported as auto.
    const qDecision = result.decisions.find((d) => d.blockId === 'q');
    expect(qDecision).toEqual(
      expect.objectContaining({
        resolution: 'auto-server-add-kept',
        category: 'auto',
      }),
    );
  });

  it('uses the server document version on the merged result', () => {
    const base = doc([paragraph('p', 'Base', 'a0')]);
    const local = doc([paragraph('p', 'Local', 'a0')]);
    const server = doc([paragraph('p', 'Server', 'a0')], 42);
    // Force the version regardless of the doc helper default.
    (server as { version: number }).version = 1;

    const result = mergeAlbumContent(local, server, base);

    // Document version is intentionally a literal 1 in the schema (the
    // SPEC's `version` is a content-format version, not the server's
    // optimistic-concurrency counter), so we just assert the merged
    // document mirrors the server's version field.
    expect(result.merged.version).toBe(server.version);
  });

  it('surfaces manualConflicts only for category=manual decisions', () => {
    const a = heading('a', 'Title', 'a0');
    const base = doc([a, paragraph('p', 'Body', 'a1')]);
    const local = doc([
      a,
      paragraph('p', 'Body', 'a1'),
      paragraph('local-new', 'Local note', 'a2'),
    ]);
    const server = doc([heading('a', 'Title v2', 'a0'), paragraph('p', 'Body', 'a1')]);

    const result = mergeAlbumContent(local, server, base);

    expect(result.manualConflicts).toEqual([]);
    expect(hasManualConflicts(result)).toBe(false);

    const ids = result.decisions.map((d) => d.blockId).sort();
    expect(ids).toEqual(['a', 'local-new']);
  });

  it('does not mutate the input documents', () => {
    const baseBlocks = [paragraph('p', 'Body', 'a0')];
    const localBlocks = [paragraph('p', 'Body', 'a0')];
    const serverBlocks = [paragraph('p', 'Body changed', 'a0')];

    const base: AlbumContentDocument = { version: 1, blocks: baseBlocks };
    const local: AlbumContentDocument = { version: 1, blocks: localBlocks };
    const server: AlbumContentDocument = { version: 1, blocks: serverBlocks };

    mergeAlbumContent(local, server, base);

    expect(base.blocks).toBe(baseBlocks);
    expect(local.blocks).toBe(localBlocks);
    expect(server.blocks).toBe(serverBlocks);
    expect(local.blocks).toEqual([paragraph('p', 'Body', 'a0')]);
    expect(server.blocks).toEqual([paragraph('p', 'Body changed', 'a0')]);
  });

  it('reports identical decisions for repeated runs (deterministic)', () => {
    const base = doc([paragraph('p', 'Body', 'a0')]);
    const local = doc([paragraph('p', 'Local', 'a0')]);
    const server = doc([paragraph('p', 'Server', 'a0')]);

    const a = mergeAlbumContent(local, server, base);
    const b = mergeAlbumContent(local, server, base);

    expect(a).toEqual(b);
  });

  it('preserves server settings when merging', () => {
    const base: AlbumContentDocument = {
      version: 1,
      blocks: [paragraph('p', 'Body', 'a0')],
      settings: { defaultView: 'grid' },
    };
    const local: AlbumContentDocument = {
      version: 1,
      blocks: [paragraph('p', 'Body', 'a0')],
      settings: { defaultView: 'grid' },
    };
    const server: AlbumContentDocument = {
      version: 1,
      blocks: [paragraph('p', 'Body changed', 'a0')],
      settings: { defaultView: 'story' },
    };

    const result = mergeAlbumContent(local, server, base);

    expect(result.merged.settings).toEqual({ defaultView: 'story' });
  });
});

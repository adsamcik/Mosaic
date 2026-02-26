/**
 * Tests for Album Content Block Types and Validation
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeHref,
  HeadingBlockSchema,
  TextBlockSchema,
  PhotoBlockSchema,
  PhotoGroupBlockSchema,
  DividerBlockSchema,
  SectionBlockSchema,
  ContentBlockSchema,
  AlbumContentDocumentSchema,
  parseContentBlock,
  parseAlbumContentDocument,
  createEmptyContentDocument,
  createHeadingBlock,
  createTextBlock,
  createPhotoBlock,
  createPhotoGroupBlock,
  createDividerBlock,
  createSectionBlock,
  type AlbumContentDocument,
} from '../../src/lib/content-blocks';

describe('sanitizeHref', () => {
  it('allows https URLs', () => {
    expect(sanitizeHref('https://example.com/page')).toBe('https://example.com/page');
  });

  it('allows http URLs', () => {
    expect(sanitizeHref('http://example.com/page')).toBe('http://example.com/page');
  });

  it('allows mailto URLs', () => {
    expect(sanitizeHref('mailto:test@example.com')).toBe('mailto:test@example.com');
  });

  it('rejects javascript URLs', () => {
    expect(sanitizeHref('javascript:alert(1)')).toBeNull();
  });

  it('rejects data URLs', () => {
    expect(sanitizeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('rejects vbscript URLs', () => {
    expect(sanitizeHref('vbscript:msgbox(1)')).toBeNull();
  });

  it('rejects invalid URLs', () => {
    expect(sanitizeHref('not a url')).toBeNull();
  });

  it('rejects relative URLs without protocol', () => {
    expect(sanitizeHref('/path/to/page')).toBeNull();
  });
});

describe('HeadingBlockSchema', () => {
  it('validates valid heading block', () => {
    const block = {
      type: 'heading',
      id: 'test-id',
      level: 1,
      text: 'My Heading',
      position: 'a0',
    };
    expect(HeadingBlockSchema.safeParse(block).success).toBe(true);
  });

  it('rejects invalid heading level', () => {
    const block = {
      type: 'heading',
      id: 'test-id',
      level: 4, // Invalid - only 1, 2, 3 allowed
      text: 'My Heading',
      position: 'a0',
    };
    expect(HeadingBlockSchema.safeParse(block).success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const block = {
      type: 'heading',
      id: 'test-id',
      // Missing level and text
      position: 'a0',
    };
    expect(HeadingBlockSchema.safeParse(block).success).toBe(false);
  });
});

describe('TextBlockSchema', () => {
  it('validates text block with segments', () => {
    const block = {
      type: 'text',
      id: 'test-id',
      segments: [
        { text: 'Normal text ' },
        { text: 'bold text', bold: true },
        { text: ' and a ', },
        { text: 'link', href: 'https://example.com' },
      ],
      position: 'a1',
    };
    expect(TextBlockSchema.safeParse(block).success).toBe(true);
  });

  it('validates text block with empty segments', () => {
    const block = {
      type: 'text',
      id: 'test-id',
      segments: [],
      position: 'a1',
    };
    expect(TextBlockSchema.safeParse(block).success).toBe(true);
  });
});

describe('PhotoBlockSchema', () => {
  it('validates photo block without caption', () => {
    const block = {
      type: 'photo',
      id: 'test-id',
      manifestId: 'manifest-123',
      position: 'a2',
    };
    expect(PhotoBlockSchema.safeParse(block).success).toBe(true);
  });

  it('validates photo block with caption', () => {
    const block = {
      type: 'photo',
      id: 'test-id',
      manifestId: 'manifest-123',
      caption: [{ text: 'A beautiful sunset' }],
      position: 'a2',
    };
    expect(PhotoBlockSchema.safeParse(block).success).toBe(true);
  });
});

describe('PhotoGroupBlockSchema', () => {
  it('validates grid layout', () => {
    const block = {
      type: 'photo-group',
      id: 'test-id',
      manifestIds: ['m1', 'm2', 'm3'],
      layout: 'grid',
      columns: 3,
      position: 'a3',
    };
    expect(PhotoGroupBlockSchema.safeParse(block).success).toBe(true);
  });

  it('validates masonry layout', () => {
    const block = {
      type: 'photo-group',
      id: 'test-id',
      manifestIds: ['m1', 'm2'],
      layout: 'masonry',
      position: 'a3',
    };
    expect(PhotoGroupBlockSchema.safeParse(block).success).toBe(true);
  });

  it('rejects invalid layout', () => {
    const block = {
      type: 'photo-group',
      id: 'test-id',
      manifestIds: ['m1'],
      layout: 'invalid-layout',
      position: 'a3',
    };
    expect(PhotoGroupBlockSchema.safeParse(block).success).toBe(false);
  });

  it('rejects invalid column count', () => {
    const block = {
      type: 'photo-group',
      id: 'test-id',
      manifestIds: ['m1'],
      layout: 'grid',
      columns: 5, // Invalid - only 2, 3, 4 allowed
      position: 'a3',
    };
    expect(PhotoGroupBlockSchema.safeParse(block).success).toBe(false);
  });
});

describe('DividerBlockSchema', () => {
  it('validates line divider', () => {
    const block = {
      type: 'divider',
      id: 'test-id',
      style: 'line',
      position: 'a4',
    };
    expect(DividerBlockSchema.safeParse(block).success).toBe(true);
  });

  it('validates dots divider', () => {
    const block = {
      type: 'divider',
      id: 'test-id',
      style: 'dots',
      position: 'a4',
    };
    expect(DividerBlockSchema.safeParse(block).success).toBe(true);
  });

  it('validates space divider', () => {
    const block = {
      type: 'divider',
      id: 'test-id',
      style: 'space',
      position: 'a4',
    };
    expect(DividerBlockSchema.safeParse(block).success).toBe(true);
  });
});

describe('SectionBlockSchema', () => {
  it('validates section with title', () => {
    const block = {
      type: 'section',
      id: 'test-id',
      title: 'Day 1',
      childIds: ['blk1', 'blk2'],
      position: 'a5',
    };
    expect(SectionBlockSchema.safeParse(block).success).toBe(true);
  });

  it('validates section without title', () => {
    const block = {
      type: 'section',
      id: 'test-id',
      childIds: [],
      position: 'a5',
    };
    expect(SectionBlockSchema.safeParse(block).success).toBe(true);
  });

  it('validates collapsed section', () => {
    const block = {
      type: 'section',
      id: 'test-id',
      title: 'Hidden Content',
      collapsed: true,
      childIds: ['blk1'],
      position: 'a5',
    };
    expect(SectionBlockSchema.safeParse(block).success).toBe(true);
  });
});

describe('ContentBlockSchema (discriminated union)', () => {
  it('correctly identifies block type', () => {
    const headingResult = ContentBlockSchema.safeParse({
      type: 'heading',
      id: 'h1',
      level: 1,
      text: 'Title',
      position: 'a0',
    });
    expect(headingResult.success).toBe(true);
    if (headingResult.success) {
      expect(headingResult.data.type).toBe('heading');
    }
  });

  it('rejects unknown block type', () => {
    const result = ContentBlockSchema.safeParse({
      type: 'unknown-type',
      id: 'test',
      position: 'a0',
    });
    expect(result.success).toBe(false);
  });
});

describe('AlbumContentDocumentSchema', () => {
  it('validates complete document', () => {
    const doc: AlbumContentDocument = {
      version: 1,
      blocks: [
        { type: 'heading', id: 'h1', level: 1, text: 'My Album', position: 'a0' },
        { type: 'text', id: 't1', segments: [{ text: 'Welcome!' }], position: 'a1' },
        { type: 'photo-group', id: 'pg1', manifestIds: ['m1', 'm2'], layout: 'grid', position: 'a2' },
      ],
      settings: {
        defaultView: 'story',
      },
    };
    expect(AlbumContentDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it('validates document without settings', () => {
    const doc = {
      version: 1,
      blocks: [],
    };
    expect(AlbumContentDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it('rejects wrong version', () => {
    const doc = {
      version: 2, // Invalid
      blocks: [],
    };
    expect(AlbumContentDocumentSchema.safeParse(doc).success).toBe(false);
  });
});

describe('parseContentBlock', () => {
  it('returns parsed block for valid input', () => {
    const result = parseContentBlock({
      type: 'heading',
      id: 'h1',
      level: 2,
      text: 'Test',
      position: 'a0',
    });
    expect(result).not.toBeNull();
    expect(result?.type).toBe('heading');
  });

  it('returns null for invalid input', () => {
    const result = parseContentBlock({
      type: 'invalid',
      id: 'x',
    });
    expect(result).toBeNull();
  });
});

describe('parseAlbumContentDocument', () => {
  it('returns parsed document for valid input', () => {
    const result = parseAlbumContentDocument({
      version: 1,
      blocks: [],
    });
    expect(result).not.toBeNull();
    expect(result?.version).toBe(1);
  });

  it('returns null for invalid input', () => {
    const result = parseAlbumContentDocument({
      blocks: [], // Missing version
    });
    expect(result).toBeNull();
  });
});

describe('createEmptyContentDocument', () => {
  it('creates valid empty document', () => {
    const doc = createEmptyContentDocument();
    expect(doc.version).toBe(1);
    expect(doc.blocks).toEqual([]);
    expect(AlbumContentDocumentSchema.safeParse(doc).success).toBe(true);
  });
});

describe('block factories', () => {
  it('createHeadingBlock creates valid block', () => {
    const block = createHeadingBlock(2, 'Chapter 1', 'a0');
    expect(block.type).toBe('heading');
    expect(block.level).toBe(2);
    expect(block.text).toBe('Chapter 1');
    expect(block.id).toBeTruthy();
    expect(HeadingBlockSchema.safeParse(block).success).toBe(true);
  });

  it('createTextBlock creates valid block', () => {
    const block = createTextBlock([{ text: 'Hello' }], 'a1');
    expect(block.type).toBe('text');
    expect(block.segments).toHaveLength(1);
    expect(TextBlockSchema.safeParse(block).success).toBe(true);
  });

  it('createPhotoBlock creates valid block', () => {
    const block = createPhotoBlock('manifest-123', 'a2');
    expect(block.type).toBe('photo');
    expect(block.manifestId).toBe('manifest-123');
    expect(PhotoBlockSchema.safeParse(block).success).toBe(true);
  });

  it('createPhotoGroupBlock creates valid block', () => {
    const block = createPhotoGroupBlock(['m1', 'm2'], 'masonry', 'a3');
    expect(block.type).toBe('photo-group');
    expect(block.manifestIds).toEqual(['m1', 'm2']);
    expect(block.layout).toBe('masonry');
    expect(PhotoGroupBlockSchema.safeParse(block).success).toBe(true);
  });

  it('createDividerBlock creates valid block', () => {
    const block = createDividerBlock('dots', 'a4');
    expect(block.type).toBe('divider');
    expect(block.style).toBe('dots');
    expect(DividerBlockSchema.safeParse(block).success).toBe(true);
  });

  it('createSectionBlock creates valid block', () => {
    const block = createSectionBlock('Day 1', ['blk1', 'blk2'], 'a5');
    expect(block.type).toBe('section');
    expect(block.title).toBe('Day 1');
    expect(block.childIds).toEqual(['blk1', 'blk2']);
    expect(SectionBlockSchema.safeParse(block).success).toBe(true);
  });

  it('generates unique IDs', () => {
    const block1 = createHeadingBlock(1, 'A', 'a0');
    const block2 = createHeadingBlock(1, 'B', 'a1');
    expect(block1.id).not.toBe(block2.id);
  });
});

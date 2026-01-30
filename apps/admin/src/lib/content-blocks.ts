/**
 * Album Content Block Types
 *
 * Type definitions and Zod schemas for the modular block-based
 * album content system. All content is encrypted client-side.
 */

import { z } from 'zod';

// =============================================================================
// URL Sanitization (XSS Prevention)
// =============================================================================

const ALLOWED_URL_SCHEMES = ['https:', 'http:', 'mailto:'];

/**
 * Sanitize URL to prevent XSS attacks.
 * Only allows http, https, and mailto schemes.
 */
export function sanitizeHref(href: string): string | null {
  try {
    const url = new URL(href);
    if (!ALLOWED_URL_SCHEMES.includes(url.protocol)) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

// =============================================================================
// Rich Text Segment
// =============================================================================

/**
 * A segment of rich text with optional formatting.
 */
export const RichTextSegmentSchema = z.object({
  /** Plain text content */
  text: z.string(),
  /** Bold formatting */
  bold: z.boolean().optional(),
  /** Italic formatting */
  italic: z.boolean().optional(),
  /** Inline code formatting */
  code: z.boolean().optional(),
  /** URL for link (must pass sanitizeHref validation) */
  href: z.string().optional(),
});

export type RichTextSegment = z.infer<typeof RichTextSegmentSchema>;

// =============================================================================
// Block Base
// =============================================================================

/**
 * Base fields shared by all blocks.
 */
const BlockBaseSchema = z.object({
  /** Unique block identifier */
  id: z.string().min(1),
  /** Fractional index for ordering (from fractional-indexing library) */
  position: z.string(),
});

// =============================================================================
// Heading Block
// =============================================================================

/**
 * A heading block for section titles.
 */
export const HeadingBlockSchema = BlockBaseSchema.extend({
  type: z.literal('heading'),
  /** Heading level (1 = largest, 3 = smallest) */
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  /** Heading text */
  text: z.string(),
});

export type HeadingBlock = z.infer<typeof HeadingBlockSchema>;

// =============================================================================
// Text Block
// =============================================================================

/**
 * A paragraph of rich text.
 */
export const TextBlockSchema = BlockBaseSchema.extend({
  type: z.literal('text'),
  /** Array of rich text segments */
  segments: z.array(RichTextSegmentSchema),
});

export type TextBlock = z.infer<typeof TextBlockSchema>;

// =============================================================================
// Photo Block
// =============================================================================

/**
 * A single photo with optional caption.
 */
export const PhotoBlockSchema = BlockBaseSchema.extend({
  type: z.literal('photo'),
  /** Reference to manifest ID */
  manifestId: z.string(),
  /** Optional caption as rich text */
  caption: z.array(RichTextSegmentSchema).optional(),
});

export type PhotoBlock = z.infer<typeof PhotoBlockSchema>;

// =============================================================================
// Photo Group Block
// =============================================================================

/**
 * Layout options for photo groups.
 */
export const PhotoGroupLayoutSchema = z.enum(['grid', 'masonry', 'carousel', 'row']);

export type PhotoGroupLayout = z.infer<typeof PhotoGroupLayoutSchema>;

/**
 * A group of photos displayed together.
 */
export const PhotoGroupBlockSchema = BlockBaseSchema.extend({
  type: z.literal('photo-group'),
  /** Array of manifest IDs */
  manifestIds: z.array(z.string()),
  /** Layout style */
  layout: PhotoGroupLayoutSchema,
  /** Number of columns for grid layout */
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
});

export type PhotoGroupBlock = z.infer<typeof PhotoGroupBlockSchema>;

// =============================================================================
// Divider Block
// =============================================================================

/**
 * Visual separator between sections.
 */
export const DividerBlockSchema = BlockBaseSchema.extend({
  type: z.literal('divider'),
  /** Divider style */
  style: z.enum(['line', 'dots', 'space']),
});

export type DividerBlock = z.infer<typeof DividerBlockSchema>;

// =============================================================================
// Section Block
// =============================================================================

/**
 * A container for grouping blocks.
 */
export const SectionBlockSchema = BlockBaseSchema.extend({
  type: z.literal('section'),
  /** Optional section title */
  title: z.string().optional(),
  /** Whether section is collapsed */
  collapsed: z.boolean().optional(),
  /** IDs of child blocks */
  childIds: z.array(z.string()),
});

export type SectionBlock = z.infer<typeof SectionBlockSchema>;

// =============================================================================
// Union of All Block Types
// =============================================================================

/**
 * Union schema for all v1 block types.
 */
export const ContentBlockSchema = z.discriminatedUnion('type', [
  HeadingBlockSchema,
  TextBlockSchema,
  PhotoBlockSchema,
  PhotoGroupBlockSchema,
  DividerBlockSchema,
  SectionBlockSchema,
]);

export type ContentBlock = z.infer<typeof ContentBlockSchema>;

// =============================================================================
// Album Content Document
// =============================================================================

/**
 * The complete album content document structure.
 */
export const AlbumContentDocumentSchema = z.object({
  /** Document format version */
  version: z.literal(1),
  /** Array of content blocks */
  blocks: z.array(ContentBlockSchema),
  /** Document-level settings */
  settings: z.object({
    /** Default view mode when album is opened */
    defaultView: z.enum(['grid', 'story']).optional(),
  }).optional(),
});

export type AlbumContentDocument = z.infer<typeof AlbumContentDocumentSchema>;

// =============================================================================
// API Response Types
// =============================================================================

/**
 * Response from GET /api/albums/:id/content
 */
export interface AlbumContentResponse {
  /** Encrypted content document */
  encryptedContent: Uint8Array;
  /** 24-byte nonce */
  nonce: Uint8Array;
  /** Epoch ID used for encryption */
  epochId: number;
  /** Content version for concurrency */
  version: number;
  /** Last update timestamp */
  updatedAt: string;
}

/**
 * Request for PUT /api/albums/:id/content
 */
export interface UpdateAlbumContentRequest {
  /** Encrypted content document */
  encryptedContent: Uint8Array;
  /** 24-byte nonce */
  nonce: Uint8Array;
  /** Epoch ID used for encryption */
  epochId: number;
  /** Expected version for optimistic concurrency (0 for new) */
  expectedVersion: number;
}

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validate and parse a content block.
 * Returns null if validation fails.
 */
export function parseContentBlock(data: unknown): ContentBlock | null {
  const result = ContentBlockSchema.safeParse(data);
  return result.success ? result.data : null;
}

/**
 * Validate and parse an album content document.
 * Returns null if validation fails.
 */
export function parseAlbumContentDocument(data: unknown): AlbumContentDocument | null {
  const result = AlbumContentDocumentSchema.safeParse(data);
  return result.success ? result.data : null;
}

/**
 * Create an empty album content document.
 */
export function createEmptyContentDocument(): AlbumContentDocument {
  return {
    version: 1,
    blocks: [],
  };
}

// =============================================================================
// Block Factories
// =============================================================================

let blockIdCounter = 0;

/**
 * Generate a unique block ID.
 */
export function generateBlockId(): string {
  blockIdCounter++;
  return `blk_${Date.now().toString(36)}_${blockIdCounter.toString(36)}`;
}

/**
 * Create a heading block.
 */
export function createHeadingBlock(
  level: 1 | 2 | 3,
  text: string,
  position: string,
): HeadingBlock {
  return {
    type: 'heading',
    id: generateBlockId(),
    level,
    text,
    position,
  };
}

/**
 * Create a text block.
 */
export function createTextBlock(
  segments: RichTextSegment[],
  position: string,
): TextBlock {
  return {
    type: 'text',
    id: generateBlockId(),
    segments,
    position,
  };
}

/**
 * Create a photo block.
 */
export function createPhotoBlock(
  manifestId: string,
  position: string,
  caption?: RichTextSegment[],
): PhotoBlock {
  return {
    type: 'photo',
    id: generateBlockId(),
    manifestId,
    position,
    caption,
  };
}

/**
 * Create a photo group block.
 */
export function createPhotoGroupBlock(
  manifestIds: string[],
  layout: PhotoGroupLayout,
  position: string,
  columns?: 2 | 3 | 4,
): PhotoGroupBlock {
  return {
    type: 'photo-group',
    id: generateBlockId(),
    manifestIds,
    layout,
    position,
    columns,
  };
}

/**
 * Create a divider block.
 */
export function createDividerBlock(
  style: 'line' | 'dots' | 'space',
  position: string,
): DividerBlock {
  return {
    type: 'divider',
    id: generateBlockId(),
    style,
    position,
  };
}

/**
 * Create a section block.
 */
export function createSectionBlock(
  title: string | undefined,
  childIds: string[],
  position: string,
): SectionBlock {
  return {
    type: 'section',
    id: generateBlockId(),
    title,
    childIds,
    position,
  };
}

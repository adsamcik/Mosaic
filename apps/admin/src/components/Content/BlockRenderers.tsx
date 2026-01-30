/**
 * Album Content Block Renderers
 *
 * React components for rendering each block type in read-only mode.
 * Edit mode components are separate (using TipTap).
 */

import { memo, type ReactNode } from 'react';
import type {
  ContentBlock,
  HeadingBlock,
  TextBlock,
  PhotoBlock,
  PhotoGroupBlock,
  DividerBlock,
  QuoteBlock,
  SectionBlock,
  RichTextSegment,
} from '../../lib/content-blocks';
import './BlockRenderers.css';

// =============================================================================
// Rich Text Renderer
// =============================================================================

interface RichTextProps {
  segments: RichTextSegment[];
}

/**
 * Render rich text segments with formatting.
 */
export function RichText({ segments }: RichTextProps): ReactNode {
  if (segments.length === 0) {
    return null;
  }

  return (
    <>
      {segments.map((segment, index) => {
        let content: ReactNode = segment.text;

        // Apply formatting in order
        if (segment.code) {
          content = <code className="block-code">{content}</code>;
        }
        if (segment.bold) {
          content = <strong>{content}</strong>;
        }
        if (segment.italic) {
          content = <em>{content}</em>;
        }
        if (segment.href) {
          content = (
            <a
              href={segment.href}
              target="_blank"
              rel="noopener noreferrer"
              className="block-link"
            >
              {content}
            </a>
          );
        }

        return <span key={index}>{content}</span>;
      })}
    </>
  );
}

// =============================================================================
// Heading Block
// =============================================================================

interface HeadingBlockRendererProps {
  block: HeadingBlock;
}

export const HeadingBlockRenderer = memo(function HeadingBlockRenderer({
  block,
}: HeadingBlockRendererProps) {
  const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3';
  return <Tag className={`block-heading block-heading-${block.level}`}>{block.text}</Tag>;
});

// =============================================================================
// Text Block
// =============================================================================

interface TextBlockRendererProps {
  block: TextBlock;
}

export const TextBlockRenderer = memo(function TextBlockRenderer({
  block,
}: TextBlockRendererProps) {
  return (
    <p className="block-text">
      <RichText segments={block.segments} />
    </p>
  );
});

// =============================================================================
// Photo Block
// =============================================================================

interface PhotoBlockRendererProps {
  block: PhotoBlock;
  /** Callback to get thumbnail URL for a manifest ID */
  getThumbnailUrl?: ((manifestId: string) => string | undefined) | undefined;
  /** Callback when photo is clicked */
  onPhotoClick?: ((manifestId: string) => void) | undefined;
}

export const PhotoBlockRenderer = memo(function PhotoBlockRenderer({
  block,
  getThumbnailUrl,
  onPhotoClick,
}: PhotoBlockRendererProps) {
  const thumbnailUrl = getThumbnailUrl?.(block.manifestId);

  return (
    <figure className="block-photo">
      <div
        className="block-photo-container"
        onClick={() => onPhotoClick?.(block.manifestId)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onPhotoClick?.(block.manifestId);
          }
        }}
      >
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={block.caption ? 'Photo' : ''}
            className="block-photo-img"
            loading="lazy"
          />
        ) : (
          <div className="block-photo-placeholder">
            <span>Photo</span>
          </div>
        )}
      </div>
      {block.caption && block.caption.length > 0 && (
        <figcaption className="block-photo-caption">
          <RichText segments={block.caption} />
        </figcaption>
      )}
    </figure>
  );
});

// =============================================================================
// Photo Group Block
// =============================================================================

interface PhotoGroupBlockRendererProps {
  block: PhotoGroupBlock;
  /** Callback to get thumbnail URL for a manifest ID */
  getThumbnailUrl?: ((manifestId: string) => string | undefined) | undefined;
  /** Callback when photo is clicked */
  onPhotoClick?: ((manifestId: string) => void) | undefined;
}

export const PhotoGroupBlockRenderer = memo(function PhotoGroupBlockRenderer({
  block,
  getThumbnailUrl,
  onPhotoClick,
}: PhotoGroupBlockRendererProps) {
  const layoutClass = `block-photo-group-${block.layout}`;

  return (
    <div className={`block-photo-group ${layoutClass}`}>
      {block.manifestIds.map((manifestId: string) => {
        const thumbnailUrl = getThumbnailUrl?.(manifestId);
        return (
          <div
            key={manifestId}
            className="block-photo-group-item"
            onClick={() => onPhotoClick?.(manifestId)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onPhotoClick?.(manifestId);
              }
            }}
          >
            {thumbnailUrl ? (
              <img
                src={thumbnailUrl}
                alt=""
                className="block-photo-group-img"
                loading="lazy"
              />
            ) : (
              <div className="block-photo-group-placeholder" />
            )}
          </div>
        );
      })}
    </div>
  );
});

// =============================================================================
// Divider Block
// =============================================================================

interface DividerBlockRendererProps {
  block: DividerBlock;
}

export const DividerBlockRenderer = memo(function DividerBlockRenderer({
  block,
}: DividerBlockRendererProps) {
  return <hr className={`block-divider block-divider-${block.style}`} />;
});

// =============================================================================
// Quote Block
// =============================================================================

interface QuoteBlockRendererProps {
  block: QuoteBlock;
}

export const QuoteBlockRenderer = memo(function QuoteBlockRenderer({
  block,
}: QuoteBlockRendererProps) {
  return (
    <blockquote className="block-quote">
      <div className="block-quote-text">
        <RichText segments={block.text} />
      </div>
      {block.attribution && (
        <cite className="block-quote-attribution">— {block.attribution}</cite>
      )}
    </blockquote>
  );
});

// =============================================================================
// Section Block
// =============================================================================

interface SectionBlockRendererProps {
  block: SectionBlock;
  /** Render child blocks */
  children?: ReactNode;
}

export const SectionBlockRenderer = memo(function SectionBlockRenderer({
  block,
  children,
}: SectionBlockRendererProps) {
  return (
    <section className="block-section">
      {block.title && <h2 className="block-section-title">{block.title}</h2>}
      <div className="block-section-content">{children}</div>
    </section>
  );
});

// =============================================================================
// Block Renderer (Dispatch)
// =============================================================================

export interface BlockRendererProps {
  block: ContentBlock;
  /** Callback to get thumbnail URL for a manifest ID */
  getThumbnailUrl?: ((manifestId: string) => string | undefined) | undefined;
  /** Callback when photo is clicked */
  onPhotoClick?: ((manifestId: string) => void) | undefined;
}

/**
 * Render a content block based on its type.
 * Dispatches to the appropriate block renderer component.
 */
export const BlockRenderer = memo(function BlockRenderer({
  block,
  getThumbnailUrl,
  onPhotoClick,
}: BlockRendererProps) {
  switch (block.type) {
    case 'heading':
      return <HeadingBlockRenderer block={block} />;
    case 'text':
      return <TextBlockRenderer block={block} />;
    case 'photo':
      return (
        <PhotoBlockRenderer
          block={block}
          getThumbnailUrl={getThumbnailUrl}
          onPhotoClick={onPhotoClick}
        />
      );
    case 'photo-group':
      return (
        <PhotoGroupBlockRenderer
          block={block}
          getThumbnailUrl={getThumbnailUrl}
          onPhotoClick={onPhotoClick}
        />
      );
    case 'divider':
      return <DividerBlockRenderer block={block} />;
    case 'quote':
      return <QuoteBlockRenderer block={block} />;
    case 'section':
      // Section blocks contain children - for now render title only
      return <SectionBlockRenderer block={block} />;
    default: {
      // Type guard for exhaustive check - assign to unused param to silence warning
      ((x: never): never => {
        throw new Error(`Unknown block type: ${(x as ContentBlock).type}`);
      })(block);
    }
  }
});

// =============================================================================
// Content Document Renderer
// =============================================================================

export interface ContentRendererProps {
  blocks: ContentBlock[];
  /** Callback to get thumbnail URL for a manifest ID */
  getThumbnailUrl?: ((manifestId: string) => string | undefined) | undefined;
  /** Callback when photo is clicked */
  onPhotoClick?: ((manifestId: string) => void) | undefined;
  /** Optional CSS class name */
  className?: string | undefined;
}

/**
 * Render a full content document (list of blocks).
 */
export function ContentRenderer({
  blocks,
  getThumbnailUrl,
  onPhotoClick,
  className = '',
}: ContentRendererProps) {
  return (
    <div className={`album-content ${className}`}>
      {blocks.map((block) => (
        <div key={block.id} className="album-content-block">
          <BlockRenderer
            block={block}
            getThumbnailUrl={getThumbnailUrl}
            onPhotoClick={onPhotoClick}
          />
        </div>
      ))}
    </div>
  );
}

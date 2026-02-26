/**
 * Block Renderers Tests
 *
 * Tests for album content block rendering components using vitest + happy-dom.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BlockRenderer,
  ContentRenderer,
  HeadingBlockRenderer,
  TextBlockRenderer,
  PhotoBlockRenderer,
  PhotoGroupBlockRenderer,
  DividerBlockRenderer,
  SectionBlockRenderer,
  RichText,
} from '../../src/components/Content/BlockRenderers';
import type {
  HeadingBlock,
  TextBlock,
  PhotoBlock,
  PhotoGroupBlock,
  DividerBlock,
  SectionBlock,
  RichTextSegment,
} from '../../src/lib/content-blocks';

// Helper to render component and get container
function renderComponent<P extends object>(
  Component: React.ComponentType<P>,
  props: P,
) {
  const container = document.createElement('div');
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(createElement(Component, props));
  });

  const cleanup = () => {
    act(() => {
      root!.unmount();
    });
    container.remove();
  };

  return { container, cleanup };
}

// Setup and teardown for each test
let cleanupFns: (() => void)[] = [];

afterEach(() => {
  cleanupFns.forEach((fn) => fn());
  cleanupFns = [];
});

function render<P extends object>(Component: React.ComponentType<P>, props: P) {
  const result = renderComponent(Component, props);
  cleanupFns.push(result.cleanup);
  return result;
}

describe('RichText', () => {
  it('renders plain text', () => {
    const segments: RichTextSegment[] = [{ text: 'Hello World' }];
    const { container } = render(RichText, { segments });
    expect(container.textContent).toContain('Hello World');
  });

  it('renders bold text', () => {
    const segments: RichTextSegment[] = [{ text: 'Bold', bold: true }];
    const { container } = render(RichText, { segments });
    expect(container.querySelector('strong')).not.toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('Bold');
  });

  it('renders italic text', () => {
    const segments: RichTextSegment[] = [{ text: 'Italic', italic: true }];
    const { container } = render(RichText, { segments });
    expect(container.querySelector('em')).not.toBeNull();
    expect(container.querySelector('em')?.textContent).toBe('Italic');
  });

  it('renders code text', () => {
    const segments: RichTextSegment[] = [{ text: 'code', code: true }];
    const { container } = render(RichText, { segments });
    expect(container.querySelector('code')).not.toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('code');
  });

  it('renders links', () => {
    const segments: RichTextSegment[] = [
      { text: 'Click here', href: 'https://example.com' },
    ];
    const { container } = render(RichText, { segments });
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('https://example.com');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('renders combined formatting', () => {
    const segments: RichTextSegment[] = [
      { text: 'Bold and italic', bold: true, italic: true },
    ];
    const { container } = render(RichText, { segments });
    // Check that both strong and em exist (nesting order may vary)
    expect(container.querySelector('strong')).not.toBeNull();
    expect(container.querySelector('em')).not.toBeNull();
    expect(container.textContent).toContain('Bold and italic');
  });

  it('returns null for empty segments', () => {
    const segments: RichTextSegment[] = [];
    const { container } = render(RichText, { segments });
    // RichText returns null for empty, so span wrapper will be empty
    expect(container.textContent).toBe('');
  });
});

describe('HeadingBlockRenderer', () => {
  it('renders h1 heading', () => {
    const block: HeadingBlock = {
      type: 'heading',
      id: 'h1',
      level: 1,
      text: 'Main Title',
      position: 'a',
    };
    const { container } = render(HeadingBlockRenderer, { block });
    const h1 = container.querySelector('h1');
    expect(h1).not.toBeNull();
    expect(h1?.textContent).toBe('Main Title');
    expect(h1?.classList.contains('block-heading-1')).toBe(true);
  });

  it('renders h2 heading', () => {
    const block: HeadingBlock = {
      type: 'heading',
      id: 'h2',
      level: 2,
      text: 'Subtitle',
      position: 'b',
    };
    const { container } = render(HeadingBlockRenderer, { block });
    const h2 = container.querySelector('h2');
    expect(h2).not.toBeNull();
    expect(h2?.textContent).toBe('Subtitle');
  });

  it('renders h3 heading', () => {
    const block: HeadingBlock = {
      type: 'heading',
      id: 'h3',
      level: 3,
      text: 'Section',
      position: 'c',
    };
    const { container } = render(HeadingBlockRenderer, { block });
    const h3 = container.querySelector('h3');
    expect(h3).not.toBeNull();
    expect(h3?.textContent).toBe('Section');
  });
});

describe('TextBlockRenderer', () => {
  it('renders text block with segments', () => {
    const block: TextBlock = {
      type: 'text',
      id: 'text1',
      segments: [{ text: 'Hello ' }, { text: 'World', bold: true }],
      position: 'a',
    };
    const { container } = render(TextBlockRenderer, { block });
    const p = container.querySelector('p');
    expect(p).not.toBeNull();
    expect(p?.classList.contains('block-text')).toBe(true);
    expect(container.querySelector('strong')?.textContent).toBe('World');
  });
});

describe('PhotoBlockRenderer', () => {
  it('renders photo with thumbnail', () => {
    const block: PhotoBlock = {
      type: 'photo',
      id: 'photo1',
      manifestId: 'manifest-123',
      position: 'a',
    };
    const getThumbnailUrl = vi.fn().mockReturnValue('https://example.com/photo.jpg');
    const { container } = render(PhotoBlockRenderer, { block, getThumbnailUrl });
    expect(getThumbnailUrl).toHaveBeenCalledWith('manifest-123');
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('https://example.com/photo.jpg');
  });

  it('renders placeholder when no thumbnail URL', () => {
    const block: PhotoBlock = {
      type: 'photo',
      id: 'photo1',
      manifestId: 'manifest-123',
      position: 'a',
    };
    const { container } = render(PhotoBlockRenderer, { block });
    expect(container.querySelector('.block-photo-placeholder')).not.toBeNull();
  });

  it('calls onPhotoClick when clicked', () => {
    const block: PhotoBlock = {
      type: 'photo',
      id: 'photo1',
      manifestId: 'manifest-123',
      position: 'a',
    };
    const onPhotoClick = vi.fn();
    const { container } = render(PhotoBlockRenderer, { block, onPhotoClick });
    const photoContainer = container.querySelector('.block-photo-container');
    act(() => {
      photoContainer?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onPhotoClick).toHaveBeenCalledWith('manifest-123');
  });

  it('renders caption when provided', () => {
    const block: PhotoBlock = {
      type: 'photo',
      id: 'photo1',
      manifestId: 'manifest-123',
      caption: [{ text: 'A beautiful sunset' }],
      position: 'a',
    };
    const { container } = render(PhotoBlockRenderer, { block });
    expect(container.textContent).toContain('A beautiful sunset');
  });
});

describe('PhotoGroupBlockRenderer', () => {
  it('renders grid of photos', () => {
    const block: PhotoGroupBlock = {
      type: 'photo-group',
      id: 'group1',
      manifestIds: ['photo1', 'photo2', 'photo3'],
      layout: 'grid',
      position: 'a',
    };
    const getThumbnailUrl = vi.fn().mockImplementation((id) => `https://example.com/${id}.jpg`);
    const { container } = render(PhotoGroupBlockRenderer, { block, getThumbnailUrl });
    expect(container.querySelectorAll('.block-photo-group-item').length).toBe(3);
    expect(getThumbnailUrl).toHaveBeenCalledTimes(3);
  });

  it('applies row layout class', () => {
    const block: PhotoGroupBlock = {
      type: 'photo-group',
      id: 'group1',
      manifestIds: ['photo1'],
      layout: 'row',
      position: 'a',
    };
    const { container } = render(PhotoGroupBlockRenderer, { block });
    expect(container.querySelector('.block-photo-group-row')).not.toBeNull();
  });

  it('calls onPhotoClick for each photo', () => {
    const block: PhotoGroupBlock = {
      type: 'photo-group',
      id: 'group1',
      manifestIds: ['photo1', 'photo2'],
      layout: 'grid',
      position: 'a',
    };
    const onPhotoClick = vi.fn();
    const { container } = render(PhotoGroupBlockRenderer, { block, onPhotoClick });
    const items = container.querySelectorAll('.block-photo-group-item');
    act(() => {
      items[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onPhotoClick).toHaveBeenCalledWith('photo1');
    act(() => {
      items[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onPhotoClick).toHaveBeenCalledWith('photo2');
  });
});

describe('DividerBlockRenderer', () => {
  it('renders line divider', () => {
    const block: DividerBlock = {
      type: 'divider',
      id: 'div1',
      style: 'line',
      position: 'a',
    };
    const { container } = render(DividerBlockRenderer, { block });
    const hr = container.querySelector('hr');
    expect(hr).not.toBeNull();
    expect(hr?.classList.contains('block-divider-line')).toBe(true);
  });

  it('renders dots divider', () => {
    const block: DividerBlock = {
      type: 'divider',
      id: 'div1',
      style: 'dots',
      position: 'a',
    };
    const { container } = render(DividerBlockRenderer, { block });
    expect(container.querySelector('.block-divider-dots')).not.toBeNull();
  });

  it('renders space divider', () => {
    const block: DividerBlock = {
      type: 'divider',
      id: 'div1',
      style: 'space',
      position: 'a',
    };
    const { container } = render(DividerBlockRenderer, { block });
    expect(container.querySelector('.block-divider-space')).not.toBeNull();
  });
});

describe('SectionBlockRenderer', () => {
  it('renders section with title', () => {
    const block: SectionBlock = {
      type: 'section',
      id: 'section1',
      title: 'My Section',
      childIds: [],
      position: 'a',
    };
    const { container } = render(SectionBlockRenderer, { block });
    expect(container.querySelector('.block-section')).not.toBeNull();
    expect(container.querySelector('.block-section-title')?.textContent).toBe('My Section');
  });

  it('renders section without title', () => {
    const block: SectionBlock = {
      type: 'section',
      id: 'section1',
      childIds: [],
      position: 'a',
    };
    const { container } = render(SectionBlockRenderer, { block });
    expect(container.querySelector('.block-section')).not.toBeNull();
    expect(container.querySelector('.block-section-title')).toBeNull();
  });
});

describe('BlockRenderer', () => {
  it('dispatches to HeadingBlockRenderer', () => {
    const block: HeadingBlock = {
      type: 'heading',
      id: 'h1',
      level: 1,
      text: 'Test',
      position: 'a',
    };
    const { container } = render(BlockRenderer, { block });
    expect(container.querySelector('h1')).not.toBeNull();
  });

  it('dispatches to TextBlockRenderer', () => {
    const block: TextBlock = {
      type: 'text',
      id: 'text1',
      segments: [{ text: 'Test' }],
      position: 'a',
    };
    const { container } = render(BlockRenderer, { block });
    expect(container.querySelector('.block-text')).not.toBeNull();
  });

  it('dispatches to PhotoBlockRenderer', () => {
    const block: PhotoBlock = {
      type: 'photo',
      id: 'photo1',
      manifestId: 'manifest-123',
      position: 'a',
    };
    const { container } = render(BlockRenderer, { block });
    expect(container.querySelector('.block-photo')).not.toBeNull();
  });

  it('dispatches to DividerBlockRenderer', () => {
    const block: DividerBlock = {
      type: 'divider',
      id: 'div1',
      style: 'line',
      position: 'a',
    };
    const { container } = render(BlockRenderer, { block });
    expect(container.querySelector('.block-divider')).not.toBeNull();
  });
});

describe('ContentRenderer', () => {
  it('renders multiple blocks', () => {
    const blocks = [
      { type: 'heading' as const, id: 'h1', level: 1 as const, text: 'Title', position: 'a' },
      { type: 'text' as const, id: 't1', segments: [{ text: 'Content' }], position: 'b' },
      { type: 'divider' as const, id: 'd1', style: 'line' as const, position: 'c' },
    ];
    const { container } = render(ContentRenderer, { blocks });
    expect(container.querySelectorAll('.album-content-block').length).toBe(3);
    expect(container.querySelector('h1')).not.toBeNull();
    expect(container.querySelector('.block-text')).not.toBeNull();
    expect(container.querySelector('.block-divider')).not.toBeNull();
  });

  it('renders empty content', () => {
    const { container } = render(ContentRenderer, { blocks: [] });
    expect(container.querySelector('.album-content')).not.toBeNull();
    expect(container.querySelectorAll('.album-content-block').length).toBe(0);
  });

  it('applies custom className', () => {
    const { container } = render(ContentRenderer, { blocks: [], className: 'custom-class' });
    expect(container.querySelector('.album-content.custom-class')).not.toBeNull();
  });

  it('passes callbacks to photo blocks', () => {
    const blocks = [
      { type: 'photo' as const, id: 'p1', manifestId: 'manifest-123', position: 'a' },
    ];
    const getThumbnailUrl = vi.fn().mockReturnValue('https://example.com/photo.jpg');
    const onPhotoClick = vi.fn();
    render(ContentRenderer, { blocks, getThumbnailUrl, onPhotoClick });
    expect(getThumbnailUrl).toHaveBeenCalledWith('manifest-123');
  });
});

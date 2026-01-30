/**
 * Slash Command Menu Tests
 *
 * Unit tests for the slash command menu component and hook.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { SlashCommandMenu, useSlashCommand, type SlashCommandMenuProps } from '../src/components/Content/SlashCommandMenu';

// Mock i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'content.slashMenu.title': 'Insert Block',
        'content.slashMenu.hint': '↑↓ navigate • Enter select • Esc close',
        'content.slashMenu.categories.text': 'Text',
        'content.slashMenu.categories.media': 'Media',
        'content.slashMenu.categories.layout': 'Layout',
        'blocks.heading': 'Heading',
        'blocks.text': 'Text',
        'blocks.quote': 'Quote',
        'blocks.photo': 'Photo',
        'blocks.photoGroup': 'Photo Grid',
        'blocks.map': 'Map',
        'blocks.divider': 'Divider',
        'blocks.section': 'Section',
      };
      return translations[key] ?? key;
    },
  }),
}));

// Test component for hook testing
function TestHookConsumer({ onMount }: { onMount: (api: ReturnType<typeof useSlashCommand>) => void }) {
  const api = useSlashCommand();
  onMount(api);
  return null;
}

describe('SlashCommandMenu', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  
  const defaultProps: SlashCommandMenuProps = {
    isOpen: true,
    position: { top: 100, left: 200 },
    query: '',
    onSelect: vi.fn(),
    onClose: vi.fn(),
    hasPhotoBlocks: true,
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('should not render when closed', () => {
    act(() => {
      root.render(createElement(SlashCommandMenu, { ...defaultProps, isOpen: false }));
    });
    expect(document.querySelector('.slash-command-menu')).toBeNull();
  });

  it('should render menu when open', () => {
    act(() => {
      root.render(createElement(SlashCommandMenu, { ...defaultProps }));
    });
    expect(document.querySelector('.slash-command-menu')).not.toBeNull();
    expect(document.querySelector('.slash-menu-header')?.textContent).toBe('Insert Block');
  });

  it('should show all categories', () => {
    act(() => {
      root.render(createElement(SlashCommandMenu, { ...defaultProps }));
    });
    const categories = document.querySelectorAll('.slash-menu-category-label');
    expect(categories.length).toBe(3);
    expect(categories[0]?.textContent).toBe('Text');
    expect(categories[1]?.textContent).toBe('Media');
    expect(categories[2]?.textContent).toBe('Layout');
  });

  it('should show block types', () => {
    act(() => {
      root.render(createElement(SlashCommandMenu, { ...defaultProps }));
    });
    const items = document.querySelectorAll('.slash-menu-item-label');
    const labels = Array.from(items).map(el => el.textContent);
    expect(labels).toContain('Heading');
    expect(labels).toContain('Quote');
    expect(labels).toContain('Photo');
    expect(labels).toContain('Map');
    expect(labels).toContain('Divider');
  });

  it('should filter items by query', () => {
    act(() => {
      root.render(createElement(SlashCommandMenu, { ...defaultProps, query: 'head' }));
    });
    const items = document.querySelectorAll('.slash-menu-item-label');
    const labels = Array.from(items).map(el => el.textContent);
    expect(labels).toContain('Heading');
    expect(labels).not.toContain('Quote');
  });

  it('should call onSelect when item clicked', () => {
    const onSelect = vi.fn();
    act(() => {
      root.render(createElement(SlashCommandMenu, { ...defaultProps, onSelect }));
    });
    
    const headingItem = document.querySelector('.slash-menu-item');
    act(() => {
      headingItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    
    expect(onSelect).toHaveBeenCalledWith('heading');
  });

  it('should hide photo blocks when hasPhotoBlocks is false', () => {
    act(() => {
      root.render(createElement(SlashCommandMenu, { ...defaultProps, hasPhotoBlocks: false }));
    });
    const items = document.querySelectorAll('.slash-menu-item-label');
    const labels = Array.from(items).map(el => el.textContent);
    expect(labels).not.toContain('Photo');
    expect(labels).not.toContain('Photo Grid');
  });

  it('should show photo blocks when hasPhotoBlocks is true', () => {
    act(() => {
      root.render(createElement(SlashCommandMenu, { ...defaultProps, hasPhotoBlocks: true }));
    });
    const items = document.querySelectorAll('.slash-menu-item-label');
    const labels = Array.from(items).map(el => el.textContent);
    expect(labels).toContain('Photo');
    expect(labels).toContain('Photo Grid');
  });

  it('should close on Escape key', () => {
    const onClose = vi.fn();
    act(() => {
      root.render(createElement(SlashCommandMenu, { ...defaultProps, onClose }));
    });
    
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    
    expect(onClose).toHaveBeenCalled();
  });

  it('should select on Enter key', () => {
    const onSelect = vi.fn();
    act(() => {
      root.render(createElement(SlashCommandMenu, { ...defaultProps, onSelect }));
    });
    
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    
    expect(onSelect).toHaveBeenCalledWith('heading');
  });

  it('should navigate with arrow keys', () => {
    const onSelect = vi.fn();
    act(() => {
      root.render(createElement(SlashCommandMenu, { ...defaultProps, onSelect }));
    });
    
    // Move down once
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    
    // Select
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    
    // Should select 'text' (second item)
    expect(onSelect).toHaveBeenCalledWith('text');
  });

  it('should not render when no items match query', () => {
    act(() => {
      root.render(createElement(SlashCommandMenu, { ...defaultProps, query: 'zzznonexistent' }));
    });
    expect(document.querySelector('.slash-command-menu')).toBeNull();
  });
});

describe('useSlashCommand hook', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let hookApi: ReturnType<typeof useSlashCommand> | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    hookApi = null;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('should initialize with closed state', () => {
    act(() => {
      root.render(createElement(TestHookConsumer, { onMount: (api) => { hookApi = api; } }));
    });
    
    expect(hookApi).not.toBeNull();
    expect(hookApi!.isOpen).toBe(false);
    expect(hookApi!.query).toBe('');
    expect(hookApi!.position).toEqual({ top: 0, left: 0 });
  });

  it('should open menu with position', () => {
    act(() => {
      root.render(createElement(TestHookConsumer, { onMount: (api) => { hookApi = api; } }));
    });
    
    act(() => {
      hookApi!.open({ bottom: 100, left: 200 } as DOMRect);
    });
    
    // Re-render to get updated state
    act(() => {
      root.render(createElement(TestHookConsumer, { onMount: (api) => { hookApi = api; } }));
    });
    
    expect(hookApi!.isOpen).toBe(true);
    expect(hookApi!.position).toEqual({ top: 104, left: 200 });
    expect(hookApi!.query).toBe('');
  });

  it('should update query', () => {
    act(() => {
      root.render(createElement(TestHookConsumer, { onMount: (api) => { hookApi = api; } }));
    });
    
    act(() => {
      hookApi!.open({ bottom: 100, left: 200 } as DOMRect);
    });
    
    act(() => {
      hookApi!.setQuery('heading');
    });
    
    // Re-render to get updated state
    act(() => {
      root.render(createElement(TestHookConsumer, { onMount: (api) => { hookApi = api; } }));
    });
    
    expect(hookApi!.query).toBe('heading');
  });

  it('should close and reset state', () => {
    act(() => {
      root.render(createElement(TestHookConsumer, { onMount: (api) => { hookApi = api; } }));
    });
    
    act(() => {
      hookApi!.open({ bottom: 100, left: 200 } as DOMRect);
      hookApi!.setQuery('heading');
    });
    
    act(() => {
      hookApi!.close();
    });
    
    // Re-render to get updated state
    act(() => {
      root.render(createElement(TestHookConsumer, { onMount: (api) => { hookApi = api; } }));
    });
    
    expect(hookApi!.isOpen).toBe(false);
    expect(hookApi!.query).toBe('');
  });
});

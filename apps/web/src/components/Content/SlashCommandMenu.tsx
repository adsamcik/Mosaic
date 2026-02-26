/**
 * Slash Command Menu Component
 *
 * A floating menu that appears when the user types "/" at the start
 * of an empty line in the block editor. Allows quick insertion of
 * different block types with keyboard navigation and filtering.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { ContentBlock } from '../../lib/content-blocks';

// ==============================================================================
// Types & Constants
// ==============================================================================

/** Block type that can be inserted */
export type InsertableBlockType = ContentBlock['type'] | 'photo' | 'photo-group';

/** A single menu item */
export interface SlashMenuItem {
  type: InsertableBlockType;
  labelKey: string;
  icon: string;
  keywords: string[];
}

/** A category of menu items */
export interface SlashMenuCategory {
  labelKey: string;
  items: SlashMenuItem[];
}

/** Menu categories with their items */
const MENU_CATEGORIES: SlashMenuCategory[] = [
  {
    labelKey: 'content.slashMenu.categories.text',
    items: [
      {
        type: 'heading',
        labelKey: 'blocks.heading',
        icon: 'H',
        keywords: ['heading', 'title', 'h1', 'h2', 'h3', 'nadpis'],
      },
      {
        type: 'text',
        labelKey: 'blocks.text',
        icon: '¶',
        keywords: ['text', 'paragraph', 'body', 'odstavec'],
      },
      {
        type: 'quote',
        labelKey: 'blocks.quote',
        icon: '"',
        keywords: ['quote', 'blockquote', 'citation', 'citát'],
      },
    ],
  },
  {
    labelKey: 'content.slashMenu.categories.media',
    items: [
      {
        type: 'photo',
        labelKey: 'blocks.photo',
        icon: '📷',
        keywords: ['photo', 'image', 'picture', 'fotka', 'obrázek'],
      },
      {
        type: 'photo-group',
        labelKey: 'blocks.photoGroup',
        icon: '📸',
        keywords: ['grid', 'gallery', 'photos', 'mřížka', 'galerie'],
      },
      {
        type: 'map',
        labelKey: 'blocks.map',
        icon: '🗺️',
        keywords: ['map', 'location', 'place', 'mapa', 'místo'],
      },
    ],
  },
  {
    labelKey: 'content.slashMenu.categories.layout',
    items: [
      {
        type: 'divider',
        labelKey: 'blocks.divider',
        icon: '—',
        keywords: ['divider', 'separator', 'line', 'hr', 'oddělovač'],
      },
      {
        type: 'section',
        labelKey: 'blocks.section',
        icon: '📁',
        keywords: ['section', 'container', 'group', 'sekce'],
      },
    ],
  },
];

// ==============================================================================
// Slash Command Menu Component
// ==============================================================================

export interface SlashCommandMenuProps {
  /** Whether the menu is visible */
  isOpen: boolean;
  /** Position for the menu */
  position: { top: number; left: number };
  /** Current filter query (text after /) */
  query: string;
  /** Called when a block type is selected */
  onSelect: (type: InsertableBlockType) => void;
  /** Called when menu should close */
  onClose: () => void;
  /** Whether photo blocks are available */
  hasPhotoBlocks?: boolean;
}

export const SlashCommandMenu = memo(function SlashCommandMenu({
  isOpen,
  position,
  query,
  onSelect,
  onClose,
  hasPhotoBlocks = false,
}: SlashCommandMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Filter items based on query
  const filteredCategories = useMemo(() => {
    const lowerQuery = query.toLowerCase().trim();
    
    return MENU_CATEGORIES.map((category) => {
      const filteredItems = category.items.filter((item) => {
        // Exclude photo blocks if not available
        if (!hasPhotoBlocks && (item.type === 'photo' || item.type === 'photo-group')) {
          return false;
        }
        
        // No query = show all
        if (!lowerQuery) return true;
        
        // Match against translated label
        const label = t(item.labelKey).toLowerCase();
        if (label.includes(lowerQuery)) return true;
        
        // Match against keywords
        return item.keywords.some((kw) => kw.includes(lowerQuery));
      });
      
      return { ...category, items: filteredItems };
    }).filter((category) => category.items.length > 0);
  }, [query, hasPhotoBlocks, t]);

  // Flatten items for keyboard navigation
  const flatItems = useMemo(() => {
    return filteredCategories.flatMap((cat) => cat.items);
  }, [filteredCategories]);

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((prev) => 
            prev < flatItems.length - 1 ? prev + 1 : 0
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((prev) => 
            prev > 0 ? prev - 1 : flatItems.length - 1
          );
          break;
        case 'Enter':
          e.preventDefault();
          e.stopPropagation();
          if (flatItems[selectedIndex]) {
            onSelect(flatItems[selectedIndex].type);
          }
          break;
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          onClose();
          break;
      }
    };

    // Use capture to handle before TipTap
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, flatItems, selectedIndex, onSelect, onClose]);

  // Click outside to close
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    if (!isOpen || !menuRef.current) return;
    
    const selectedEl = menuRef.current.querySelector('.slash-menu-item.selected');
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }, [isOpen, selectedIndex]);

  const handleItemClick = useCallback(
    (type: InsertableBlockType) => {
      onSelect(type);
    },
    [onSelect],
  );

  if (!isOpen || flatItems.length === 0) {
    return null;
  }

  // Calculate global index for each item
  let globalIndex = 0;

  const menu = (
    <div
      ref={menuRef}
      className="slash-command-menu"
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
      }}
    >
      <div className="slash-menu-header">
        {t('content.slashMenu.title')}
      </div>
      <div className="slash-menu-content">
        {filteredCategories.map((category) => (
          <div key={category.labelKey} className="slash-menu-category">
            <div className="slash-menu-category-label">
              {t(category.labelKey)}
            </div>
            {category.items.map((item) => {
              const itemIndex = globalIndex++;
              const isSelected = itemIndex === selectedIndex;
              
              return (
                <button
                  key={item.type}
                  type="button"
                  className={`slash-menu-item ${isSelected ? 'selected' : ''}`}
                  onClick={() => handleItemClick(item.type)}
                  onMouseEnter={() => setSelectedIndex(itemIndex)}
                >
                  <span className="slash-menu-item-icon">{item.icon}</span>
                  <span className="slash-menu-item-label">{t(item.labelKey)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="slash-menu-hint">
        {t('content.slashMenu.hint')}
      </div>
    </div>
  );

  return createPortal(menu, document.body);
});

// ==============================================================================
// Slash Command Hook
// ==============================================================================

export interface UseSlashCommandResult {
  /** Whether the menu is open */
  isOpen: boolean;
  /** Current filter query */
  query: string;
  /** Position for the menu */
  position: { top: number; left: number };
  /** Open the menu at a position */
  open: (rect: DOMRect) => void;
  /** Close the menu */
  close: () => void;
  /** Update the query */
  setQuery: (query: string) => void;
}

/**
 * Hook for managing slash command menu state.
 */
export function useSlashCommand(): UseSlashCommandResult {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const open = useCallback((rect: DOMRect) => {
    setPosition({
      top: rect.bottom + 4,
      left: rect.left,
    });
    setQuery('');
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery('');
  }, []);

  return {
    isOpen,
    query,
    position,
    open,
    close,
    setQuery,
  };
}

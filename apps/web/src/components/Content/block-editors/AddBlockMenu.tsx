/**
 * AddBlockMenu Component
 *
 * Menu for adding new content blocks with type selection.
 */

import { memo, useCallback, useState } from 'react';
import type { ContentBlock } from '../../../lib/content-blocks';
import type { AddBlockMenuProps } from './types';

export const AddBlockMenu = memo(function AddBlockMenu({
  onAddBlock,
  onAddPhotoBlock,
  onAddPhotoGroupBlock,
}: AddBlockMenuProps) {
  const [isOpen, setIsOpen] = useState(false);

  const handleAdd = useCallback(
    (type: ContentBlock['type']) => {
      onAddBlock(type);
      setIsOpen(false);
    },
    [onAddBlock],
  );

  const handleAddPhoto = useCallback(() => {
    onAddPhotoBlock?.();
    setIsOpen(false);
  }, [onAddPhotoBlock]);

  const handleAddPhotoGroup = useCallback(() => {
    onAddPhotoGroupBlock?.();
    setIsOpen(false);
  }, [onAddPhotoGroupBlock]);

  return (
    <div className="add-block-menu">
      {isOpen ? (
        <div className="add-block-options">
          <button type="button" onClick={() => handleAdd('heading')}>
            Heading
          </button>
          <button type="button" onClick={() => handleAdd('text')}>
            Text
          </button>
          <button type="button" onClick={() => handleAdd('divider')}>
            Divider
          </button>
          <button type="button" onClick={() => handleAdd('quote')}>
            Quote
          </button>
          <button type="button" onClick={() => handleAdd('map')}>
            Map
          </button>
          {onAddPhotoBlock && (
            <button type="button" onClick={handleAddPhoto}>
              Photo
            </button>
          )}
          {onAddPhotoGroupBlock && (
            <button type="button" onClick={handleAddPhotoGroup}>
              Photo Grid
            </button>
          )}
          <button
            type="button"
            className="add-block-cancel"
            onClick={() => setIsOpen(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="add-block-btn"
          onClick={() => setIsOpen(true)}
        >
          + Add Block
        </button>
      )}
    </div>
  );
});

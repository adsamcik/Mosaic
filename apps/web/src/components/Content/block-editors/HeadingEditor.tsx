/**
 * HeadingEditor Component
 *
 * Editor for heading blocks with level selection (H1, H2, H3).
 */

import React, { memo, useCallback, useState } from 'react';
import type { HeadingEditorProps } from './types';

export const HeadingEditor = memo(function HeadingEditor({
  text,
  level,
  onChange,
}: HeadingEditorProps) {
  const [editText, setEditText] = useState(text);

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setEditText(e.target.value);
    },
    [],
  );

  const handleBlur = useCallback(() => {
    onChange(editText, level);
  }, [editText, level, onChange]);

  const handleLevelChange = useCallback(
    (newLevel: 1 | 2 | 3) => {
      onChange(editText, newLevel);
    },
    [editText, onChange],
  );

  return (
    <div className="heading-editor">
      <div className="heading-editor-controls">
        {([1, 2, 3] as const).map((l) => (
          <button
            key={l}
            type="button"
            className={`heading-level-btn ${level === l ? 'active' : ''}`}
            onClick={() => handleLevelChange(l)}
          >
            H{l}
          </button>
        ))}
      </div>
      <input
        type="text"
        className={`heading-input heading-level-${level}`}
        value={editText}
        onChange={handleTextChange}
        onBlur={handleBlur}
        placeholder="Enter heading..."
      />
    </div>
  );
});

import { useCallback, useState } from 'react';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

/**
 * Search input component with debounced value updates
 * Uses FTS5 full-text search on filenames and tags
 */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search photos...',
  className = '',
}: SearchInputProps) {
  const [localValue, setLocalValue] = useState(value);

  // Handle input change with local state for immediate feedback
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setLocalValue(newValue);

      // Debounce the actual search - only trigger after user stops typing
      const timeoutId = setTimeout(() => {
        onChange(newValue);
      }, 300);

      return () => clearTimeout(timeoutId);
    },
    [onChange]
  );

  // Handle clear button
  const handleClear = useCallback(() => {
    setLocalValue('');
    onChange('');
  }, [onChange]);

  // Handle Enter key to search immediately
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        onChange(localValue);
      }
      if (e.key === 'Escape') {
        handleClear();
      }
    },
    [localValue, onChange, handleClear]
  );

  return (
    <div className={`search-input-wrapper ${className}`}>
      <span className="search-icon" aria-hidden="true">
        🔍
      </span>
      <input
        type="search"
        className="search-input"
        value={localValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label="Search photos"
        data-testid="photo-search-input"
      />
      {localValue && (
        <button
          type="button"
          className="search-clear-btn"
          onClick={handleClear}
          aria-label="Clear search"
          data-testid="search-clear-button"
        >
          ✕
        </button>
      )}
    </div>
  );
}

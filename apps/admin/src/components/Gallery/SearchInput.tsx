import { useCallback, useEffect, useRef, useState } from 'react';

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
  const timeoutRef = useRef<number | null>(null);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  // Handle input change with local state for immediate feedback
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setLocalValue(newValue);

      // Clear any pending debounce timeout
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }

      // Debounce the actual search - only trigger after user stops typing
      timeoutRef.current = window.setTimeout(() => {
        onChange(newValue);
        timeoutRef.current = null;
      }, 300);
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
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
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
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      )}
    </div>
  );
}

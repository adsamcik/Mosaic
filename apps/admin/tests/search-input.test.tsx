/**
 * SearchInput Component Tests
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchInput } from '../src/components/Gallery/SearchInput';

// Helper to properly trigger React onChange on controlled inputs
function setInputValue(input: HTMLInputElement, value: string) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set;
  nativeInputValueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('SearchInput', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders with placeholder text', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(createElement(SearchInput, { value: '', onChange, placeholder: 'Search...' }));
    });

    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.placeholder).toBe('Search...');
  });

  it('displays current value', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(createElement(SearchInput, { value: '', onChange }));
    });

    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    
    // Type in the input
    act(() => {
      setInputValue(input, 'test query');
    });

    expect(input.value).toBe('test query');
  });

  it('calls onChange with debounced value', async () => {
    const onChange = vi.fn();
    act(() => {
      root.render(createElement(SearchInput, { value: '', onChange }));
    });

    const input = container.querySelector('input[type="search"]') as HTMLInputElement;

    act(() => {
      setInputValue(input, 'photo');
    });

    // Should not call immediately
    expect(onChange).not.toHaveBeenCalled();

    // Advance timers past debounce delay
    await act(async () => {
      vi.advanceTimersByTime(350);
    });

    expect(onChange).toHaveBeenCalledWith('photo');
  });

  it('calls onChange immediately on Enter key', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(createElement(SearchInput, { value: '', onChange }));
    });

    const input = container.querySelector('input[type="search"]') as HTMLInputElement;

    act(() => {
      setInputValue(input, 'search term');
    });

    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      input.dispatchEvent(event);
    });

    expect(onChange).toHaveBeenCalledWith('search term');
  });

  it('clears input on Escape key', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(createElement(SearchInput, { value: '', onChange }));
    });

    const input = container.querySelector('input[type="search"]') as HTMLInputElement;

    act(() => {
      setInputValue(input, 'test');
    });

    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      input.dispatchEvent(event);
    });

    expect(onChange).toHaveBeenCalledWith('');
  });

  it('shows clear button when value is present', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(createElement(SearchInput, { value: '', onChange }));
    });

    // No clear button when empty
    expect(container.querySelector('[data-testid="search-clear-button"]')).toBeNull();

    const input = container.querySelector('input[type="search"]') as HTMLInputElement;

    act(() => {
      setInputValue(input, 'test');
    });

    // Clear button should appear
    expect(container.querySelector('[data-testid="search-clear-button"]')).not.toBeNull();
  });

  it('clears value when clear button is clicked', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(createElement(SearchInput, { value: '', onChange }));
    });

    const input = container.querySelector('input[type="search"]') as HTMLInputElement;

    act(() => {
      setInputValue(input, 'test');
    });

    const clearButton = container.querySelector('[data-testid="search-clear-button"]') as HTMLButtonElement;
    
    act(() => {
      clearButton.click();
    });

    expect(onChange).toHaveBeenCalledWith('');
  });

  it('has correct data-testid', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(createElement(SearchInput, { value: '', onChange }));
    });

    expect(container.querySelector('[data-testid="photo-search-input"]')).not.toBeNull();
  });

  it('applies custom className', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(createElement(SearchInput, { value: '', onChange, className: 'custom-class' }));
    });

    expect(container.querySelector('.custom-class')).not.toBeNull();
  });

  it('renders default placeholder when not specified', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(createElement(SearchInput, { value: '', onChange }));
    });

    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    expect(input.placeholder).toBe('Search photos...');
  });
});

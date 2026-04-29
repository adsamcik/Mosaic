/**
 * TextEditor Tests
 *
 * Unit tests for the pure helper `htmlToSegments`, the security-relevant
 * function that converts TipTap HTML output into RichTextSegments.
 *
 * Covers M6: parsing must not execute scripts or fire event handlers
 * (DOMParser-based parsing) and href sanitization must drop unsafe schemes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { htmlToSegments } from '../../src/components/Content/block-editors/TextEditor';

// Mock TipTap - it doesn't work well in happy-dom and we only exercise
// the pure helper in this file.
vi.mock('@tiptap/react', () => ({
  useEditor: vi.fn(() => ({
    getHTML: () => '<p></p>',
    getText: () => '',
    destroy: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  })),
  EditorContent: () => null,
}));

vi.mock('@tiptap/starter-kit', () => ({
  default: { configure: vi.fn(() => ({})) },
}));

vi.mock('@tiptap/extension-placeholder', () => ({
  default: { configure: vi.fn(() => ({})) },
}));

describe('htmlToSegments', () => {
  let alertSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // happy-dom does not define window.alert; install a spy so any XSS
    // payload that managed to execute during parsing would be observable.
    alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses plain text into a single segment', () => {
    const segments = htmlToSegments('hello world');
    expect(segments).toEqual([{ text: 'hello world' }]);
  });

  it('parses bold, italic, and code into formatted segments', () => {
    const segments = htmlToSegments(
      '<strong>bold</strong><em>italic</em><code>code</code>',
    );
    expect(segments).toEqual([
      { text: 'bold', bold: true },
      { text: 'italic', italic: true },
      { text: 'code', code: true },
    ]);
  });

  it('rejects javascript: hrefs (segment.href is undefined)', () => {
    const segments = htmlToSegments('<a href="javascript:alert(1)">click</a>');
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe('click');
    expect(segments[0]?.href).toBeUndefined();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('passes https: hrefs through', () => {
    const segments = htmlToSegments('<a href="https://example.com/">link</a>');
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe('link');
    expect(segments[0]?.href).toBe('https://example.com/');
  });

  it('does not execute <img onerror> and produces no segments for img tags', () => {
    const segments = htmlToSegments('<img src="x" onerror="alert(1)">');
    expect(alertSpy).not.toHaveBeenCalled();
    // <img> is not in the recognized set and contributes no segments;
    // empty result falls back to [{ text: '' }].
    expect(segments).toEqual([{ text: '' }]);
  });

  it('does not execute <script> contents but still extracts following formatting', () => {
    const segments = htmlToSegments(
      '<script>alert(1)</script><strong>kept</strong>',
    );
    expect(alertSpy).not.toHaveBeenCalled();
    // The bold text after the script must still be extracted.
    const boldKept = segments.find(
      (s) => s.text === 'kept' && s.bold === true,
    );
    expect(boldKept).toBeDefined();
  });

  it('returns a single empty segment for empty input', () => {
    expect(htmlToSegments('')).toEqual([{ text: '' }]);
  });

  it('preserves nested formatting (strong > em -> bold AND italic)', () => {
    const segments = htmlToSegments('<strong><em>both</em></strong>');
    expect(segments).toEqual([{ text: 'both', bold: true, italic: true }]);
  });
});

/**
 * TextEditor Component
 *
 * TipTap-based WYSIWYG editor for rich text content blocks.
 * Includes slash command support for block insertion.
 */

import { memo, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import type { RichTextSegment } from '../../../lib/content-blocks';
import { sanitizeHref } from '../../../lib/content-blocks';
import type { TextEditorProps } from './types';

// ==============================================================================
// TipTap Extensions Configuration
// ==============================================================================

const createEditorExtensions = (placeholder: string) => [
  StarterKit.configure({
    heading: {
      levels: [1, 2, 3],
    },
  }),
  Placeholder.configure({
    placeholder,
  }),
];

// ==============================================================================
// HTML <-> Segment Conversion
// ==============================================================================

/**
 * Convert RichTextSegments to TipTap HTML
 */
export function segmentsToHtml(segments: RichTextSegment[]): string {
  return segments
    .map((segment) => {
      let text = segment.text;
      if (segment.code) {
        text = `<code>${text}</code>`;
      }
      if (segment.bold) {
        text = `<strong>${text}</strong>`;
      }
      if (segment.italic) {
        text = `<em>${text}</em>`;
      }
      if (segment.href) {
        const safeHref = sanitizeHref(segment.href);
        if (safeHref) {
          text = `<a href="${safeHref}">${text}</a>`;
        }
      }
      return text;
    })
    .join('');
}

/**
 * Convert TipTap HTML to RichTextSegments
 *
 * Uses DOMParser ('text/html') instead of div.innerHTML to build the
 * tree. Per the HTML spec, parser-created documents have no browsing
 * context, so <script> contents are not executed and onload/onerror
 * handlers do not fire — even if a future TipTap extension or upstream
 * change widened the set of tags emitted into this function.
 */
export function htmlToSegments(html: string): RichTextSegment[] {
  if (!html) {
    return [{ text: '' }];
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(
    `<!DOCTYPE html><html><body>${html}</body></html>`,
    'text/html',
  );

  // text/html mode does not produce <parsererror>, but guard anyway.
  if (doc.querySelector('parsererror')) {
    return [{ text: html }];
  }

  const segments: RichTextSegment[] = [];

  function walk(node: Node, formatting: Partial<RichTextSegment> = {}) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      if (text) {
        segments.push({ text, ...formatting });
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      const newFormatting = { ...formatting };

      switch (el.tagName.toLowerCase()) {
        case 'strong':
        case 'b':
          newFormatting.bold = true;
          break;
        case 'em':
        case 'i':
          newFormatting.italic = true;
          break;
        case 'code':
          newFormatting.code = true;
          break;
        case 'a': {
          const rawHref = el.getAttribute('href');
          const href = rawHref ? (sanitizeHref(rawHref) ?? undefined) : undefined;
          newFormatting.href = href;
          break;
        }
      }

      for (const child of Array.from(node.childNodes)) {
        walk(child, newFormatting);
      }
    }
  }

  walk(doc.body);
  return segments.length > 0 ? segments : [{ text: '' }];
}

// ==============================================================================
// TextEditor Component
// ==============================================================================

export const TextEditor = memo(function TextEditor({
  content,
  onChange,
  placeholder = 'Type something...',
  onSlashCommand,
  onSlashQueryChange,
  onSlashCancel,
}: TextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const slashActiveRef = useRef(false);

  const editor = useEditor({
    extensions: createEditorExtensions(placeholder),
    content: `<p>${segmentsToHtml(content)}</p>`,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      // Extract content from paragraph wrapper
      const match = html.match(/<p>(.*)<\/p>/s);
      const innerHtml = match ? match[1] ?? '' : html;
      const text = editor.getText();
      
      // Check for slash command
      if (text.startsWith('/')) {
        if (!slashActiveRef.current && text === '/') {
          // Just typed "/", activate slash command
          slashActiveRef.current = true;
          // Get cursor position for menu
          const selection = window.getSelection();
          if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            onSlashCommand?.(rect);
          }
        } else if (slashActiveRef.current) {
          // Update query (text after /)
          const query = text.slice(1);
          onSlashQueryChange?.(query);
        }
      } else if (slashActiveRef.current) {
        // Slash was cleared (e.g., backspace)
        slashActiveRef.current = false;
        onSlashCancel?.();
      }
      
      onChange(htmlToSegments(innerHtml));
    },
  });

  return (
    <div className="text-editor" ref={editorRef}>
      <EditorContent editor={editor} />
    </div>
  );
});

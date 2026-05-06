import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { warn } = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('../src/lib/logger', () => ({
  createLogger: () => ({
    warn,
  }),
}));

import {
  ForbiddenTagError,
  PrivacyClassErrorBanner,
  canonicalizeFieldName,
} from '../src/components/Privacy/PrivacyClassErrorBanner';

describe('PrivacyClassErrorBanner', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    warn.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders a user-facing ForbiddenTag error and logs the canonical field name', () => {
    act(() => {
      root.render(createElement(PrivacyClassErrorBanner, {
        error: new ForbiddenTagError('EXIF Maker Note'),
      }));
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      'This photo contains an unsupported metadata field. Please remove the tag and re-upload.',
    );
    expect(alert?.textContent).toContain('exif-maker-note');
    expect(warn).toHaveBeenCalledWith(
      'Forbidden metadata tag rejected by sidecar decoder',
      { canonicalFieldName: 'exif-maker-note' },
    );
  });

  it('does not render for unrelated errors', () => {
    act(() => {
      root.render(createElement(PrivacyClassErrorBanner, { error: new Error('boom') }));
    });

    expect(container.textContent).toBe('');
    expect(warn).not.toHaveBeenCalled();
  });

  it('supports dismissing the placeholder sidecar decoder banner', () => {
    const onDismiss = vi.fn();
    act(() => {
      root.render(createElement(PrivacyClassErrorBanner, {
        error: new ForbiddenTagError('iptc:Legacy Field'),
        onDismiss,
      }));
    });

    const button = container.querySelector('button[aria-label="Dismiss metadata warning"]');
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('canonicalizes field names for support logs', () => {
    expect(canonicalizeFieldName('  XMP Custom Field!  ')).toBe('xmp-custom-field-');
  });
});

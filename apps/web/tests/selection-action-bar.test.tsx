import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AlbumPermissionsProvider,
  type AlbumPermissionsProviderProps,
} from '../src/contexts/AlbumPermissionsContext';
import { SelectionActionBar } from '../src/components/Gallery/SelectionActionBar';
import { AccessTier } from '../src/lib/api-types';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderActionBar(
  permissions: Omit<AlbumPermissionsProviderProps, 'children'>,
) {
  const props = {
    selectedCount: 2,
    isSelectionMode: true,
    onSelectAll: vi.fn(),
    onClearSelection: vi.fn(),
    onExitSelectionMode: vi.fn(),
    onDeleteSelected: vi.fn(),
    totalPhotos: 5,
    onDownloadSelected: vi.fn(),
  };

  act(() => {
    root.render(
      createElement(
        AlbumPermissionsProvider,
        permissions,
        createElement(SelectionActionBar, props),
      ),
    );
  });

  return {
    downloadButton: () =>
      container.querySelector('[data-testid="action-bar-download"]'),
    props,
  };
}

describe('SelectionActionBar download permission gating', () => {
  it('hides selected-photo download when permissions do not allow downloads', () => {
    const { downloadButton } = renderActionBar({
      role: 'anonymous',
      accessTier: AccessTier.PREVIEW,
    });

    expect(downloadButton()).toBeNull();
  });

  it('shows selected-photo download when permissions allow downloads', () => {
    const { downloadButton } = renderActionBar({
      role: 'anonymous',
      accessTier: AccessTier.FULL,
    });

    expect(downloadButton()).not.toBeNull();
  });
});

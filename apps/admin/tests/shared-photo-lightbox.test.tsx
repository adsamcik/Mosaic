/**
 * SharedPhotoLightbox Component Tests
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharedPhotoLightbox } from '../src/components/Shared/SharedPhotoLightbox';
import type { PhotoMeta } from '../src/workers/types';

// Mock crypto client
vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: vi.fn(() =>
    Promise.resolve({
      decryptShard: vi.fn(() => Promise.resolve(new Uint8Array(10))),
    })
  ),
}));

// Mock shard service
vi.mock('../src/lib/shard-service', () => ({
  downloadShardViaShareLink: vi.fn(() => Promise.resolve(new Uint8Array(10))),
}));

describe('SharedPhotoLightbox', () => {
  let container: HTMLElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
    }
    if (container) {
      container.remove();
    }
    container = null;
    root = null;
    vi.clearAllMocks();
  });

  const mockPhoto: PhotoMeta = {
    id: 'photo-1',
    filename: 'test.jpg',
    mimeType: 'image/jpeg',
    size: 1000,
    createdAt: new Date().toISOString(),
    width: 800,
    height: 600,
    epochId: 1,
    shardIds: ['shard-1'],
  };

  it('renders with correct backdrop class', () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    act(() => {
      root = createRoot(container!);
      root!.render(
        createElement(SharedPhotoLightbox, {
          photo: mockPhoto,
          linkId: 'link-1',
          tierKey: new Uint8Array(32),
          accessTier: 3,
          onClose: vi.fn(),
          hasNext: false,
          hasPrevious: false,
        })
      );
    });

    const lightbox = container.querySelector('[data-testid="shared-photo-lightbox"]');
    expect(lightbox).toBeTruthy();
    expect(lightbox?.className).toBe('lightbox-backdrop');
  });

  it('renders photo info correctly', () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    act(() => {
      root = createRoot(container!);
      root!.render(
        createElement(SharedPhotoLightbox, {
          photo: mockPhoto,
          linkId: 'link-1',
          tierKey: new Uint8Array(32),
          accessTier: 3,
          onClose: vi.fn(),
          hasNext: false,
          hasPrevious: false,
        })
      );
    });

    const filename = container.querySelector('.lightbox-filename');
    expect(filename?.textContent).toBe('test.jpg');
  });
});

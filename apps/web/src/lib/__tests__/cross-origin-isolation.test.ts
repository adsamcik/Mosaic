import { describe, expect, it } from 'vitest';
import {
  CROSS_ORIGIN_ISOLATION_DOCS_URL,
  renderStandalone,
} from '../../components/Errors/CrossOriginIsolationRequired';
import { isCrossOriginIsolationAvailable } from '../cross-origin-isolation';

describe('cross-origin-isolation boot guard', () => {
  it('requires cross-origin isolation unless the browser explicitly reports it', () => {
    expect(
      isCrossOriginIsolationAvailable({ crossOriginIsolated: true }),
    ).toBe(true);
    expect(
      isCrossOriginIsolationAvailable({ crossOriginIsolated: false }),
    ).toBe(false);
    expect(isCrossOriginIsolationAvailable(undefined)).toBe(false);
  });

  it('renders a standalone browser support error without app services', () => {
    const root = document.createElement('div');

    renderStandalone(root);

    expect(root.textContent).toContain(
      "Your browser doesn't support cross-origin isolation, which Mosaic requires for client-side encryption.",
    );
    expect(root.textContent).toContain('Safari 17.4+');
    expect(root.textContent).toContain('Chrome 102+');
    expect(root.querySelector('a')?.getAttribute('href')).toBe(
      CROSS_ORIGIN_ISOLATION_DOCS_URL,
    );
  });
});

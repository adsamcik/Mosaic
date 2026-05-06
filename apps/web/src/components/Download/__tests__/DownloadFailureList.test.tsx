import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadFailureList } from '../DownloadFailureList';
import { click, render, requireElement, textContent } from './DownloadTestUtils';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

const writeText = vi.fn<(_: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => document.body.replaceChildren());

describe('DownloadFailureList', () => {
  it('renders failure rows with translated reason codes', async () => {
    const rendered = await render(<DownloadFailureList failures={[{ photoIdShort: 'abc…123', errorCode: 'TransientNetwork', retryCount: 2, lastAttemptAtMs: 0 }]} />);
    expect(textContent(rendered.container)).toContain('Network issue, retrying');
    expect(textContent(rendered.container)).toContain('abc…123');
    await rendered.unmount();
  });

  it('copies the expected text representation', async () => {
    const rendered = await render(<DownloadFailureList failures={[{ photoIdShort: 'abc…123', errorCode: 'Integrity', retryCount: 1, lastAttemptAtMs: 0 }]} />);
    await click(requireElement(rendered.container.querySelector('button')));
    expect(writeText).toHaveBeenCalledWith('abc…123\tIntegrity\t1\t1970-01-01T00:00:00.000Z');
    await rendered.unmount();
  });
});

function translate(key: string, values?: Record<string, unknown>): string {
  const map: Record<string, string> = {
    'download.tray.failuresTitle': 'Download failures',
    'download.tray.copyFailures': 'Copy failure list',
    'download.tray.retryCount': '{{count}} retries',
    'download.errorCode.TransientNetwork': 'Network issue, retrying',
    'download.errorCode.Integrity': 'Damaged file',
    'common.copied': 'Copied',
  };
  let output = map[key] ?? String(values?.defaultValue ?? key);
  for (const [name, value] of Object.entries(values ?? {})) {
    output = output.replaceAll(`{{${name}}}`, String(value));
  }
  return output;
}

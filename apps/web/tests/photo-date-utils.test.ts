import { describe, expect, it, vi } from 'vitest';
import i18n from 'i18next';
import { formatDateHeader } from '../src/lib/photo-date-utils';

describe('photo-date-utils', () => {
  it('uses translation keys for invalid, today, and yesterday labels', () => {
    const t = vi.fn((key: string) => `translated:${key}`);
    const today = new Date().toDateString();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    expect(formatDateHeader('not-a-date', t)).toBe(
      'translated:gallery.date.unknown',
    );
    expect(formatDateHeader(today, t)).toBe('translated:gallery.date.today');
    expect(formatDateHeader(yesterday.toDateString(), t)).toBe(
      'translated:gallery.date.yesterday',
    );
  });

  it('formats non-relative dates with the active i18next locale', async () => {
    await i18n.init({
      lng: 'cs',
      fallbackLng: 'cs',
      resources: { cs: { translation: {} } },
    });

    const formatted = formatDateHeader('2024-01-06');

    expect(formatted).toMatch(/leden|led|sobota/i);
  });
});

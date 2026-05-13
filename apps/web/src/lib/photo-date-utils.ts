import i18n from 'i18next';
import type { PhotoMeta } from '../workers/types';

/** A translation function matching i18next's `t()` signature. */
export type TFunction = (key: string) => string;

/** A single date group: the date key string and its photos. */
export type DateGroup = [dateKey: string, photos: PhotoMeta[]];

/**
 * Group photos by date (newest first).
 *
 * Photos are sorted descending by `createdAt`, then bucketed
 * by local date string so each group represents one calendar day.
 * The returned array is sorted newest-date-first.
 */
export function groupPhotosByDate(photos: PhotoMeta[]): DateGroup[] {
  const groups: Record<string, PhotoMeta[]> = {};
  const sorted = [...photos].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  for (const photo of sorted) {
    const dateKey = new Date(photo.createdAt).toDateString();
    if (!groups[dateKey]) {
      groups[dateKey] = [];
    }
    groups[dateKey].push(photo);
  }

  return Object.entries(groups).sort(
    (a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime(),
  );
}

/**
 * Format a date string as a human-readable section header.
 *
 * Returns "Today" / "Yesterday" for recent dates, or a long-form
 * date like "Monday, Jan 6" (with year appended when not the current year).
 *
 * Pass a `t` function (from i18next) to get translated labels for
 * today/yesterday/unknown. If omitted, the active i18next instance is used.
 */
export function formatDateHeader(dateString: string, t?: TFunction): string {
  const translate = t ?? i18n.t.bind(i18n);
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return translate('gallery.date.unknown');

  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) {
    return translate('gallery.date.today');
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return translate('gallery.date.yesterday');
  }

  return new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
  }).format(date);
}

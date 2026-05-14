const MAX_FILENAME_BYTES = 1024;

/**
 * Normalize a filename for inclusion in the manifest.
 * - NFC-normalize to coalesce cross-platform forms (macOS NFD vs others NFC).
 * - Hard-cap to MAX_FILENAME_BYTES of UTF-8 to prevent buggy clients from
 *   inflating manifest size with megabyte-long names.
 * - Caller is responsible for any further sanitization for display.
 */
export function normalizeManifestFilename(raw: string): string {
  const normalized = raw.normalize('NFC');
  const bytes = new TextEncoder().encode(normalized);
  if (bytes.length <= MAX_FILENAME_BYTES) return normalized;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = MAX_FILENAME_BYTES; end >= 0; end--) {
    try {
      return decoder.decode(bytes.slice(0, end));
    } catch {
      // Try the previous byte until the slice ends at a valid UTF-8 boundary.
    }
  }
  return '';
}

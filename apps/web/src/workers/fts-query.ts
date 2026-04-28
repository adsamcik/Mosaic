/**
 * Build a safe SQLite FTS5 query from user-entered search text.
 *
 * FTS5 treats punctuation such as '-' as query operators outside quoted
 * phrases. Quote each whitespace-delimited term so filenames like
 * "zzz-nonexistent-xyz" are searched literally instead of parsed as
 * column/operator syntax.
 */
export function buildFtsSearchQuery(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ' ').trim())
    .filter((term) => term.length > 0)
    .map((term) => `"${term}"`)
    .join(' ');
}

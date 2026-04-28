import { describe, expect, it } from 'vitest';

import { buildFtsSearchQuery } from '../src/workers/fts-query';

describe('buildFtsSearchQuery', () => {
  it('quotes hyphenated terms so FTS5 treats them as literal search text', () => {
    expect(buildFtsSearchQuery('zzz-nonexistent-xyz')).toBe(
      '"zzz-nonexistent-xyz"',
    );
  });

  it('quotes each term and removes embedded quotes that would break phrase syntax', () => {
    expect(buildFtsSearchQuery('alpha "bravo" charlie')).toBe(
      '"alpha" "bravo" "charlie"',
    );
  });

  it('returns an empty query for whitespace-only input', () => {
    expect(buildFtsSearchQuery('   ')).toBe('');
  });
});

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('db worker sql.js module loader', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const workerSource = readFileSync(resolve(here, '../db.worker.ts'), 'utf8');
  const copySource = readFileSync(
    resolve(here, '../../../scripts/copy-sql-wasm.cjs'),
    'utf8',
  );

  it('imports the pinned FTS5 package instead of evaluating fetched source', () => {
    expect(workerSource).toContain("from 'fts5-sql-bundle'");
    expect(workerSource).not.toContain("fetch('/sql-wasm.js')");
    expect(workerSource).not.toContain('new Function');
    expect(workerSource).not.toContain('eval(');
  });

  it('publishes only the WASM binary as a runtime asset', () => {
    expect(copySource).toContain("const files = ['sql-wasm.wasm']");
    expect(copySource).toContain("fs.unlinkSync(obsoleteLoader)");
    expect(copySource).not.toContain("const files = ['sql-wasm.js'");
  });
});

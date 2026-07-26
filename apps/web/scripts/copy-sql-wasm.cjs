/**
 * Copy the FTS5 WASM binary to the public directory. The JavaScript loader is
 * bundled as a normal module by Vite, so no fetched source is evaluated.
 *
 * This script handles cases where npm has not fully extracted packages yet
 * (CI environments) and is idempotent.
 */
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'node_modules', 'fts5-sql-bundle', 'dist');
const destDir = path.join(__dirname, '..', 'public');
const files = ['sql-wasm.wasm'];

// Ensure public directory exists
if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

// Remove the legacy runtime-evaluated JavaScript asset left by older installs.
// Its loader is now bundled by Vite and must not be served independently.
const obsoleteLoader = path.join(destDir, 'sql-wasm.js');
if (fs.existsSync(obsoleteLoader)) {
  fs.unlinkSync(obsoleteLoader);
  console.log('[copy-sql-wasm] Removed obsolete sql-wasm.js');
}

// Check if the source directory exists. A later npm install/postinstall retries.
if (!fs.existsSync(srcDir)) {
  console.warn('[copy-sql-wasm] Warning: fts5-sql-bundle/dist not found. Files will be copied during build.');
  process.exit(0);
}

let copied = 0;
for (const file of files) {
  const src = path.join(srcDir, file);
  const dest = path.join(destDir, file);

  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`[copy-sql-wasm] Copied ${file}`);
    copied++;
  } else {
    console.warn(`[copy-sql-wasm] Warning: ${file} not found in fts5-sql-bundle/dist`);
  }
}

if (copied === 0) {
  console.warn('[copy-sql-wasm] No files copied. Ensure fts5-sql-bundle is properly installed.');
  process.exit(0);
}

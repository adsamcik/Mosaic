/**
 * Copy sql-wasm files from fts5-sql-bundle to public directory.
 * This script handles cases where npm hasn't fully extracted packages yet (CI environments).
 */
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'node_modules', 'fts5-sql-bundle', 'dist');
const destDir = path.join(__dirname, '..', 'public');
const files = ['sql-wasm.js', 'sql-wasm.wasm'];

// Ensure public directory exists
if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

// Check if source directory exists
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
}

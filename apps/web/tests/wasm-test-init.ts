import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import initRustWasm, { initSync } from '../src/generated/mosaic-wasm/mosaic_wasm.js';

const WASM_BYTES_PATH = resolve(
  process.cwd(),
  'src',
  'generated',
  'mosaic-wasm',
  'mosaic_wasm_bg.wasm',
);

export async function initializeRustWasmForTests(): Promise<void> {
  initSync({ module: readFileSync(WASM_BYTES_PATH) });
  await initRustWasm();
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi } from 'vitest';

const WASM_BYTES_PATH = resolve(
  process.cwd(),
  'src',
  'generated',
  'mosaic-wasm',
  'mosaic_wasm_bg.wasm',
);

let wasmInitPromise: Promise<void> | null = null;

export async function initializeRustWasmForTests(): Promise<void> {
  wasmInitPromise ??= (async () => {
    vi.unmock('../src/generated/mosaic-wasm/mosaic_wasm.js');
    const { default: initRustWasm, initSync } = await import(
      '../src/generated/mosaic-wasm/mosaic_wasm.js'
    );

    initSync({ module: readFileSync(WASM_BYTES_PATH) });
    await initRustWasm();
  })().catch((error: unknown) => {
    wasmInitPromise = null;
    throw error;
  });

  await wasmInitPromise;
}

import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => ({
  initRustWasm: vi.fn().mockResolvedValue(undefined),
  blake2bScopeKey16: vi.fn((input: Uint8Array) => {
    const out = new Uint8Array(16);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = input[i % input.byteLength] ?? i;
    }
    return out;
  }),
}));

vi.mock('../../generated/mosaic-wasm/mosaic_wasm.js', () => ({
  default: wasmMocks.initRustWasm,
  blake2bScopeKey16: wasmMocks.blake2bScopeKey16,
}));

const text = new TextEncoder();
const domainTag = text.encode('mosaic-tray-scope-v1');

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function loadScopeKeyModule(): Promise<typeof import('../scope-key')> {
  return import('../scope-key');
}

describe('scope-key Rust migration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('requires callers to initialize Rust WASM before synchronous derivation', async () => {
    const scope = await loadScopeKeyModule();

    expect(() => scope.deriveAuthScopeKey('account-a')).toThrow(/Rust WASM is not initialized/u);
    await scope.ensureScopeKeySodiumReady();
    expect(() => scope.deriveAuthScopeKey('account-a')).not.toThrow();
  });

  it('derives authenticated-user scope keys through the Rust BLAKE2b helper', async () => {
    const scope = await loadScopeKeyModule();
    await scope.ensureScopeKeySodiumReady();
    const input = concatBytes([text.encode('account-a'), domainTag]);
    const expectedDigest = wasmMocks.blake2bScopeKey16(input);
    wasmMocks.blake2bScopeKey16.mockClear();

    const key = scope.deriveAuthScopeKey('account-a');

    expect(key).toBe(`auth:${hex(expectedDigest)}`);
    expect(wasmMocks.initRustWasm).toHaveBeenCalledTimes(1);
    expect(wasmMocks.blake2bScopeKey16).toHaveBeenCalledWith(input);
  });

  it('derives visitor scope keys with separator and null-empty grant collapse', async () => {
    const scope = await loadScopeKeyModule();
    await scope.ensureScopeKeySodiumReady();

    const nullGrant = scope.deriveVisitorScopeKey('link-a', null);
    const emptyGrant = scope.deriveVisitorScopeKey('link-a', '');

    expect(nullGrant).toBe(emptyGrant);
    expect(wasmMocks.blake2bScopeKey16).toHaveBeenLastCalledWith(
      concatBytes([
        text.encode('link-a'),
        new Uint8Array([0x00]),
        text.encode(''),
        domainTag,
      ]),
    );
  });
});

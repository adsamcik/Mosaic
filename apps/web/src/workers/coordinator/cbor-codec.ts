/**
 * Minimal CBOR encoder/decoder used by the coordinator worker for snapshot
 * and event serialization. Extracted from `coordinator.worker.ts` (Sweep 39).
 *
 * Supports the narrow CBOR subset used by the Rust download snapshot format:
 *   - unsigned integers (major 0)
 *   - byte strings (major 2)
 *   - text strings (major 3)
 *   - arrays (major 4)
 *   - maps (major 5)
 *   - booleans + null (major 7)
 *
 * This is intentionally *not* a general-purpose CBOR library — anything outside
 * this subset throws.
 */

export type CborValue =
  | { readonly kind: 'uint'; readonly value: number }
  | { readonly kind: 'bytes'; readonly value: Uint8Array }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'array'; readonly value: CborValue[] }
  | { readonly kind: 'map'; readonly value: CborMapEntry[] }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'null' };

export interface CborMapEntry {
  readonly key: CborValue;
  readonly value: CborValue;
}

export function parseCbor(bytes: Uint8Array): CborValue {
  const parser = new CborParser(bytes);
  const value = parser.readValue();
  parser.assertDone();
  return value;
}

class CborParser {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  readValue(): CborValue {
    const initial = this.readByte();
    const major = initial >> 5;
    const additional = initial & 0x1f;
    switch (major) {
      case 0:
        return uintValue(this.readLength(additional));
      case 2:
        return { kind: 'bytes', value: this.readBytes(this.readLength(additional)) };
      case 3:
        return { kind: 'text', value: new TextDecoder().decode(this.readBytes(this.readLength(additional))) };
      case 4: {
        const length = this.readLength(additional);
        const items: CborValue[] = [];
        for (let index = 0; index < length; index += 1) {
          items.push(this.readValue());
        }
        return { kind: 'array', value: items };
      }
      case 5: {
        const length = this.readLength(additional);
        const entries: CborMapEntry[] = [];
        for (let index = 0; index < length; index += 1) {
          entries.push({ key: this.readValue(), value: this.readValue() });
        }
        return { kind: 'map', value: entries };
      }
      case 7:
        if (additional === 20 || additional === 21) {
          return { kind: 'bool', value: additional === 21 };
        }
        if (additional === 22) {
          return { kind: 'null' };
        }
        break;
    }
    throw new Error('Unsupported CBOR value');
  }

  assertDone(): void {
    if (this.offset !== this.bytes.length) {
      throw new Error('Trailing CBOR bytes');
    }
  }

  private readByte(): number {
    const byte = this.bytes[this.offset];
    if (byte === undefined) {
      throw new Error('Unexpected end of CBOR');
    }
    this.offset += 1;
    return byte;
  }

  private readLength(additional: number): number {
    if (additional < 24) {
      return additional;
    }
    if (additional === 24) {
      return this.readByte();
    }
    if (additional === 25) {
      return this.readUnsigned(2);
    }
    if (additional === 26) {
      return this.readUnsigned(4);
    }
    if (additional === 27) {
      return this.readUnsigned(8);
    }
    throw new Error('Unsupported CBOR length');
  }

  private readUnsigned(length: number): number {
    let value = 0;
    for (let index = 0; index < length; index += 1) {
      value = value * 256 + this.readByte();
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error('CBOR integer exceeds safe range');
    }
    return value;
  }

  private readBytes(length: number): Uint8Array {
    const end = this.offset + length;
    if (end > this.bytes.length) {
      throw new Error('Unexpected end of CBOR bytes');
    }
    const out = this.bytes.slice(this.offset, end);
    this.offset = end;
    return out;
  }
}

export function encodeCbor(value: CborValue): Uint8Array {
  switch (value.kind) {
    case 'uint':
      return cborTypeAndLength(0, value.value);
    case 'bytes':
      return concatBytes([cborTypeAndLength(2, value.value.length), value.value]);
    case 'text': {
      const encoded = new TextEncoder().encode(value.value);
      return concatBytes([cborTypeAndLength(3, encoded.length), encoded]);
    }
    case 'array':
      return concatBytes([cborTypeAndLength(4, value.value.length), ...value.value.map(encodeCbor)]);
    case 'map': {
      const parts: Uint8Array[] = [cborTypeAndLength(5, value.value.length)];
      for (const entry of value.value) {
        parts.push(encodeCbor(entry.key), encodeCbor(entry.value));
      }
      return concatBytes(parts);
    }
    case 'bool':
      return new Uint8Array([value.value ? 0xf5 : 0xf4]);
    case 'null':
      return new Uint8Array([0xf6]);
  }
}

function cborTypeAndLength(major: number, length: number): Uint8Array {
  if (length < 24) {
    return new Uint8Array([(major << 5) | length]);
  }
  if (length <= 0xff) {
    return new Uint8Array([(major << 5) | 24, length]);
  }
  if (length <= 0xffff) {
    return new Uint8Array([(major << 5) | 25, length >> 8, length & 0xff]);
  }
  if (length <= 0xffffffff) {
    return new Uint8Array([
      (major << 5) | 26,
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
    ]);
  }
  if (Number.isSafeInteger(length) && length >= 0) {
    let remaining = BigInt(length);
    const bytes = new Uint8Array(9);
    bytes[0] = (major << 5) | 27;
    for (let index = 8; index >= 1; index -= 1) {
      bytes[index] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    return bytes;
  }
  throw new Error('CBOR length too large');
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function expectMap(value: CborValue): CborMapEntry[] {
  if (value.kind !== 'map') {
    throw new Error('Expected CBOR map');
  }
  return value.value;
}

export function expectArray(value: CborValue): CborValue[] {
  if (value.kind !== 'array') {
    throw new Error('Expected CBOR array');
  }
  return value.value;
}

export function expectText(value: CborValue): string {
  if (value.kind !== 'text') {
    throw new Error('Expected CBOR text');
  }
  return value.value;
}

export function expectBytes(value: CborValue): Uint8Array {
  if (value.kind !== 'bytes') {
    throw new Error('Expected CBOR bytes');
  }
  return value.value;
}

export function expectUint(value: CborValue): number {
  if (value.kind !== 'uint') {
    throw new Error('Expected CBOR uint');
  }
  return value.value;
}

export function requiredMapValue(entries: readonly CborMapEntry[], key: number): CborValue {
  const entry = entries.find((candidate) => candidate.key.kind === 'uint' && candidate.key.value === key);
  if (!entry) {
    throw new Error('Missing CBOR map key');
  }
  return entry.value;
}

export function optionalMapValue(entries: readonly CborMapEntry[], key: number): CborValue | null {
  const entry = entries.find((candidate) => candidate.key.kind === 'uint' && candidate.key.value === key);
  return entry ? entry.value : null;
}

export function uintValue(value: number): CborValue {
  return { kind: 'uint', value };
}

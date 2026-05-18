/**
 * Coordinator job id / hex helpers. Extracted from `coordinator.worker.ts`
 * (Sweep 39). Pure utility module — no side effects.
 */

export const JOB_ID_HEX_BYTES = 16;

export function randomJobIdBytes(): Uint8Array {
  const bytes = new Uint8Array(JOB_ID_HEX_BYTES);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function hexToJobIdBytes(hex: string): Uint8Array {
  if (hex.length !== JOB_ID_HEX_BYTES * 2) {
    throw new Error('Invalid job id hex length');
  }
  const bytes = new Uint8Array(JOB_ID_HEX_BYTES);
  for (let i = 0; i < JOB_ID_HEX_BYTES; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function uuidBytesToString(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new Error('UUID byte length must be 16');
  }
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

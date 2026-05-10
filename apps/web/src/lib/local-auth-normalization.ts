/**
 * Normalizes password text before any password-rooted KDF.
 *
 * NFKC keeps canonically equivalent user input on one byte representation so
 * visually identical passwords derive the same key across web, Android, and
 * Rust clients.
 */
export function normalizePasswordForKdf(password: string): Uint8Array {
  return new TextEncoder().encode(password.normalize('NFKC'));
}

/**
 * Encodes passwords exactly as the pre-NFKC v1 salt KDF did.
 *
 * Security/backcompat: this raw UTF-8 path exists only to open already-stored
 * v1 salt envelopes that were encrypted before password normalization shipped.
 * New password-rooted KDFs must use {@link normalizePasswordForKdf} instead.
 */
export function encodeLegacyPasswordForKdfCompatibility(
  password: string,
): Uint8Array {
  return new TextEncoder().encode(password);
}

/**
 * Sign in with Apple replay protection. The app makes a random nonce, gives Apple its SHA-256
 * (Apple embeds that hash in the identity token) and gives Supabase the raw nonce, which hashes
 * it again and compares (`skip_nonce_check = false` in supabase/config.toml). A stolen identity
 * token therefore cannot be replayed through our sign-in. Pure helpers here; the random bytes and
 * the hash come from expo-crypto in lib/auth.tsx.
 */

/** Bytes of randomness per nonce (128 bits); Apple accepts any string, Firebase/Supabase use 32 hex chars. */
export const NONCE_BYTES = 16;

/** Lower-case hex of the given bytes; the nonce string Apple and Supabase both see. */
export function nonceFromBytes(bytes: Uint8Array): string {
  if (bytes.length < NONCE_BYTES) throw new Error(`nonce needs at least ${NONCE_BYTES} random bytes`);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** True when `s` looks like a nonce this module produced (hex, at least 32 chars). */
export function isWellFormedNonce(s: string): boolean {
  return /^[0-9a-f]{32,}$/.test(s);
}

/** What Supabase's nonce check compares against: SHA-256 of the raw nonce, lower-case hex. */
export function isWellFormedSha256Hex(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

import { describe, expect, it } from 'vitest';
import { NONCE_BYTES, isWellFormedNonce, isWellFormedSha256Hex, nonceFromBytes } from './appleNonce';

/** Web Crypto (Node 20+ global), the same primitive expo-crypto's digestStringAsync wraps on device. */
async function sha256Hex(s: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('Sign in with Apple nonce', () => {
  it('turns 16 random bytes into 32 lower-case hex characters', () => {
    const bytes = Uint8Array.from({ length: NONCE_BYTES }, (_, i) => i * 17);
    const n = nonceFromBytes(bytes);
    expect(n).toHaveLength(32);
    expect(n).toBe('00112233445566778899aabbccddeeff');
    expect(isWellFormedNonce(n)).toBe(true);
  });

  it('is deterministic for the same bytes and different for different bytes', () => {
    const a = Uint8Array.from({ length: 16 }, () => 7);
    const b = Uint8Array.from({ length: 16 }, () => 8);
    expect(nonceFromBytes(a)).toBe(nonceFromBytes(a));
    expect(nonceFromBytes(a)).not.toBe(nonceFromBytes(b));
  });

  it('refuses too little randomness', () => {
    expect(() => nonceFromBytes(new Uint8Array(8))).toThrow(/16 random bytes/);
  });

  it('the hash Apple receives is SHA-256 hex of the raw nonce (what Supabase recomputes)', async () => {
    const raw = nonceFromBytes(Uint8Array.from({ length: 16 }, (_, i) => 255 - i));
    const hashed = await sha256Hex(raw);
    expect(isWellFormedSha256Hex(hashed)).toBe(true);
    expect(hashed).not.toBe(raw);
    expect(isWellFormedSha256Hex(raw)).toBe(false);
    expect(isWellFormedNonce('not hex!')).toBe(false);
  });
});

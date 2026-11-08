/**
 * Chunked key-value storage for expo-secure-store.
 *
 * SecureStore caps each value at 2048 bytes (iOS logs a warning and newer SDKs reject; Android
 * fails). A Supabase session JSON (access + refresh token + user) is 2.5 to 4 KB, so it must be
 * split. Values that fit are stored as-is; bigger ones are stored as a marker `__chunks__:<n>`
 * under the key plus n chunk keys `<key>.__chunk<i>`, each at most CHUNK_BYTES of UTF-8.
 *
 * Pure: no React Native imports, so the splitting and the store wrapper are unit tested.
 */

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Keeps every stored value under SecureStore's 2048-byte limit with headroom for encoding overhead. */
export const CHUNK_BYTES = 1900;

const MARKER_PREFIX = '__chunks__:';

export function chunkKey(key: string, index: number): string {
  return `${key}.__chunk${index}`;
}

export function isChunkMarker(value: string): boolean {
  return parseChunkMarker(value) !== null;
}

/** Number of chunks a marker announces, or null if the value is a plain (unchunked) value. */
export function parseChunkMarker(value: string): number | null {
  if (!value.startsWith(MARKER_PREFIX)) return null;
  const rest = value.slice(MARKER_PREFIX.length);
  if (!/^[1-9]\d*$/.test(rest)) return null;
  return Number(rest);
}

function codePointBytes(cp: number): number {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

export function utf8ByteLength(s: string): number {
  let n = 0;
  for (const ch of s) n += codePointBytes(ch.codePointAt(0)!);
  return n;
}

/** Split by code points so no chunk exceeds `maxBytes` of UTF-8 and no surrogate pair is cut. */
export function splitUtf8(s: string, maxBytes: number): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive integer');
  if (utf8ByteLength(s) <= maxBytes) return [s];
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of s) {
    const b = codePointBytes(ch.codePointAt(0)!);
    if (b > maxBytes) throw new RangeError(`a ${b}-byte code point does not fit in ${maxBytes} bytes`);
    if (bytes + b > maxBytes) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += b;
  }
  parts.push(current);
  return parts;
}

export function joinChunks(parts: readonly string[]): string {
  return parts.join('');
}

/**
 * Wraps a store so values of any size round-trip. Reads of a torn value (marker present, a chunk
 * missing) return null rather than a truncated string, which makes supabase-js treat the session
 * as absent instead of corrupt. Writes replace the marker last and delete chunks a shorter value
 * no longer needs.
 */
export function createChunkedStore(inner: KeyValueStore, maxBytes: number = CHUNK_BYTES): KeyValueStore {
  const chunkCount = async (key: string): Promise<number> => {
    const head = await inner.getItem(key);
    return head === null ? 0 : (parseChunkMarker(head) ?? 0);
  };

  return {
    async getItem(key) {
      const head = await inner.getItem(key);
      if (head === null) return null;
      const n = parseChunkMarker(head);
      if (n === null) return head;
      const parts: string[] = [];
      for (let i = 0; i < n; i += 1) {
        const part = await inner.getItem(chunkKey(key, i));
        if (part === null) return null;
        parts.push(part);
      }
      return joinChunks(parts);
    },

    async setItem(key, value) {
      const previous = await chunkCount(key);
      const parts = splitUtf8(value, maxBytes);
      if (parts.length === 1) {
        await inner.setItem(key, value);
      } else {
        for (let i = 0; i < parts.length; i += 1) await inner.setItem(chunkKey(key, i), parts[i]!);
        await inner.setItem(key, `${MARKER_PREFIX}${parts.length}`);
      }
      const keep = parts.length === 1 ? 0 : parts.length;
      for (let i = keep; i < previous; i += 1) await inner.removeItem(chunkKey(key, i));
    },

    async removeItem(key) {
      const previous = await chunkCount(key);
      await inner.removeItem(key);
      for (let i = 0; i < previous; i += 1) await inner.removeItem(chunkKey(key, i));
    },
  };
}

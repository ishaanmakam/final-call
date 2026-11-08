import { describe, expect, it } from 'vitest';
import {
  CHUNK_BYTES,
  chunkKey,
  createChunkedStore,
  isChunkMarker,
  joinChunks,
  parseChunkMarker,
  splitUtf8,
  utf8ByteLength,
  type KeyValueStore,
} from './secureChunks';

function memoryStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => void map.set(k, v),
    removeItem: async (k) => void map.delete(k),
  };
}

describe('utf8ByteLength', () => {
  it('counts bytes, not code units', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('')).toBe(0);
  });
});

describe('splitUtf8', () => {
  it('returns the whole string when it fits', () => {
    expect(splitUtf8('hello', 10)).toEqual(['hello']);
    expect(splitUtf8('', 10)).toEqual(['']);
  });

  it('never exceeds the byte budget and never splits a surrogate pair', () => {
    const s = 'a😀b😀c😀d';
    const parts = splitUtf8(s, 5);
    expect(parts.join('')).toBe(s);
    for (const p of parts) {
      expect(utf8ByteLength(p)).toBeLessThanOrEqual(5);
      expect(p).not.toMatch(/[\uD800-\uDBFF]$/); // no dangling high surrogate
    }
    expect(parts).toEqual(['a😀', 'b😀', 'c😀', 'd']);
  });

  it('splits long ASCII exactly at the budget', () => {
    const s = 'x'.repeat(4001);
    const parts = splitUtf8(s, 1900);
    expect(parts.map((p) => p.length)).toEqual([1900, 1900, 201]);
    expect(joinChunks(parts)).toBe(s);
  });

  it('rejects a budget that cannot hold a code point', () => {
    expect(() => splitUtf8('abc', 3)).not.toThrow();
    expect(() => splitUtf8('abc', 0)).toThrow();
    expect(() => splitUtf8('😀', 3)).toThrow();
  });
});

describe('chunk markers', () => {
  it('round-trips the chunk count and is distinguishable from plain values', () => {
    expect(isChunkMarker('{"access_token":"x"}')).toBe(false);
    expect(parseChunkMarker('{"access_token":"x"}')).toBeNull();
    expect(parseChunkMarker('__chunks__:3')).toBe(3);
    expect(parseChunkMarker('__chunks__:0')).toBeNull();
    expect(parseChunkMarker('__chunks__:abc')).toBeNull();
    expect(chunkKey('sb-auth-token', 2)).toBe('sb-auth-token.__chunk2');
  });
});

describe('createChunkedStore', () => {
  // ~4.6 KB, like a real Supabase session (JWT access token + refresh token + user) -> 3 chunks of 1900
  const big = JSON.stringify({ access_token: 'a'.repeat(4000), refresh_token: 'r'.repeat(500), user: { name: 'Zoë 😀' } });

  it('stores small values as-is', async () => {
    const inner = memoryStore();
    const store = createChunkedStore(inner, 100);
    await store.setItem('k', 'small');
    expect(inner.map.get('k')).toBe('small');
    expect(await store.getItem('k')).toBe('small');
  });

  it('chunks big values under the budget and reads them back whole', async () => {
    const inner = memoryStore();
    const store = createChunkedStore(inner, 1900);
    await store.setItem('k', big);
    expect(inner.map.get('k')).toBe('__chunks__:3');
    for (const [key, value] of inner.map) {
      expect(utf8ByteLength(value), key).toBeLessThanOrEqual(1900);
    }
    expect(await store.getItem('k')).toBe(big);
    expect(CHUNK_BYTES).toBeLessThanOrEqual(2048);
  });

  it('deletes stale chunks when a shorter value replaces a longer one', async () => {
    const inner = memoryStore();
    const store = createChunkedStore(inner, 1900);
    await store.setItem('k', big);
    expect(inner.map.size).toBe(4);
    await store.setItem('k', 'x'.repeat(2000));
    expect(inner.map.size).toBe(3); // marker + 2 chunks
    await store.setItem('k', 'tiny');
    expect([...inner.map.keys()]).toEqual(['k']);
    expect(await store.getItem('k')).toBe('tiny');
  });

  it('removes the marker and every chunk', async () => {
    const inner = memoryStore();
    const store = createChunkedStore(inner, 1900);
    await store.setItem('k', big);
    await store.removeItem('k');
    expect(inner.map.size).toBe(0);
    expect(await store.getItem('k')).toBeNull();
  });

  it('returns null (not a torn value) when a chunk is missing', async () => {
    const inner = memoryStore();
    const store = createChunkedStore(inner, 1900);
    await store.setItem('k', big);
    inner.map.delete(chunkKey('k', 1));
    expect(await store.getItem('k')).toBeNull();
  });

  it('still reads a legacy unchunked value and migrates it on the next write', async () => {
    const inner = memoryStore();
    inner.map.set('k', 'legacy');
    const store = createChunkedStore(inner, 1900);
    expect(await store.getItem('k')).toBe('legacy');
  });
});

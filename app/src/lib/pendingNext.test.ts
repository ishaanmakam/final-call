import { describe, expect, it } from 'vitest';
import { PENDING_NEXT_KEY, PENDING_NEXT_TTL_MS, createPendingNextStore, type KeyValueStore } from './pendingNext';

function memory(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => void map.set(k, v),
    removeItem: async (k) => void map.delete(k),
  };
}

const T0 = Date.UTC(2026, 10, 7, 12);

describe('pending next (magic-link round trip)', () => {
  it('parks an in-app path and hands it back once', async () => {
    const kv = memory();
    const store = createPendingNextStore(kv);
    await store.set('/join/KANE9AM', T0);
    expect(kv.map.has(PENDING_NEXT_KEY)).toBe(true);
    expect(await store.take(T0 + 60_000)).toBe('/join/KANE9AM');
    expect(await store.take(T0 + 60_000)).toBe('/groups');
    expect(kv.map.has(PENDING_NEXT_KEY)).toBe(false);
  });

  it('falls back to /groups when nothing is parked', async () => {
    expect(await createPendingNextStore(memory()).take()).toBe('/groups');
  });

  it('parks nothing for the default or an unsafe destination, and clears a stale one', async () => {
    const kv = memory();
    const store = createPendingNextStore(kv);
    await store.set('/join/OLD', T0);
    await store.set('https://evil.example', T0);
    expect(kv.map.has(PENDING_NEXT_KEY)).toBe(false);
    await store.set(undefined, T0);
    expect(kv.map.has(PENDING_NEXT_KEY)).toBe(false);
    await store.set('/sign-in?next=/groups', T0);
    expect(kv.map.has(PENDING_NEXT_KEY)).toBe(false);
  });

  it('expires with the link: an hour-old destination is dropped', async () => {
    const kv = memory();
    const store = createPendingNextStore(kv);
    await store.set('/groups/g1', T0);
    expect(await store.take(T0 + PENDING_NEXT_TTL_MS + 1)).toBe('/groups');
    await store.set('/groups/g1', T0);
    expect(await store.take(T0 + PENDING_NEXT_TTL_MS - 1)).toBe('/groups/g1');
  });

  it('survives a clock that moved backwards and corrupt storage', async () => {
    const kv = memory();
    const store = createPendingNextStore(kv);
    await store.set('/groups/g1', T0);
    expect(await store.take(T0 - 1)).toBe('/groups');
    kv.map.set(PENDING_NEXT_KEY, '{not json');
    expect(await store.take()).toBe('/groups');
    kv.map.set(PENDING_NEXT_KEY, JSON.stringify({ next: '//evil.example', at: T0 }));
    expect(await store.take(T0)).toBe('/groups');
  });

  it('clear forgets the parked destination', async () => {
    const kv = memory();
    const store = createPendingNextStore(kv);
    await store.set('/groups/g1', T0);
    await store.clear();
    expect(await store.take(T0)).toBe('/groups');
  });
});

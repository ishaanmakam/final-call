/**
 * Where to go after a magic link completes (A5). The invite flow is: open `showup://join/CODE` →
 * sign-in?next=/join/CODE → email → `showup://auth-callback?code=…`. The callback URL cannot carry
 * `next` (Supabase only keeps allow-listed redirect URLs), so the sign-in screen parks it here
 * before sending the link and the callback takes it back out, once.
 *
 * Pure store over a tiny key-value adapter so the behaviour is unit-tested; the app wires it to
 * AsyncStorage below.
 */
import { safeNext } from '../features/auth/magicLink';

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const PENDING_NEXT_KEY = 'showup.pendingNext';

/** How long a parked destination stays valid: a magic link itself expires after an hour. */
export const PENDING_NEXT_TTL_MS = 60 * 60_000;

export interface PendingNextStore {
  /** Remember where to land after the link; a default or unsafe path parks nothing. */
  set(next: string | string[] | undefined, nowMs?: number): Promise<void>;
  /** The parked destination (or `/groups`), cleared on read so it is used once. */
  take(nowMs?: number): Promise<string>;
  clear(): Promise<void>;
}

interface Parked {
  next: string;
  at: number;
}

export function createPendingNextStore(kv: KeyValueStore): PendingNextStore {
  return {
    async set(next, nowMs = Date.now()) {
      const safe = safeNext(next);
      if (safe === '/groups') {
        await kv.removeItem(PENDING_NEXT_KEY);
        return;
      }
      const parked: Parked = { next: safe, at: nowMs };
      await kv.setItem(PENDING_NEXT_KEY, JSON.stringify(parked));
    },
    async take(nowMs = Date.now()) {
      const raw = await kv.getItem(PENDING_NEXT_KEY);
      await kv.removeItem(PENDING_NEXT_KEY);
      if (!raw) return '/groups';
      try {
        const parked = JSON.parse(raw) as Partial<Parked>;
        if (typeof parked.next !== 'string' || typeof parked.at !== 'number') return '/groups';
        if (nowMs - parked.at > PENDING_NEXT_TTL_MS || nowMs < parked.at) return '/groups';
        return safeNext(parked.next);
      } catch {
        return '/groups';
      }
    },
    async clear() {
      await kv.removeItem(PENDING_NEXT_KEY);
    },
  };
}

import { describe, expect, it } from 'vitest';
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  CheckinQueue,
  MAX_AGE_MS,
  MAX_PER_INSTANCE,
  attemptKey,
  backoffDelay,
  deserializeQueue,
  dueEntries,
  enqueue,
  nextWakeAt,
  pruneExpired,
  recordRetry,
  serializeQueue,
  wakeAll,
  type CheckinAttempt,
  type QueueEvent,
  type QueueStorage,
  type SendOutcome,
} from './checkinQueue';

const T0 = Date.parse('2026-11-09T16:59:30Z');

function attempt(overrides: Partial<CheckinAttempt> = {}): CheckinAttempt {
  return {
    instanceId: 'inst-1',
    lat: 47.6553,
    lng: -122.3035,
    accuracyM: 12,
    clientCapturedAt: '2026-11-09T16:59:28.000Z',
    isSimulated: false,
    ...overrides,
  };
}

class MemoryStorage implements QueueStorage {
  value: string | null = null;
  saves = 0;
  async load() {
    return this.value;
  }
  async save(v: string) {
    this.value = v;
    this.saves += 1;
  }
}

describe('pure queue operations', () => {
  it('dedupes the same fix for the same instance', () => {
    let q = enqueue([], attempt(), T0).queue;
    const again = enqueue(q, attempt(), T0 + 1000);
    expect(again.added).toBe(false);
    expect(again.queue).toHaveLength(1);
    q = enqueue(q, attempt({ clientCapturedAt: '2026-11-09T16:59:40.000Z' }), T0).queue;
    expect(q).toHaveLength(2);
    expect(attemptKey(attempt())).toBe('inst-1@2026-11-09T16:59:28.000Z');
  });

  it('normalizes equivalent timestamps when deduping', () => {
    const q = enqueue([], attempt({ clientCapturedAt: '2026-11-09T16:59:28Z' }), T0).queue;
    expect(enqueue(q, attempt({ clientCapturedAt: '2026-11-09T16:59:28.000Z' }), T0).added).toBe(false);
  });

  it(`caps attempts per instance at ${MAX_PER_INSTANCE}`, () => {
    let q: ReturnType<typeof enqueue>['queue'] = [];
    for (let i = 0; i < MAX_PER_INSTANCE + 3; i += 1) {
      q = enqueue(q, attempt({ clientCapturedAt: new Date(T0 - 60_000 + i * 1000).toISOString() }), T0).queue;
    }
    expect(q).toHaveLength(MAX_PER_INSTANCE);
    // the earliest captures are kept, since they are the ones most likely to beat the deadline
    expect(q[0]?.clientCapturedAt).toBe(new Date(T0 - 60_000).toISOString());
  });

  it('preserves the fix time exactly, never the enqueue time', () => {
    const q = enqueue([], attempt(), T0 + 3_600_000).queue;
    expect(q[0]?.clientCapturedAt).toBe('2026-11-09T16:59:28.000Z');
    expect(q[0]?.enqueuedAt).toBe(T0 + 3_600_000);
  });

  it('drops attempts whose fix is older than 24h', () => {
    const q = enqueue([], attempt(), T0).queue;
    const captured = Date.parse(q[0]!.clientCapturedAt);
    expect(pruneExpired(q, captured + MAX_AGE_MS).kept).toHaveLength(1);
    const pruned = pruneExpired(q, captured + MAX_AGE_MS + 1);
    expect(pruned.kept).toHaveLength(0);
    expect(pruned.expired).toHaveLength(1);
  });

  it('backs off exponentially up to a cap', () => {
    expect(backoffDelay(0)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelay(1)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffDelay(3)).toBe(BACKOFF_BASE_MS * 8);
    expect(backoffDelay(50)).toBe(BACKOFF_MAX_MS);
  });

  it('schedules retries and wakes everything on demand', () => {
    let q = enqueue([], attempt(), T0).queue;
    const key = q[0]!.key;
    expect(dueEntries(q, T0)).toHaveLength(1);
    q = recordRetry(q, key, T0, 'offline');
    expect(q[0]?.attempts).toBe(1);
    expect(q[0]?.lastError).toBe('offline');
    expect(dueEntries(q, T0)).toHaveLength(0);
    expect(nextWakeAt(q)).toBe(T0 + BACKOFF_BASE_MS);
    q = wakeAll(q, T0 + 10);
    expect(dueEntries(q, T0 + 10)).toHaveLength(1);
    expect(nextWakeAt([])).toBeNull();
  });

  it('round-trips through serialization and survives corrupt storage', () => {
    const q = enqueue([], attempt(), T0).queue;
    expect(deserializeQueue(serializeQueue(q))).toEqual(q);
    expect(deserializeQueue(null)).toEqual([]);
    expect(deserializeQueue('not json')).toEqual([]);
    expect(deserializeQueue('{"v":1,"items":[{"bogus":true}]}')).toEqual([]);
  });
});

describe('CheckinQueue', () => {
  function setup(outcomes: Array<SendOutcome<string>>) {
    const storage = new MemoryStorage();
    let now = T0;
    const sent: CheckinAttempt[] = [];
    const events: QueueEvent<string>[] = [];
    const queue = new CheckinQueue<string>({
      storage,
      now: () => now,
      send: async (a) => {
        sent.push(a);
        const next = outcomes.shift();
        if (!next) throw new Error('unexpected send');
        return next;
      },
      onEvent: (e) => events.push(e),
    });
    return {
      storage,
      queue,
      sent,
      events,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('retries network failures with backoff and sends the original client time', async () => {
    const t = setup([
      { kind: 'retry', error: 'Network request failed' },
      { kind: 'retry', error: 'Network request failed' },
      { kind: 'ok', result: 'in_fence' },
    ]);
    await t.queue.enqueue(attempt());
    await t.queue.flush();
    expect(t.sent).toHaveLength(1);

    // not due yet: nothing is sent
    t.advance(BACKOFF_BASE_MS - 1);
    await t.queue.flush();
    expect(t.sent).toHaveLength(1);

    t.advance(1);
    await t.queue.flush();
    expect(t.sent).toHaveLength(2);
    expect(await t.queue.pending()).toHaveLength(1);

    // app foregrounds: retry immediately regardless of backoff
    t.advance(1000);
    await t.queue.retryNow();
    expect(t.sent).toHaveLength(3);
    expect(await t.queue.pending()).toHaveLength(0);

    for (const s of t.sent) expect(s.clientCapturedAt).toBe('2026-11-09T16:59:28.000Z');
    expect(t.events.filter((e) => e.type === 'sent')).toHaveLength(1);
  });

  it('drops server rejections and reports them', async () => {
    const t = setup([{ kind: 'reject', error: 'not a participant' }]);
    await t.queue.enqueue(attempt());
    await t.queue.flush();
    expect(await t.queue.pending()).toHaveLength(0);
    expect(t.events).toMatchObject([{ type: 'rejected', error: 'not a participant' }]);
  });

  it('expires stale attempts without sending them', async () => {
    const t = setup([]);
    await t.queue.enqueue(attempt());
    t.advance(MAX_AGE_MS + 60_000);
    await t.queue.flush();
    expect(t.sent).toHaveLength(0);
    expect(await t.queue.pending()).toHaveLength(0);
    expect(t.events).toMatchObject([{ type: 'expired' }]);
  });

  it('does not send the same attempt twice when flushes overlap', async () => {
    const t = setup([{ kind: 'ok', result: 'in_fence' }]);
    await t.queue.enqueue(attempt());
    await Promise.all([t.queue.flush(), t.queue.flush(), t.queue.retryNow()]);
    expect(t.sent).toHaveLength(1);
  });

  it('treats a thrown send as a network failure', async () => {
    const storage = new MemoryStorage();
    const q = new CheckinQueue<string>({
      storage,
      now: () => T0,
      send: async () => {
        throw new TypeError('Network request failed');
      },
    });
    await q.enqueue(attempt());
    await q.flush();
    const pending = await q.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.attempts).toBe(1);
  });

  it('persists across instances (app restart)', async () => {
    const storage = new MemoryStorage();
    const first = new CheckinQueue<string>({
      storage,
      now: () => T0,
      send: async () => ({ kind: 'retry', error: 'offline' }),
    });
    await first.enqueue(attempt());
    await first.flush();

    const sent: CheckinAttempt[] = [];
    const second = new CheckinQueue<string>({
      storage,
      now: () => T0 + 2 * 3_600_000,
      send: async (a) => {
        sent.push(a);
        return { kind: 'ok', result: 'in_fence' };
      },
    });
    await second.flush();
    expect(sent).toEqual([attempt()]);
    expect(await second.pending()).toHaveLength(0);
  });

  it('reports the next wake time for scheduling', async () => {
    const t = setup([{ kind: 'retry', error: 'offline' }]);
    expect(await t.queue.nextWakeAt()).toBeNull();
    await t.queue.enqueue(attempt());
    await t.queue.flush();
    expect(await t.queue.nextWakeAt()).toBe(T0 + BACKOFF_BASE_MS);
  });
});

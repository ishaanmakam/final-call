/**
 * Offline check-in queue. Pure logic plus a small orchestrator with injected storage,
 * transport and clock, so it runs under Vitest with no React Native imports.
 *
 * The client time sent to the server is always the fix timestamp captured when the user
 * tapped Check In, never the time the request is (re)sent.
 */

export interface CheckinAttempt {
  instanceId: string;
  /** null when no fix could be obtained; the server judges that as unverified (fail-open). */
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  /** ISO instant of the location fix (LocationObject.timestamp), not the send time. */
  clientCapturedAt: string;
  isSimulated: boolean;
}

export interface QueuedCheckin extends CheckinAttempt {
  key: string;
  enqueuedAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
}

export type Queue = readonly QueuedCheckin[];

export type SendOutcome<R> =
  | { kind: 'ok'; result: R }
  | { kind: 'retry'; error: string }
  | { kind: 'reject'; error: string };

export type QueueEvent<R> =
  | { type: 'sent'; entry: QueuedCheckin; result: R }
  | { type: 'rejected'; entry: QueuedCheckin; error: string }
  | { type: 'expired'; entry: QueuedCheckin };

export interface QueueStorage {
  load(): Promise<string | null>;
  save(serialized: string): Promise<void>;
}

export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60 * 1000;
export const MAX_PER_INSTANCE = 5;
const STORAGE_VERSION = 1;

function canonicalInstant(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toISOString();
}

export function attemptKey(a: Pick<CheckinAttempt, 'instanceId' | 'clientCapturedAt'>): string {
  return `${a.instanceId}@${canonicalInstant(a.clientCapturedAt)}`;
}

export function backoffDelay(attempts: number): number {
  const exp = Math.min(attempts, 30);
  return Math.min(BACKOFF_BASE_MS * 2 ** exp, BACKOFF_MAX_MS);
}

export function enqueue(queue: Queue, attempt: CheckinAttempt, now: number): { queue: QueuedCheckin[]; added: boolean } {
  const key = attemptKey(attempt);
  if (queue.some((q) => q.key === key)) return { queue: [...queue], added: false };
  const sameInstance = queue.filter((q) => q.instanceId === attempt.instanceId);
  const entry: QueuedCheckin = {
    ...attempt,
    clientCapturedAt: canonicalInstant(attempt.clientCapturedAt),
    key,
    enqueuedAt: now,
    attempts: 0,
    nextAttemptAt: now,
    lastError: null,
  };
  if (sameInstance.length >= MAX_PER_INSTANCE) {
    // Keep the earliest captures: they are the ones that can still beat the deadline.
    const latest = sameInstance.reduce((a, b) => (Date.parse(a.clientCapturedAt) >= Date.parse(b.clientCapturedAt) ? a : b));
    if (Date.parse(entry.clientCapturedAt) >= Date.parse(latest.clientCapturedAt)) {
      return { queue: [...queue], added: false };
    }
    return { queue: [...queue.filter((q) => q.key !== latest.key), entry], added: true };
  }
  return { queue: [...queue, entry], added: true };
}

export function pruneExpired(queue: Queue, now: number): { kept: QueuedCheckin[]; expired: QueuedCheckin[] } {
  const kept: QueuedCheckin[] = [];
  const expired: QueuedCheckin[] = [];
  for (const q of queue) {
    const captured = Date.parse(q.clientCapturedAt);
    const age = now - (Number.isNaN(captured) ? q.enqueuedAt : captured);
    (age > MAX_AGE_MS ? expired : kept).push(q);
  }
  return { kept, expired };
}

export function dueEntries(queue: Queue, now: number): QueuedCheckin[] {
  return queue
    .filter((q) => q.nextAttemptAt <= now)
    .sort((a, b) => Date.parse(a.clientCapturedAt) - Date.parse(b.clientCapturedAt));
}

export function recordRetry(queue: Queue, key: string, now: number, error: string): QueuedCheckin[] {
  return queue.map((q) =>
    q.key === key ? { ...q, attempts: q.attempts + 1, nextAttemptAt: now + backoffDelay(q.attempts), lastError: error } : q,
  );
}

export function removeEntry(queue: Queue, key: string): QueuedCheckin[] {
  return queue.filter((q) => q.key !== key);
}

export function wakeAll(queue: Queue, now: number): QueuedCheckin[] {
  return queue.map((q) => (q.nextAttemptAt > now ? { ...q, nextAttemptAt: now } : q));
}

export function nextWakeAt(queue: Queue): number | null {
  if (queue.length === 0) return null;
  return Math.min(...queue.map((q) => q.nextAttemptAt));
}

export function serializeQueue(queue: Queue): string {
  return JSON.stringify({ v: STORAGE_VERSION, items: queue });
}

function isQueuedCheckin(x: unknown): x is QueuedCheckin {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.key === 'string' &&
    typeof o.instanceId === 'string' &&
    (o.lat === null || typeof o.lat === 'number') &&
    (o.lng === null || typeof o.lng === 'number') &&
    (o.accuracyM === null || typeof o.accuracyM === 'number') &&
    typeof o.clientCapturedAt === 'string' &&
    typeof o.isSimulated === 'boolean' &&
    typeof o.enqueuedAt === 'number' &&
    typeof o.attempts === 'number' &&
    typeof o.nextAttemptAt === 'number'
  );
}

export function deserializeQueue(serialized: string | null): QueuedCheckin[] {
  if (!serialized) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (typeof parsed !== 'object' || parsed === null) return [];
    const items = (parsed as { items?: unknown }).items;
    if (!Array.isArray(items)) return [];
    return items.filter(isQueuedCheckin).map((q) => ({ ...q, lastError: q.lastError ?? null }));
  } catch {
    return [];
  }
}

export function toAttempt(q: QueuedCheckin): CheckinAttempt {
  return {
    instanceId: q.instanceId,
    lat: q.lat,
    lng: q.lng,
    accuracyM: q.accuracyM,
    clientCapturedAt: q.clientCapturedAt,
    isSimulated: q.isSimulated,
  };
}

export interface CheckinQueueOptions<R> {
  storage: QueueStorage;
  send: (attempt: CheckinAttempt) => Promise<SendOutcome<R>>;
  now?: () => number;
  onEvent?: (event: QueueEvent<R>) => void;
}

export interface FlushReport {
  sent: number;
  retrying: number;
  rejected: number;
  expired: number;
}

/**
 * Serializes all operations through one promise chain, so overlapping triggers
 * (foreground, timer, a fresh enqueue) never send the same attempt twice.
 */
export class CheckinQueue<R> {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: CheckinQueueOptions<R>) {
    this.now = options.now ?? Date.now;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<QueuedCheckin[]> {
    return deserializeQueue(await this.options.storage.load());
  }

  private write(queue: Queue): Promise<void> {
    return this.options.storage.save(serializeQueue(queue));
  }

  enqueue(attempt: CheckinAttempt): Promise<boolean> {
    return this.exclusive(async () => {
      const result = enqueue(await this.read(), attempt, this.now());
      if (result.added) await this.write(result.queue);
      return result.added;
    });
  }

  pending(): Promise<QueuedCheckin[]> {
    return this.exclusive(() => this.read());
  }

  nextWakeAt(): Promise<number | null> {
    return this.exclusive(async () => nextWakeAt(await this.read()));
  }

  /** Retry everything now (app foregrounded or connectivity regained). */
  retryNow(): Promise<FlushReport> {
    return this.exclusive(async () => {
      await this.write(wakeAll(await this.read(), this.now()));
      return this.flushLocked();
    });
  }

  flush(): Promise<FlushReport> {
    return this.exclusive(() => this.flushLocked());
  }

  private async flushLocked(): Promise<FlushReport> {
    const report: FlushReport = { sent: 0, retrying: 0, rejected: 0, expired: 0 };
    const pruned = pruneExpired(await this.read(), this.now());
    let queue: QueuedCheckin[] = pruned.kept;
    if (pruned.expired.length > 0) {
      await this.write(queue);
      for (const entry of pruned.expired) {
        report.expired += 1;
        this.options.onEvent?.({ type: 'expired', entry });
      }
    }
    for (const entry of dueEntries(queue, this.now())) {
      let outcome: SendOutcome<R>;
      try {
        outcome = await this.options.send(toAttempt(entry));
      } catch (e) {
        outcome = { kind: 'retry', error: e instanceof Error ? e.message : String(e) };
      }
      if (outcome.kind === 'retry') {
        queue = recordRetry(queue, entry.key, this.now(), outcome.error);
        report.retrying += 1;
      } else {
        queue = removeEntry(queue, entry.key);
        if (outcome.kind === 'ok') {
          report.sent += 1;
          this.options.onEvent?.({ type: 'sent', entry, result: outcome.result });
        } else {
          report.rejected += 1;
          this.options.onEvent?.({ type: 'rejected', entry, error: outcome.error });
        }
      }
      await this.write(queue);
    }
    return report;
  }
}

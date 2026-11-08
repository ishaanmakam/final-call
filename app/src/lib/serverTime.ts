/**
 * How far the phone's clock is from the server's. Pure (no Expo imports).
 *
 * Deadlines are judged on the server's receive time (CONTRACT.md), so a phone whose clock is
 * minutes off shows countdowns that lie. Every Supabase response carries a `Date` header
 * (1-second resolution); `recordServerDate` turns each into a sample of
 * `server - device` and keeps the median of the last few, so one slow response cannot fake a
 * skew. `serverNow()` is the device clock corrected by that estimate.
 *
 * Wiring (api/supabase.ts, `global.fetch`): after each response,
 * `recordServerDate(res.headers.get('date'), Date.now())`.
 */

const SAMPLE_WINDOW = 5;
/** HTTP dates are whole seconds; the true instant is on average half a second later. */
const HALF_SECOND = 500;

let samples: number[] = [];
let offset = 0;
const listeners = new Set<(offsetMs: number) => void>();

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Feed one response's `Date` header. Unparsable or missing values are ignored. */
export function recordServerDate(headerValue: string | null | undefined, receivedAtMs: number): void {
  if (!headerValue) return;
  const serverMs = Date.parse(headerValue);
  if (!Number.isFinite(serverMs)) return;
  samples = [...samples.slice(-(SAMPLE_WINDOW - 1)), serverMs + HALF_SECOND - receivedAtMs];
  const next = median(samples);
  if (next === offset) return;
  offset = next;
  listeners.forEach((l) => l(offset));
}

/** Estimated `server - device` in ms; 0 until the first response is seen. */
export function serverOffsetMs(): number {
  return offset;
}

/** The device clock corrected to server time. */
export function serverNow(deviceNowMs: number = Date.now()): number {
  return deviceNowMs + offset;
}

export function subscribeServerOffset(listener: (offsetMs: number) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetServerTimeForTests(): void {
  samples = [];
  offset = 0;
  listeners.clear();
}

// ---------- the notice ----------

/** Under two minutes the countdown is still honest to the second that matters. */
export const SKEW_NOTICE_THRESHOLD_MS = 2 * 60_000;

function describeMinutes(totalMinutes: number): string {
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * The one line the check-in screen shows when the phone's clock is off; null when it is fine.
 * A positive offset means the server is ahead, so the phone is behind.
 */
export function clockSkewCopy(offsetMs: number): string | null {
  if (Math.abs(offsetMs) <= SKEW_NOTICE_THRESHOLD_MS) return null;
  const minutes = Math.round(Math.abs(offsetMs) / 60_000);
  const direction = offsetMs > 0 ? 'behind' : 'ahead of';
  return `Your phone's clock is ${describeMinutes(minutes)} ${direction} the server. Deadlines use server time.`;
}

/** Second line of the notice: where the deadline stands on the server's clock. */
export function serverDeadlineLine(deadlineText: string, remainingMs: number): string {
  if (remainingMs <= 0) return `By the server's clock, ${deadlineText} has passed.`;
  if (remainingMs < 60_000) return `By the server's clock, ${deadlineText} is less than a minute away.`;
  return `By the server's clock, ${deadlineText} is in ${describeMinutes(Math.floor(remainingMs / 60_000))}.`;
}

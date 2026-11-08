/**
 * Local reminders for the phone's own upcoming windows. Pure (no Expo imports), so the diff can
 * be unit-tested; `localNotificationsRuntime.ts` applies it with expo-notifications.
 *
 * Two reminders per instance the person is in: "Boarding" when the window opens and "Final call"
 * fifteen minutes before the deadline. Identifiers are deterministic (`boarding:<id>`,
 * `final:<id>`), so re-planning is idempotent: only missing ones are scheduled, only stale ones
 * are cancelled. The server sends the same two moments as push (`window_open`, `deadline_soon`);
 * when one of those arrives first, the matching local identifier is cancelled
 * (`localIdentifierForPush`). Local reminders are the belt to push's braces: they fire with the
 * network down, and they are what a tester without an Expo push token sees.
 */
import type { GroupHome, InstanceDetail, PactDetail } from '../api/queries';
import type { InstanceStatus } from '../api/types';
import { formatTimeInZone } from './time';

export const BOARDING_PREFIX = 'boarding:';
export const FINAL_PREFIX = 'final:';
export const FINAL_CALL_LEAD_MS = 15 * 60_000;
/** Instances whose window opens later than this are left for a later planning run. */
export const HORIZON_MS = 7 * 24 * 3_600_000;
/** iOS keeps at most 64 pending local notifications per app; leave room for anything else. */
export const MAX_PLANNED = 60;

export interface UpcomingInstance {
  instanceId: string;
  pactTitle: string;
  tz: string;
  windowOpenAt: string;
  deadlineAt: string;
  status: InstanceStatus;
  /** the current user is on this pact */
  participating: boolean;
  /** the current user froze this day */
  frozen: boolean;
  /** the current user already has an in-fence tap or a success result for this day */
  succeeded: boolean;
  /** the pact is paused (its future instances are void) */
  paused: boolean;
}

export interface PlannedNotification {
  identifier: string;
  /** trigger instant, ms since epoch */
  at: number;
  title: string;
  body: string;
  /** in-app path for `routeFromData` */
  url: string;
}

export interface LocalNotificationPlan {
  schedule: PlannedNotification[];
  cancel: string[];
}

export const isOurIdentifier = (id: string): boolean => id.startsWith(BOARDING_PREFIX) || id.startsWith(FINAL_PREFIX);

const LIVE: ReadonlySet<InstanceStatus> = new Set<InstanceStatus>(['scheduled', 'open']);

function eligible(i: UpcomingInstance, nowMs: number): boolean {
  return (
    i.participating &&
    !i.frozen &&
    !i.succeeded &&
    !i.paused &&
    LIVE.has(i.status) &&
    Date.parse(i.deadlineAt) > nowMs &&
    Date.parse(i.windowOpenAt) <= nowMs + HORIZON_MS
  );
}

/** Both reminders of an instance, whether or not their times have passed. */
function remindersFor(i: UpcomingInstance): PlannedNotification[] {
  const by = `Check in by ${formatTimeInZone(i.deadlineAt, i.tz)}.`;
  return [
    {
      identifier: `${BOARDING_PREFIX}${i.instanceId}`,
      at: Date.parse(i.windowOpenAt),
      title: `Boarding for ${i.pactTitle}`,
      body: by,
      url: `/checkin/${i.instanceId}`,
    },
    {
      identifier: `${FINAL_PREFIX}${i.instanceId}`,
      at: Date.parse(i.deadlineAt) - FINAL_CALL_LEAD_MS,
      title: `Final call: 15 minutes left for ${i.pactTitle}`,
      body: by,
      url: `/checkin/${i.instanceId}`,
    },
  ];
}

/**
 * The diff to apply. `scheduledIds` are the identifiers currently pending on the device;
 * `scheduledAt` (optional) their trigger instants, so a rescheduled pact re-plans its reminders.
 */
export function planLocalNotifications(
  instances: readonly UpcomingInstance[],
  scheduledIds: ReadonlySet<string>,
  nowMs: number,
  scheduledAt?: ReadonlyMap<string, number>,
): LocalNotificationPlan {
  const seen = new Set<string>();
  const wanted = new Map<string, PlannedNotification>();
  for (const i of instances) {
    if (seen.has(i.instanceId)) continue;
    seen.add(i.instanceId);
    if (!eligible(i, nowMs)) continue;
    for (const n of remindersFor(i)) wanted.set(n.identifier, n);
  }

  const cancel: string[] = [];
  for (const id of scheduledIds) {
    if (!isOurIdentifier(id)) continue;
    const want = wanted.get(id);
    if (!want) {
      cancel.push(id);
      continue;
    }
    const at = scheduledAt?.get(id);
    if (at !== undefined && at !== want.at) cancel.push(id);
  }
  const cancelled = new Set(cancel);

  const schedule = [...wanted.values()]
    .filter((n) => n.at > nowMs && (!scheduledIds.has(n.identifier) || cancelled.has(n.identifier)))
    .sort((a, b) => a.at - b.at || a.identifier.localeCompare(b.identifier))
    .slice(0, MAX_PLANNED);

  return { schedule, cancel };
}

// ---------- from the query cache ----------

/** The slice of TanStack's QueryClient this needs (so it can be fed a fake in tests). */
export interface QueryCacheReader {
  getQueriesData<T>(filters: { queryKey: readonly unknown[] }): Array<[readonly unknown[], T | undefined]>;
}

const DAY_MS = 86_400_000;

/**
 * Every instance the app already knows about, as the planner wants it: today's items from each
 * cached group home (they know whether the person is in, frozen or already in the circle), the
 * upcoming list of each cached pact detail, and the success flag of each cached check-in screen.
 * Nothing is fetched here: the planner runs whenever those queries settle.
 */
export function upcomingFromQueryCache(qc: QueryCacheReader, userId: string, nowMs: number): UpcomingInstance[] {
  const out: UpcomingInstance[] = [];
  const succeeded = new Set<string>();
  const frozen = new Set<string>();

  for (const [, detail] of qc.getQueriesData<InstanceDetail>({ queryKey: ['instance'] })) {
    if (!detail || !detail.instance || !Array.isArray(detail.myCheckins)) continue;
    const deadlineMs = Date.parse(detail.instance.deadline_at);
    const inFence = detail.myCheckins.some((c) => c.verdict === 'in_fence' && Date.parse(c.server_received_at) <= deadlineMs);
    if (inFence || detail.myResult?.status === 'success') succeeded.add(detail.instance.id);
    if (detail.myFreeze) frozen.add(detail.instance.id);
  }

  for (const [, home] of qc.getQueriesData<GroupHome>({ queryKey: ['group'] })) {
    if (!home || !Array.isArray(home.today)) continue; // feed / ledger entries share the prefix
    for (const t of home.today) {
      out.push({
        instanceId: t.instance.id,
        pactTitle: t.pact.title,
        tz: t.pact.tz,
        windowOpenAt: t.instance.window_open_at,
        deadlineAt: t.instance.deadline_at,
        status: t.instance.status,
        participating: t.participantIds.includes(userId),
        frozen: t.myState === 'frozen' || frozen.has(t.instance.id),
        succeeded: t.myState === 'checked_in' || t.myState === 'success' || succeeded.has(t.instance.id),
        paused: t.pact.paused,
      });
    }
  }

  for (const [, pd] of qc.getQueriesData<PactDetail>({ queryKey: ['pact'] })) {
    if (!pd || !Array.isArray(pd.upcoming) || !Array.isArray(pd.participants)) continue; // place schedules share the prefix
    const participating = pd.participants.some((p) => p.user_id === userId);
    for (const i of pd.upcoming) {
      // the pact's list reaches back a day; the planner wants what is still ahead
      if (Date.parse(i.deadline_at) < nowMs - DAY_MS) continue;
      out.push({
        instanceId: i.id,
        pactTitle: pd.pact.title,
        tz: pd.pact.tz,
        windowOpenAt: i.window_open_at,
        deadlineAt: i.deadline_at,
        status: i.status,
        participating,
        frozen: pd.myFreezes.some((f) => f.instance_id === i.id) || frozen.has(i.id),
        succeeded: succeeded.has(i.id),
        paused: pd.pact.paused,
      });
    }
  }
  return out;
}

/**
 * The local identifier a server push makes redundant: `window_open` → boarding,
 * `deadline_soon` → final call. Null for anything else, including our own local payloads
 * (`local: true`).
 */
export function localIdentifierForPush(data: Record<string, unknown> | undefined): string | null {
  if (!data || data.local === true) return null;
  const instanceId = typeof data.instance_id === 'string' ? data.instance_id : null;
  if (!instanceId) return null;
  if (data.kind === 'window_open') return `${BOARDING_PREFIX}${instanceId}`;
  if (data.kind === 'deadline_soon') return `${FINAL_PREFIX}${instanceId}`;
  return null;
}

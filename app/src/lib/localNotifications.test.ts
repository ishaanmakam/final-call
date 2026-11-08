import { describe, expect, it } from 'vitest';
import {
  BOARDING_PREFIX,
  FINAL_CALL_LEAD_MS,
  FINAL_PREFIX,
  HORIZON_MS,
  isOurIdentifier,
  localIdentifierForPush,
  planLocalNotifications,
  upcomingFromQueryCache,
  type UpcomingInstance,
} from './localNotifications';

const T = Date.UTC(2026, 10, 7, 15, 0, 0); // 2026-11-07T15:00:00Z (07:00 PST)
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const TZ = 'America/Los_Angeles';

function inst(over: Partial<UpcomingInstance> = {}): UpcomingInstance {
  return {
    instanceId: 'i1',
    pactTitle: '9am class',
    tz: TZ,
    windowOpenAt: iso(T + H), // 08:00 PST
    deadlineAt: iso(T + 2 * H), // 09:00 PST
    status: 'scheduled',
    participating: true,
    frozen: false,
    succeeded: false,
    paused: false,
    ...over,
  };
}

const plan = (instances: UpcomingInstance[], scheduled: string[] = [], now = T) =>
  planLocalNotifications(instances, new Set(scheduled), now);

describe('planLocalNotifications: what gets scheduled', () => {
  it('one Boarding at window open and one Final call 15 min before the deadline, with deterministic ids', () => {
    const p = plan([inst()]);
    expect(p.cancel).toEqual([]);
    expect(p.schedule.map((n) => n.identifier)).toEqual([`${BOARDING_PREFIX}i1`, `${FINAL_PREFIX}i1`]);
    const [boarding, final] = p.schedule;
    expect(boarding!.at).toBe(T + H);
    expect(boarding!.title).toBe('Boarding: 9am class');
    expect(boarding!.body).toBe('Check in by 9:00 AM.');
    expect(boarding!.url).toBe('/checkin/i1');
    expect(final!.at).toBe(T + 2 * H - FINAL_CALL_LEAD_MS);
    expect(FINAL_CALL_LEAD_MS).toBe(15 * 60_000);
    expect(final!.title).toBe('Final call: 9am class');
    expect(final!.body).toBe('15 minutes left to check in.');
    expect(final!.url).toBe('/checkin/i1');
  });

  it('the deadline is rendered in the pact zone, not the device zone', () => {
    const p = plan([inst({ tz: 'America/New_York' })]);
    expect(p.schedule[0]!.body).toBe('Check in by 12:00 PM.');
  });

  it('skips times already in the past: an open window keeps only the final call', () => {
    const p = plan([inst()], [], T + H + 60_000);
    expect(p.schedule.map((n) => n.identifier)).toEqual([`${FINAL_PREFIX}i1`]);
  });

  it('skips both when fewer than 15 minutes remain, and everything after the deadline', () => {
    expect(plan([inst()], [], T + 2 * H - 10 * 60_000).schedule).toEqual([]);
    expect(plan([inst()], [], T + 3 * H).schedule).toEqual([]);
  });

  it('ignores instances beyond the 7-day horizon', () => {
    expect(HORIZON_MS).toBe(7 * 24 * H);
    const far = inst({ instanceId: 'far', windowOpenAt: iso(T + 8 * 24 * H), deadlineAt: iso(T + 8 * 24 * H + H) });
    const edge = inst({ instanceId: 'edge', windowOpenAt: iso(T + 6 * 24 * H), deadlineAt: iso(T + 6 * 24 * H + H) });
    const p = plan([far, edge]);
    expect(p.schedule.map((n) => n.identifier)).toEqual([`${BOARDING_PREFIX}edge`, `${FINAL_PREFIX}edge`]);
  });

  it('schedules nothing for instances where the user is not a participant, is frozen, already succeeded, or the pact is paused', () => {
    expect(plan([inst({ participating: false })]).schedule).toEqual([]);
    expect(plan([inst({ frozen: true })]).schedule).toEqual([]);
    expect(plan([inst({ succeeded: true })]).schedule).toEqual([]);
    expect(plan([inst({ paused: true })]).schedule).toEqual([]);
  });

  it('schedules nothing for voided, closed or settled instances', () => {
    for (const status of ['voided', 'closed', 'settled'] as const) {
      expect(plan([inst({ status })]).schedule, status).toEqual([]);
    }
    expect(plan([inst({ status: 'open' })], [], T + H + 1).schedule).toHaveLength(1);
  });

  it('dedupes the same instance seen through two queries', () => {
    const p = plan([inst(), inst()]);
    expect(p.schedule).toHaveLength(2);
  });

  it('orders the schedule by time so the nearest reminders are registered first (iOS caps at 64)', () => {
    const later = inst({ instanceId: 'later', windowOpenAt: iso(T + 25 * H), deadlineAt: iso(T + 26 * H) });
    const p = plan([later, inst()]);
    expect(p.schedule.map((n) => n.identifier)).toEqual([
      `${BOARDING_PREFIX}i1`,
      `${FINAL_PREFIX}i1`,
      `${BOARDING_PREFIX}later`,
      `${FINAL_PREFIX}later`,
    ]);
  });

  it('never plans more than 60 notifications', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      inst({ instanceId: `i${i}`, windowOpenAt: iso(T + H + i * 60_000), deadlineAt: iso(T + 2 * H + i * 60_000) }),
    );
    expect(plan(many).schedule.length).toBeLessThanOrEqual(60);
  });
});

describe('planLocalNotifications: idempotence and cancellations', () => {
  it('re-running with everything already scheduled is a no-op', () => {
    const first = plan([inst()]);
    const again = plan([inst()], first.schedule.map((n) => n.identifier));
    expect(again.schedule).toEqual([]);
    expect(again.cancel).toEqual([]);
  });

  it('schedules only the missing half when one of the pair is already registered', () => {
    const p = plan([inst()], [`${BOARDING_PREFIX}i1`]);
    expect(p.schedule.map((n) => n.identifier)).toEqual([`${FINAL_PREFIX}i1`]);
  });

  it('cancels our identifiers for instances that vanished, were voided or paused, got frozen, or already have a success', () => {
    const ids = [`${BOARDING_PREFIX}i1`, `${FINAL_PREFIX}i1`];
    expect(plan([], ids).cancel).toEqual(ids);
    expect(plan([inst({ status: 'voided' })], ids).cancel).toEqual(ids);
    expect(plan([inst({ paused: true })], ids).cancel).toEqual(ids);
    expect(plan([inst({ frozen: true })], ids).cancel).toEqual(ids);
    expect(plan([inst({ succeeded: true })], ids).cancel).toEqual(ids);
  });

  it('cancels a boarding whose time moved (the pact was rescheduled): same id, new time is re-planned', () => {
    const scheduled = plan([inst()]).schedule.map((n) => n.identifier);
    const moved = inst({ windowOpenAt: iso(T + 3 * H), deadlineAt: iso(T + 4 * H) });
    const p = planLocalNotifications(
      [moved],
      new Set(scheduled),
      T,
      new Map([[`${BOARDING_PREFIX}i1`, T + H], [`${FINAL_PREFIX}i1`, T + 2 * H - FINAL_CALL_LEAD_MS]]),
    );
    expect(p.cancel).toEqual([`${BOARDING_PREFIX}i1`, `${FINAL_PREFIX}i1`]);
    expect(p.schedule.map((n) => [n.identifier, n.at])).toEqual([
      [`${BOARDING_PREFIX}i1`, T + 3 * H],
      [`${FINAL_PREFIX}i1`, T + 4 * H - FINAL_CALL_LEAD_MS],
    ]);
  });

  it('leaves identifiers that are not ours alone', () => {
    const p = plan([], ['something-else', 'expo-1234']);
    expect(p.cancel).toEqual([]);
    expect(isOurIdentifier('boarding:x')).toBe(true);
    expect(isOurIdentifier('final:x')).toBe(true);
    expect(isOurIdentifier('finalist')).toBe(false);
  });

  it('does not cancel a past-due local reminder that was already delivered (nothing to cancel, nothing to re-add)', () => {
    const ids = [`${BOARDING_PREFIX}i1`];
    const p = plan([inst()], ids, T + H + 60_000);
    // boarding is in the past: it is neither re-scheduled nor cancelled (already fired or about to)
    expect(p.schedule.map((n) => n.identifier)).toEqual([`${FINAL_PREFIX}i1`]);
    expect(p.cancel).toEqual([]);
  });
});

describe('localIdentifierForPush: a server push supersedes the matching local reminder', () => {
  it('window_open cancels boarding, deadline_soon cancels final', () => {
    expect(localIdentifierForPush({ kind: 'window_open', instance_id: 'i1' })).toBe(`${BOARDING_PREFIX}i1`);
    expect(localIdentifierForPush({ kind: 'deadline_soon', instance_id: 'i1' })).toBe(`${FINAL_PREFIX}i1`);
  });

  it('other kinds, missing ids and our own local payloads map to nothing', () => {
    expect(localIdentifierForPush({ kind: 'result', instance_id: 'i1' })).toBeNull();
    expect(localIdentifierForPush({ kind: 'window_open' })).toBeNull();
    expect(localIdentifierForPush({ kind: 'window_open', instance_id: 'i1', local: true })).toBeNull();
    expect(localIdentifierForPush(undefined)).toBeNull();
  });
});

describe('upcomingFromQueryCache: what the cached queries already know', () => {
  const ME = 'me';
  const pact = { id: 'p1', title: '9am class', tz: TZ, paused: false };
  const row = (id: string, offsetH: number, status = 'scheduled') => ({
    id,
    pact_id: 'p1',
    status,
    window_open_at: iso(T + offsetH * H),
    deadline_at: iso(T + (offsetH + 1) * H),
  });
  const today = (instance: ReturnType<typeof row>, myState: string | null, participantIds = [ME, 'other']) => ({
    instance,
    pact,
    participantIds,
    summary: {},
    myState,
  });
  const reader = (entries: Array<[readonly unknown[], unknown]>) => ({
    getQueriesData: <T,>(f: { queryKey: readonly unknown[] }) =>
      entries.filter(([k]) => k[0] === f.queryKey[0]) as Array<[readonly unknown[], T | undefined]>,
  });
  const pick = (xs: UpcomingInstance[], id: string) => xs.find((x) => x.instanceId === id)!;

  it('maps group-home today items: participation, frozen and checked-in states', () => {
    const qc = reader([
      [['group', 'g1', 'home'], { today: [today(row('a', 1), 'waiting'), today(row('b', 1), 'checked_in'), today(row('c', 1), 'frozen'), today(row('d', 1), null, ['other'])] }],
      [['group', 'g1', 'feed'], { items: [] }],
      [['group', 'g1', 'ledger'], { balances: [] }],
    ]);
    const xs = upcomingFromQueryCache(qc, ME, T);
    expect(xs.map((x) => x.instanceId)).toEqual(['a', 'b', 'c', 'd']);
    expect(pick(xs, 'a')).toMatchObject({ participating: true, frozen: false, succeeded: false, paused: false, pactTitle: '9am class', tz: TZ });
    expect(pick(xs, 'b').succeeded).toBe(true);
    expect(pick(xs, 'c').frozen).toBe(true);
    expect(pick(xs, 'd').participating).toBe(false);
  });

  it('maps pact-detail upcoming rows with the person\'s freezes, skipping the day-old tail', () => {
    const qc = reader([
      [
        ['pact', 'p1'],
        {
          pact,
          participants: [{ user_id: ME }, { user_id: 'other' }],
          upcoming: [row('old', -30), row('x', 24), row('y', 48)],
          myFreezes: [{ instance_id: 'y' }],
        },
      ],
      [['pact', 'p1', 'places', ME], { places: [], nextInstance: null }],
    ]);
    const xs = upcomingFromQueryCache(qc, ME, T);
    expect(xs.map((x) => x.instanceId)).toEqual(['x', 'y']);
    expect(pick(xs, 'x')).toMatchObject({ participating: true, frozen: false, succeeded: false });
    expect(pick(xs, 'y').frozen).toBe(true);
  });

  it('a cached check-in screen marks an instance succeeded (in-fence tap before the deadline) or frozen', () => {
    const r = row('x', 1);
    const qc = reader([
      [['pact', 'p1'], { pact, participants: [{ user_id: ME }], upcoming: [r, row('z', 24)], myFreezes: [] }],
      [['instance', 'x'], { instance: r, myCheckins: [{ verdict: 'in_fence', server_received_at: iso(T + 1.5 * H) }], myResult: null, myFreeze: null }],
      [['instance', 'z'], { instance: row('z', 24), myCheckins: [], myResult: null, myFreeze: { id: 'f' } }],
    ]);
    const xs = upcomingFromQueryCache(qc, ME, T);
    expect(pick(xs, 'x').succeeded).toBe(true);
    expect(pick(xs, 'z').frozen).toBe(true);
  });

  it('feeds the planner: a checked-in today item cancels its final call', () => {
    const qc = reader([[['group', 'g1', 'home'], { today: [today(row('a', 0.5), 'checked_in')] }]]);
    const p = planLocalNotifications(upcomingFromQueryCache(qc, ME, T), new Set([`${FINAL_PREFIX}a`]), T);
    expect(p.cancel).toEqual([`${FINAL_PREFIX}a`]);
    expect(p.schedule).toEqual([]);
  });
});

describe('weekly pacts (CB): Friday nudge when behind, Final call Sunday 6 PM', () => {
  const MON = Date.UTC(2026, 10, 9, 8, 0, 0); // Mon 9 Nov 2026 00:00 PST
  const weekly = (over: Partial<UpcomingInstance> = {}): UpcomingInstance =>
    inst({
      instanceId: 'w1',
      pactTitle: '15 miles a week',
      windowOpenAt: iso(MON),
      deadlineAt: iso(MON + 7 * 24 * H),
      status: 'open',
      period: 'weekly',
      pactId: 'p1',
      localDate: '2026-11-09',
      behindLine: '12.0 mi to go',
      ...over,
    });

  it('plans the Friday 18:00 nudge with the to-go line and the Sunday 18:00 Final call, both to the pact', () => {
    const p = planLocalNotifications([weekly()], new Set(), MON + 2 * 24 * H);
    expect(p.schedule.map((n) => n.identifier)).toEqual(['friday:w1', 'final:w1']);
    const [friday, final] = p.schedule;
    expect(new Date(friday!.at).toISOString()).toBe('2026-11-14T02:00:00.000Z'); // Fri 18:00 PST
    expect(friday!.title).toBe('15 miles a week');
    expect(friday!.body).toBe('12.0 mi to go. Two days left this week.');
    expect(friday!.url).toBe('/pacts/p1');
    expect(new Date(final!.at).toISOString()).toBe('2026-11-16T02:00:00.000Z'); // Sun 18:00 PST
    expect(final!.title).toBe('Final call: 15 miles a week');
    expect(final!.body).toBe('The week closes at midnight. 12.0 mi to go.');
    expect(final!.url).toBe('/pacts/p1');
  });

  it('skips the Friday nudge when the goal is already reached, keeps nothing once reached by Sunday', () => {
    const ahead = planLocalNotifications([weekly({ behindLine: null })], new Set(), MON + 2 * 24 * H);
    expect(ahead.schedule.map((n) => n.identifier)).toEqual(['final:w1']);
    expect(ahead.schedule[0]!.body).toBe('The week closes at midnight.');
    expect(planLocalNotifications([weekly({ succeeded: true })], new Set(['friday:w1', 'final:w1']), MON + 2 * 24 * H)).toEqual({ schedule: [], cancel: ['friday:w1', 'final:w1'] });
  });

  it('on Saturday only the Final call is still ahead; after the week nothing', () => {
    expect(planLocalNotifications([weekly()], new Set(), MON + 5 * 24 * H + 12 * H).schedule.map((n) => n.identifier)).toEqual(['final:w1']);
    expect(planLocalNotifications([weekly()], new Set(), MON + 8 * 24 * H).schedule).toEqual([]);
  });

  it('never gives a weekly pact a Boarding reminder, and never gives a daily pact a Friday one', () => {
    const ids = planLocalNotifications([weekly(), inst()], new Set(), MON + 2 * 24 * H).schedule.map((n) => n.identifier);
    expect(ids).not.toContain('boarding:w1');
    expect(ids).not.toContain('friday:i1');
    expect(isOurIdentifier('friday:x')).toBe(true);
  });

  it('a daily steps or custom pact and a race get no local reminders (nothing to board; the server pushes the Final call)', () => {
    expect(planLocalNotifications([inst({ kind: 'steps', period: 'daily' })], new Set(), T).schedule).toEqual([]);
    expect(planLocalNotifications([inst({ kind: 'custom', period: 'daily' })], new Set(), T).schedule).toEqual([]);
    expect(planLocalNotifications([inst({ kind: 'distance', period: 'once' })], new Set(), T).schedule).toEqual([]);
    expect(planLocalNotifications([inst({ kind: 'show_up', period: 'daily' })], new Set(), T).schedule).toHaveLength(2);
  });

  it('the cache reader carries the pact, period, local date and the to-go line from a weekly today item', () => {
    const ME = 'me';
    const pact = { id: 'p7', title: '15 miles a week', tz: TZ, paused: false, period: 'weekly', kind: 'distance', goal_value: 24140, goal_unit: 'm' };
    const row = { id: 'w1', pact_id: 'p7', status: 'open', local_date: '2026-11-09', window_open_at: iso(MON), deadline_at: iso(MON + 7 * 24 * H) };
    const home = (myState: string, value: number, reachedAt: string | null) => ({
      today: [{ instance: row, pact, participantIds: [ME], summary: {}, myState, goal: { progress: [{ user_id: ME, value, goal: 24140, reached_at: reachedAt }], standings: [] } }],
    });
    const reader = (data: unknown) => ({
      getQueriesData: <T,>(f: { queryKey: readonly unknown[] }) =>
        (f.queryKey[0] === 'group' ? [[['group', 'g1', 'home'], data]] : []) as unknown as Array<[readonly unknown[], T | undefined]>,
    });
    const xs = upcomingFromQueryCache(reader(home('waiting', 18024, null)), ME, MON + 2 * 24 * H, 'mi');
    expect(xs).toHaveLength(1);
    expect(xs[0]).toMatchObject({ instanceId: 'w1', pactId: 'p7', period: 'weekly', localDate: '2026-11-09', behindLine: '3.8 mi to go', succeeded: false });
    expect(upcomingFromQueryCache(reader(home('checked_in', 26000, iso(MON + H))), ME, MON + 2 * 24 * H, 'mi')[0]).toMatchObject({ behindLine: null, succeeded: true });
  });
});

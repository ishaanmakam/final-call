/**
 * The simulation engine: a pure-TypeScript model of one group, one pact and one week of Final Call.
 * Every verdict, result, payout, review outcome and settlement comes from `@final-call/rules`
 * (the oracle the database is differential-tested against); this file only sequences them, keeps
 * the append-only ledger and derives what the screens show. No DOM, no React.
 *
 * Every public function takes a World and returns a new World (structuredClone + mutation), so a
 * React store can compare references and tests can diff snapshots.
 */
import {
  applyReviews,
  checkinVerdict,
  computeInstancePayout,
  computeResults,
  settlementReviewStatus,
  simplifyDebts,
  type ParticipantResult,
  type ReviewOutcome,
} from '@final-call/rules';
import { carryAccount, carryBalance, memberAccount, memberBalances, postEntry, postedForInstance, potAccount } from './ledger';
import { fmtCents } from './money';
import { DAY, HOUR, MINUTE, addDays, fmtDateShort, fmtTime, instantOf, isoWeekOf, localDateOf, monthOf, weekStartOf, weekdayOf } from './time';
import type {
  Behaviour,
  Checkin,
  FriendId,
  Instance,
  LedgerLine,
  LocationMode,
  Member,
  MemberId,
  Review,
  ReviewKind,
  SimEvent,
  World,
  YouState,
} from './types';

export const FRIEND_IDS: readonly FriendId[] = ['maya', 'diego', 'priya'];
export const MEMBER_IDS: readonly MemberId[] = ['you', ...FRIEND_IDS];

/** How late a late tap may arrive and still be judged (CONTRACT.md check-in limits). */
export const LATE_TAP_GRACE_MS = 24 * HOUR;
/** Final call goes out this long before the deadline. */
export const FINAL_CALL_BEFORE_MS = 15 * MINUTE;
/** iOS Approximate Location is about a kilometre; shown greyed as what the rules would have said. */
export const APPROXIMATE_ACCURACY_M = 1000;

const KANE_HALL = { lat: 47.6566, lng: -122.3091 };

export const DEFAULT_MEMBERS: Member[] = [
  { id: 'you', name: 'You', initials: 'SO', avatar: 5, place: { ...KANE_HALL, radiusM: 75, label: 'Kane Hall' } },
  { id: 'maya', name: 'Maya Chen', initials: 'MC', avatar: 1, place: { lat: 47.6553, lng: -122.3081, radiusM: 60, label: 'Savery Hall' } },
  { id: 'diego', name: 'Diego Alvarez', initials: 'DA', avatar: 4, place: { lat: 47.6536, lng: -122.3045, radiusM: 100, label: 'The HUB' } },
  { id: 'priya', name: 'Priya Nair', initials: 'PN', avatar: 3, place: { lat: 47.6564, lng: -122.3105, radiusM: 50, label: 'Odegaard Library' } },
];

export const DEFAULT_PACT = {
  id: 'pact-kane',
  title: '9am in Kane Hall',
  days: [1, 2, 3, 4, 5],
  windowOpenLocal: '08:00',
  deadlineLocal: '09:00',
  stakeCents: 500,
  tz: 'America/Los_Angeles',
};

/** Monday 2026-11-09, 07:00 Pacific: an hour before the first Boarding. */
export const DEFAULT_START_LOCAL_DATE = '2026-11-09';

export const DEFAULT_YOU: YouState = { dx: 0, dy: 0, accuracyM: 12, online: true, locationMode: 'precise' };

export const DEFAULT_BEHAVIOURS: Record<FriendId, Behaviour> = { maya: 'on_time', diego: 'on_time', priya: 'on_time' };

/** Minutes after Boarding at which each friend taps; keeps leftover-cent ordering deterministic. */
const FRIEND_TAP_OFFSET_MIN: Record<FriendId, number> = { maya: 12, diego: 25, priya: 40 };

export function createWorld(opts: { startLocalDate?: string; behaviours?: Partial<Record<FriendId, Behaviour>> } = {}): World {
  const startLocalDate = opts.startLocalDate ?? DEFAULT_START_LOCAL_DATE;
  const pact = { ...DEFAULT_PACT };
  const now = instantOf(startLocalDate, '07:00', pact.tz);
  const w: World = {
    now,
    seenUntil: now,
    startLocalDate,
    pact,
    members: structuredClone(DEFAULT_MEMBERS),
    you: { ...DEFAULT_YOU },
    behaviours: { ...DEFAULT_BEHAVIOURS, ...opts.behaviours },
    instances: [],
    checkins: [],
    refusedTaps: [],
    freezes: [],
    reviews: [],
    entries: [],
    settlements: [],
    obligations: [],
    events: [],
    seq: 0,
  };
  tick(w);
  return w;
}

// ---------- lookups ----------

export const memberById = (w: World, id: MemberId): Member => w.members.find((m) => m.id === id)!;
export const firstName = (w: World, id: MemberId): string => (id === 'you' ? 'You' : memberById(w, id).name.split(' ')[0]!);
export const instanceById = (w: World, id: string): Instance => w.instances.find((i) => i.id === id)!;

/** The instance whose window is open right now, if any. */
export function openInstance(w: World): Instance | null {
  return w.instances.find((i) => i.status === 'open') ?? null;
}

/** Today's instance in the pact's zone (whatever its status), if today is a pact day. */
export function todayInstance(w: World): Instance | null {
  const today = localDateOf(w.now, w.pact.tz);
  return w.instances.find((i) => i.localDate === today) ?? null;
}

/** The instance the check-in screen shows: open one, else today's, else the next scheduled. */
export function focusInstance(w: World): Instance | null {
  return openInstance(w) ?? todayInstance(w) ?? nextScheduled(w) ?? w.instances.at(-1) ?? null;
}

export function nextScheduled(w: World): Instance | null {
  return w.instances.filter((i) => i.status === 'scheduled' && i.windowOpenAt > w.now).sort((a, b) => a.windowOpenAt - b.windowOpenAt)[0] ?? null;
}

export type WindowPhase = 'before' | 'boarding' | 'final_call' | 'closed';

export function phaseOf(w: World, inst: Instance): WindowPhase {
  if (inst.status === 'scheduled') return 'before';
  if (inst.status === 'open') return w.now >= inst.deadlineAt - FINAL_CALL_BEFORE_MS ? 'final_call' : 'boarding';
  return 'closed';
}

export function visibleCheckins(w: World, instanceId: string, userId?: MemberId): Checkin[] {
  return w.checkins
    .filter((c) => c.instanceId === instanceId && c.serverReceivedAt !== null && c.serverReceivedAt <= w.now && (!userId || c.userId === userId))
    .sort((a, b) => a.serverReceivedAt! - b.serverReceivedAt!);
}

export function queuedCheckins(w: World, instanceId?: string): Checkin[] {
  return w.checkins.filter((c) => c.userId === 'you' && c.serverReceivedAt === null && (!instanceId || c.instanceId === instanceId));
}

export function hasFreeze(w: World, instanceId: string, userId: MemberId): boolean {
  return w.freezes.some((f) => f.instanceId === instanceId && f.userId === userId);
}

export function reviewsFor(w: World, instanceId: string, subject?: MemberId): Review[] {
  return w.reviews.filter((r) => r.instanceId === instanceId && (!subject || r.subject === subject));
}

/** Voters = roster except the subject, and except the opener of a challenge (RT-1). */
export function eligibleVoters(w: World, review: Review): MemberId[] {
  const inst = instanceById(w, review.instanceId);
  return inst.roster.filter((id) => id !== review.subject && !(review.kind === 'challenge' && id === review.openedBy));
}

/** Your GPS dot as a fix the rules can judge. dx/dy are metres east/north of your place centre. */
export function youFix(w: World): { lat: number; lng: number; accuracyM: number; isSimulated: boolean } {
  const place = memberById(w, 'you').place;
  const lat = place.lat + w.you.dy / 111_320;
  const lng = place.lng + w.you.dx / (111_320 * Math.cos((place.lat * Math.PI) / 180));
  return { lat, lng, accuracyM: w.you.accuracyM, isSimulated: false };
}

/** Live readout for the fence playground: the oracle's verdict for the dot as it is now. */
export function previewVerdict(w: World) {
  const place = memberById(w, 'you').place;
  return checkinVerdict(youFix(w), place);
}

// ---------- events ----------

function event(w: World, kind: SimEvent['kind'], text: string, instanceId: string | null = null, extra: Partial<SimEvent> = {}): void {
  w.events.push({ id: `ev${++w.seq}`, at: w.now, kind, text, instanceId, ...extra });
}

// ---------- clock ----------

/** Move the clock forward to `t` and process everything that became due. Never moves backwards. */
export function advanceTo(w0: World, t: number): World {
  if (t <= w0.now) return w0;
  const w = structuredClone(w0);
  w.now = t;
  tick(w);
  return w;
}

/** Re-run the jobs at the current clock. Idempotent: a second call changes nothing. */
export function retick(w0: World): World {
  const w = structuredClone(w0);
  tick(w);
  return w;
}

function tick(w: World): void {
  generateInstances(w);
  // late taps that became visible since the last tick recompute the closed days they belong to
  applyArrivals(w);
  // open due windows (Boarding) and script the friends' day
  for (const inst of w.instances) {
    if (inst.status === 'scheduled' && inst.windowOpenAt <= w.now) openWindow(w, inst);
  }
  applyArrivals(w);
  // final call, 15 minutes before the deadline, to everyone without a success yet
  for (const inst of w.instances) {
    if (inst.status === 'open' && inst.finalCallAt === null && w.now >= inst.deadlineAt - FINAL_CALL_BEFORE_MS) {
      inst.finalCallAt = w.now;
      const waiting = inst.roster.filter((id) => !visibleCheckins(w, inst.id, id).some((c) => c.verdict === 'in_fence'));
      event(w, 'final_call', `Final call · ${w.pact.title} closes at ${fmtTime(inst.deadlineAt, w.pact.tz)} (${waiting.length} not in yet)`, inst.id);
    }
  }
  // gate closed
  for (const inst of w.instances) {
    if (inst.status === 'open' && w.now >= inst.deadlineAt) closeInstance(w, inst);
  }
  // Monday noon settlements for every finished week not yet settled
  settleDue(w);
  w.seenUntil = w.now;
}

function generateInstances(w: World): void {
  const horizon = localDateOf(w.now + 7 * DAY, w.pact.tz);
  let d = w.startLocalDate;
  while (d <= horizon) {
    if (w.pact.days.includes(weekdayOf(d)) && !w.instances.some((i) => i.localDate === d)) {
      w.instances.push({
        id: `inst-${d}`,
        localDate: d,
        windowOpenAt: instantOf(d, w.pact.windowOpenLocal, w.pact.tz),
        deadlineAt: instantOf(d, w.pact.deadlineLocal, w.pact.tz),
        status: 'scheduled',
        carryInCents: null,
        closedAt: null,
        settledAt: null,
        finalCallAt: null,
        roster: [...MEMBER_IDS],
        results: {},
        baseResults: {},
      });
    }
    d = addDays(d, 1);
  }
  w.instances.sort((a, b) => a.windowOpenAt - b.windowOpenAt);
}

/** Boarding: the window opens and the friends' scripted taps for the day are scheduled. */
function openWindow(w: World, inst: Instance): void {
  inst.status = 'open';
  event(w, 'boarding', `Boarding · ${w.pact.title} is open until ${fmtTime(inst.deadlineAt, w.pact.tz)}`, inst.id);
  for (const id of FRIEND_IDS) scriptFriend(w, inst, id, w.behaviours[id]);
}

function scriptFriend(w: World, inst: Instance, id: FriendId, behaviour: Behaviour): void {
  const place = memberById(w, id).place;
  const tapAt = inst.windowOpenAt + FRIEND_TAP_OFFSET_MIN[id] * MINUTE;
  const fixAt = (dxM: number, accuracyM: number | null) => ({
    lat: place.lat,
    lng: place.lng + dxM / (111_320 * Math.cos((place.lat * Math.PI) / 180)),
    accuracyM,
    isSimulated: false,
  });
  const push = (fix: ReturnType<typeof fixAt>, clientAt: number, serverAt: number) => {
    const { verdict, distanceM } = checkinVerdict(fix, place);
    w.checkins.push({
      id: `c${++w.seq}`,
      instanceId: inst.id,
      userId: id,
      verdict,
      distanceM,
      accuracyM: fix.accuracyM,
      clientCapturedAt: clientAt,
      serverReceivedAt: serverAt,
    });
  };
  switch (behaviour) {
    case 'on_time':
      push(fixAt(8, 15), tapAt, tapAt);
      break;
    case 'out_of_fence':
      push(fixAt(place.radiusM + 180, 15), tapAt, tapAt);
      break;
    case 'no_gps':
      push(fixAt(0, 350), tapAt, tapAt);
      break;
    case 'late_offline': {
      // tapped in the fence inside the window, offline; the queue drains minutes after the deadline
      const clientAt = inst.deadlineAt - 6 * MINUTE;
      push(fixAt(5, 15), clientAt, inst.deadlineAt + 4 * MINUTE);
      break;
    }
    case 'frozen': {
      const week = isoWeekOf(inst.localDate);
      const already = w.freezes.some((f) => f.userId === id && f.isoWeek === week);
      if (!already) {
        w.freezes.push({ id: `f${++w.seq}`, instanceId: inst.id, userId: id, isoWeek: week, declaredAt: inst.windowOpenAt - 30 * MINUTE });
      } else {
        event(w, 'note', `${firstName(w, id)} already froze a day this week, so today counts normally.`, inst.id);
      }
      break;
    }
    case 'no_show':
      break;
  }
}

/** A late tap (received after the deadline, within the grace) recomputes its day like `check_in_at`. */
function applyArrivals(w: World): void {
  const fresh = w.checkins.filter(
    (c) => c.serverReceivedAt !== null && c.serverReceivedAt > w.seenUntil && c.serverReceivedAt <= w.now,
  );
  arrive(w, fresh);
}

/** Newly received taps: the ones landing on a closed day are late taps and recompute that day. */
function arrive(w: World, fresh: readonly Checkin[]): void {
  const touched = new Set<string>();
  for (const c of fresh) {
    const inst = instanceById(w, c.instanceId);
    if (inst.status === 'closed' || inst.status === 'voided' || inst.status === 'settled') {
      if (c.serverReceivedAt! > inst.deadlineAt + LATE_TAP_GRACE_MS) {
        event(w, 'note', `${firstName(w, c.userId)}'s tap arrived more than a day after the deadline and is not judged.`, inst.id);
        continue;
      }
      touched.add(inst.id);
      event(
        w,
        'late_tap',
        `${firstName(w, c.userId)}'s tap from ${fmtTime(c.clientCapturedAt, w.pact.tz)} arrived at ${fmtTime(c.serverReceivedAt!, w.pact.tz)}, after the deadline.`,
        inst.id,
      );
    }
  }
  for (const id of touched) refreshInstance(w, instanceById(w, id));
}

// ---------- results and money ----------

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Raw per-participant statuses before the void rule. `computeResults` voids active statuses when
 * fewer than two are active, so to read the underlying status of every participant (which the
 * revival rule RT-2 needs) two phantom participants with no check-ins are added: they are always
 * `failed`, which keeps the day active, and are dropped from the answer. The per-person logic is
 * still entirely the oracle's.
 */
function rawResults(w: World, inst: Instance): Record<MemberId, ParticipantResult> {
  const checkins = visibleCheckins(w, inst.id)
    .filter((c) => c.serverReceivedAt! <= inst.deadlineAt + LATE_TAP_GRACE_MS)
    .map((c) => ({
      userId: c.userId,
      verdict: c.verdict,
      serverReceivedAt: iso(c.serverReceivedAt!),
      clientCapturedAt: iso(c.clientCapturedAt),
    }));
  const participants = [
    ...inst.roster.map((id) => ({ userId: id, frozen: hasFreeze(w, inst.id, id) })),
    { userId: '~phantom-a', frozen: false },
    { userId: '~phantom-b', frozen: false },
  ];
  const { results } = computeResults({ deadlineAt: iso(inst.deadlineAt), participants, checkins });
  const out = {} as Record<MemberId, ParticipantResult>;
  for (const r of results) if (!r.userId.startsWith('~phantom')) out[r.userId as MemberId] = r;
  return out;
}

function resolvedReviewsFor(w: World, inst: Instance, subject: MemberId): ReviewOutcome[] {
  return w.reviews
    .filter((r) => r.instanceId === inst.id && r.subject === subject && r.status !== 'open')
    .sort((a, b) => a.resolvedAt! - b.resolvedAt! || a.openedAt - b.openedAt)
    .map((r) => ({ kind: r.kind, status: r.status }));
}

/**
 * `_refresh_result` for a whole day: base results from check-ins, resolved reviews applied, then the
 * void rule across the roster. Revives a voided day when reviews leave two or more active (RT-2).
 */
function recomputeResults(w: World, inst: Instance): void {
  const raw = rawResults(w, inst);
  const deadlineIso = iso(inst.deadlineAt);
  const effective = {} as Record<MemberId, ParticipantResult>;
  for (const id of inst.roster) effective[id] = applyReviews(raw[id]!, deadlineIso, resolvedReviewsFor(w, inst, id));
  const active = inst.roster.filter((id) => effective[id]!.status === 'success' || effective[id]!.status === 'failed').length;
  // the oracle's own void rule on the base results (what the day looked like with no reviews)
  const base = computeResults({
    deadlineAt: deadlineIso,
    participants: inst.roster.map((id) => ({ userId: id, frozen: hasFreeze(w, inst.id, id) })),
    checkins: visibleCheckins(w, inst.id)
      .filter((c) => c.serverReceivedAt! <= inst.deadlineAt + LATE_TAP_GRACE_MS)
      .map((c) => ({ userId: c.userId, verdict: c.verdict, serverReceivedAt: iso(c.serverReceivedAt!), clientCapturedAt: iso(c.clientCapturedAt) })),
  });
  inst.baseResults = Object.fromEntries(base.results.map((r) => [r.userId, r])) as Partial<Record<MemberId, ParticipantResult>>;
  if (active < 2) {
    for (const id of inst.roster) {
      const r = effective[id]!;
      if (r.status === 'success' || r.status === 'failed') effective[id] = { userId: id, status: 'void', firstSuccessAt: null };
    }
    if (inst.status === 'closed') {
      inst.status = 'voided';
      inst.carryInCents = null;
    }
  } else if (inst.status === 'voided') {
    // revived: a revived day never draws carry deposited after it
    inst.status = 'closed';
    inst.carryInCents = 0;
    event(w, 'note', `${fmtDateShort(inst.localDate)} counts after all: two or more people are in it now.`, inst.id);
  }
  inst.results = effective;
}

/** Target net per account for a closed day, from the oracle, with the carry stored at close. */
function targetLines(w: World, inst: Instance): { memberDeltas: Record<string, number>; carryDelta: number } {
  if (inst.status !== 'closed' && inst.status !== 'settled') return { memberDeltas: {}, carryDelta: 0 };
  return computeInstancePayout({
    stakeCents: w.pact.stakeCents,
    carryInCents: inst.carryInCents ?? 0,
    results: inst.roster.map((id) => inst.results[id]!),
  });
}

/**
 * Post the day's money: `stake` then `payout` or `rollover` the first time (CONTRACT.md Payout);
 * afterwards the difference between the oracle's target and what is posted goes into one
 * `correction:<instance>:<n>` entry. Past entries are never edited.
 */
function reconcileMoney(w: World, inst: Instance): void {
  const posted = postedForInstance(w, inst.id);
  const { memberDeltas, carryDelta } = targetLines(w, inst);
  const stake = w.pact.stakeCents;
  const pot = potAccount(inst.id);
  const carry = carryAccount(w.pact.id);
  const day = fmtDateShort(inst.localDate);
  const target = new Map<string, number>();
  for (const [id, v] of Object.entries(memberDeltas)) target.set(memberAccount(id as MemberId), v);
  if (carryDelta !== 0) target.set(carry, carryDelta);

  const nothingPosted = w.entries.every((e) => e.instanceId !== inst.id);
  if (nothingPosted) {
    if (target.size === 0) return;
    const losers = Object.entries(memberDeltas).filter(([, v]) => v < 0);
    const winners = Object.entries(memberDeltas).filter(([, v]) => v > 0);
    const stakeLines: LedgerLine[] = [];
    for (const [id] of losers) stakeLines.push({ account: memberAccount(id as MemberId), amountCents: -stake }, { account: pot, amountCents: stake });
    if (carryDelta < 0) stakeLines.push({ account: carry, amountCents: carryDelta }, { account: pot, amountCents: -carryDelta });
    postEntry(w, 'stake', `stake:${inst.id}`, inst.id, `${day}: pledges forfeited to the pool`, stakeLines);
    if (winners.length > 0) {
      const payoutLines: LedgerLine[] = winners.map(([id, v]) => ({ account: memberAccount(id as MemberId), amountCents: v }));
      payoutLines.push({ account: pot, amountCents: -winners.reduce((a, [, v]) => a + v, 0) });
      postEntry(w, 'payout', `payout:${inst.id}`, inst.id, `${day}: pool split among everyone who showed up`, payoutLines);
    } else if (carryDelta > 0) {
      postEntry(w, 'rollover', `rollover:${inst.id}`, inst.id, `${day}: nobody showed up, pool carried to the next day`, [
        { account: pot, amountCents: -carryDelta },
        { account: carry, amountCents: carryDelta },
      ]);
    }
    return;
  }

  const diff: LedgerLine[] = [];
  const accounts = new Set<string>([...posted.keys(), ...target.keys()]);
  accounts.delete(pot);
  for (const a of accounts) {
    const d = (target.get(a) ?? 0) - (posted.get(a) ?? 0);
    if (d !== 0) diff.push({ account: a, amountCents: d });
  }
  if (diff.length === 0) return;
  diff.push({ account: pot, amountCents: -diff.reduce((a, l) => a + l.amountCents, 0) });
  const n = w.entries.filter((e) => e.kind === 'correction' && e.instanceId === inst.id).length + 1;
  const id = postEntry(w, 'correction', `correction:${inst.id}:${n}`, inst.id, `${day}: result changed, difference posted`, diff);
  if (id) {
    const youLine = diff.find((l) => l.account === memberAccount('you'));
    event(w, 'correction', `Correction for ${day}${youLine ? `: you ${youLine.amountCents > 0 ? 'get back' : 'owe'} ${fmtCents(Math.abs(youLine.amountCents))}` : ''}.`, inst.id);
  }
}

/** Results, money and the unverified budget, in that order; what every change to a day runs. */
function refreshInstance(w: World, inst: Instance): void {
  recomputeResults(w, inst);
  reconcileMoney(w, inst);
  checkUnverifiedBudget(w, inst);
}

function closeInstance(w: World, inst: Instance): void {
  inst.status = 'closed';
  inst.closedAt = w.now;
  inst.carryInCents = carryBalance(w);
  recomputeResults(w, inst);
  if ((inst.status as Instance['status']) === 'voided') inst.carryInCents = null;
  reconcileMoney(w, inst);
  const posted = postedForInstance(w, inst.id);
  const youDelta = posted.get(memberAccount('you')) ?? 0;
  event(w, 'gate_closed', gateClosedText(w, inst, youDelta), inst.id, { youDeltaCents: youDelta });
  checkUnverifiedBudget(w, inst);
}

export function gateClosedText(w: World, inst: Instance, youDelta: number): string {
  if (inst.status === 'voided') return "Gate closed · Didn't count: fewer than two people were in it. No money moved.";
  const missed = inst.roster.filter((id) => id !== 'you' && inst.results[id]?.status === 'failed').map((id) => firstName(w, id));
  const mine = inst.results.you?.status;
  const head = youDelta > 0 ? `You're +${fmtCents(youDelta)} today` : youDelta < 0 ? `You forfeited ${fmtCents(-youDelta)} today` : mine === 'unverified' ? 'Unverified today, no money moved' : mine === 'frozen' ? 'Frozen today, no money moved' : 'Nothing moved today';
  const tail = missed.length === 0 ? 'everyone showed up' : `${listNames(missed)} missed`;
  return `Gate closed · ${head} — ${tail}`;
}

export function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** More than 2 unverified days in a pact in a calendar month opens a system challenge (N2). */
function checkUnverifiedBudget(w: World, inst: Instance): void {
  for (const id of inst.roster) {
    if (inst.results[id]?.status !== 'unverified') continue;
    if (reviewsFor(w, inst.id, id).length > 0) continue;
    const month = monthOf(inst.localDate);
    const count = w.instances.filter(
      (i) => (i.status === 'closed' || i.status === 'voided' || i.status === 'settled') && monthOf(i.localDate) === month && i.results[id]?.status === 'unverified',
    ).length;
    if (count > 2) {
      const review: Review = {
        id: `r${++w.seq}`,
        instanceId: inst.id,
        subject: id,
        openedBy: id,
        kind: 'challenge',
        reason: 'Automatic: more than 2 unverified days this month',
        status: 'open',
        systemOpened: true,
        votes: {},
        openedAt: w.now,
        resolvedAt: null,
      };
      w.reviews.push(review);
      event(w, 'review_opened', `${firstName(w, id)}'s third unverified day this month opened an automatic challenge. The group votes.`, inst.id);
    }
  }
}

// ---------- your controls ----------

export function setGps(w0: World, patch: Partial<Pick<YouState, 'dx' | 'dy' | 'accuracyM'>>): World {
  const w = structuredClone(w0);
  Object.assign(w.you, patch);
  w.you.accuracyM = Math.max(1, Math.round(w.you.accuracyM));
  w.you.dx = Math.round(w.you.dx);
  w.you.dy = Math.round(w.you.dy);
  return w;
}

export function setLocationMode(w0: World, mode: LocationMode): World {
  const w = structuredClone(w0);
  w.you.locationMode = mode;
  return w;
}

/** Going back online drains the offline queue: each queued tap is received now (maybe late). */
export function setOnline(w0: World, online: boolean): World {
  const w = structuredClone(w0);
  w.you.online = online;
  if (online) {
    const queued = queuedCheckins(w);
    for (const c of queued) c.serverReceivedAt = w.now;
    if (queued.length > 0) {
      event(w, 'checkin', `Back online: ${queued.length} saved tap${queued.length === 1 ? '' : 's'} sent at ${fmtTime(w.now, w.pact.tz)}.`, queued[0]!.instanceId);
      arrive(w, queued);
    }
    w.seenUntil = w.now;
  }
  return w;
}

export function setBehaviour(w0: World, id: FriendId, behaviour: Behaviour): World {
  const w = structuredClone(w0);
  w.behaviours[id] = behaviour;
  return w;
}

export type CheckInOutcome =
  | { kind: 'sent'; checkin: Checkin }
  | { kind: 'queued'; checkin: Checkin }
  | { kind: 'refused'; mode: 'approximate' | 'denied' }
  | { kind: 'not_open' }
  | { kind: 'frozen' };

/**
 * The Check In tap. Precise + online → judged by the rules at once. Offline → queued with its tap
 * time. Approximate Location or no permission → refused on the device, nothing sent (N2-5).
 */
export function checkIn(w0: World): { world: World; outcome: CheckInOutcome } {
  const inst = openInstance(w0);
  if (!inst) return { world: w0, outcome: { kind: 'not_open' } };
  if (hasFreeze(w0, inst.id, 'you')) return { world: w0, outcome: { kind: 'frozen' } };
  const w = structuredClone(w0);
  const current = openInstance(w)!;
  const place = memberById(w, 'you').place;
  if (w.you.locationMode !== 'precise') {
    const mode = w.you.locationMode;
    const wouldHave =
      mode === 'approximate'
        ? (() => {
            const v = checkinVerdict({ ...youFix(w), accuracyM: APPROXIMATE_ACCURACY_M }, place);
            return { verdict: v.verdict, status: 'unverified' as const, note: `A ±${APPROXIMATE_ACCURACY_M} m fix is unjudgeable, so the rules would have said Unverified (no money moves). The app refuses to send it, so today counts as Missed.` };
          })()
        : { verdict: null, status: 'failed' as const, note: 'Nothing can be sent without location, so today counts as Missed.' };
    w.refusedTaps.push({ id: `t${++w.seq}`, instanceId: current.id, at: w.now, mode, wouldHave });
    event(w, 'refused', mode === 'approximate' ? 'Precise Location is off: nothing was sent.' : 'Location is off for Final Call: nothing was sent.', current.id);
    return { world: w, outcome: { kind: 'refused', mode } };
  }
  const fix = youFix(w);
  const { verdict, distanceM } = checkinVerdict(fix, place);
  const checkin: Checkin = {
    id: `c${++w.seq}`,
    instanceId: current.id,
    userId: 'you',
    verdict,
    distanceM,
    accuracyM: fix.accuracyM,
    clientCapturedAt: w.now,
    serverReceivedAt: w.you.online ? w.now : null,
  };
  w.checkins.push(checkin);
  if (!w.you.online) {
    event(w, 'queued', `Saved offline at ${fmtTime(w.now, w.pact.tz)}; sends when you're back online.`, current.id);
    return { world: w, outcome: { kind: 'queued', checkin } };
  }
  event(w, 'checkin', `You tapped at ${fmtTime(w.now, w.pact.tz)}: ${verdictWord(verdict)} (${Math.round(distanceM)} m, ±${fix.accuracyM} m).`, current.id);
  w.seenUntil = w.now;
  return { world: w, outcome: { kind: 'sent', checkin } };
}

export function verdictWord(v: Checkin['verdict']): string {
  return v === 'in_fence' ? 'at your place' : v === 'out_of_fence' ? 'not at your place yet' : v === 'unjudgeable' ? 'GPS too weak to judge' : 'rejected (simulated)';
}

/** Freeze the next day for you, before its window opens; one per ISO week. */
export function freezeToday(w0: World): World {
  const inst = nextScheduled(w0);
  if (!inst) return w0;
  const week = isoWeekOf(inst.localDate);
  if (w0.freezes.some((f) => f.userId === 'you' && f.isoWeek === week)) return w0;
  const w = structuredClone(w0);
  w.freezes.push({ id: `f${++w.seq}`, instanceId: inst.id, userId: 'you', isoWeek: week, declaredAt: w.now });
  event(w, 'note', `You froze ${fmtDateShort(inst.localDate)}. It won't count for or against you.`, inst.id);
  return w;
}

// ---------- reviews ----------

export function canOpenReview(w: World, instanceId: string, subject: MemberId, kind: ReviewKind, openedBy: MemberId): boolean {
  const inst = instanceById(w, instanceId);
  const r = inst.results[subject];
  if (!r) return false;
  if (reviewsFor(w, instanceId, subject).some((x) => x.kind === kind)) return false;
  if (reviewsFor(w, instanceId, subject).some((x) => x.status === 'open')) return false;
  if (kind === 'appeal') return openedBy === subject && r.status === 'failed' && inst.status === 'closed';
  if (openedBy === subject) return false;
  if (inst.status === 'voided') return r.status === 'unverified';
  if (inst.status !== 'closed') return false;
  return r.status === 'success' || r.status === 'unverified';
}

export function openReview(w0: World, instanceId: string, subject: MemberId, kind: ReviewKind, openedBy: MemberId, reason: string): World {
  if (!canOpenReview(w0, instanceId, subject, kind, openedBy)) return w0;
  const w = structuredClone(w0);
  const review: Review = {
    id: `r${++w.seq}`,
    instanceId,
    subject,
    openedBy,
    kind,
    reason,
    status: 'open',
    systemOpened: false,
    votes: {},
    openedAt: w.now,
    resolvedAt: null,
  };
  w.reviews.push(review);
  const inst = instanceById(w, instanceId);
  event(
    w,
    'review_opened',
    kind === 'appeal' ? `${firstName(w, subject)} appealed ${fmtDateShort(inst.localDate)}.` : `${firstName(w, openedBy)} challenged ${firstName(w, subject)}'s ${fmtDateShort(inst.localDate)}.`,
    instanceId,
  );
  return w;
}

/** `cast_vote`: majority of the eligible voters resolves at once; otherwise it waits for settlement. */
export function castVote(w0: World, reviewId: string, voter: MemberId, supports: boolean): World {
  const review0 = w0.reviews.find((r) => r.id === reviewId);
  if (!review0 || review0.status !== 'open' || !eligibleVoters(w0, review0).includes(voter)) return w0;
  const w = structuredClone(w0);
  const review = w.reviews.find((r) => r.id === reviewId)!;
  review.votes[voter] = supports;
  event(w, 'vote', `${firstName(w, voter)} voted: ${voteLabel(review, supports)}.`, review.instanceId);
  const eligible = eligibleVoters(w, review).length;
  const yes = Object.values(review.votes).filter((v) => v === true).length;
  const no = Object.values(review.votes).filter((v) => v === false).length;
  if (2 * yes > eligible) resolveReview(w, review, 'accepted');
  else if (2 * no > eligible) resolveReview(w, review, 'rejected');
  return w;
}

/** Outcome-named votes: what the voter is saying happened, never yes/no. */
export function voteLabel(review: Pick<Review, 'kind'>, supports: boolean): string {
  if (review.kind === 'appeal') return supports ? 'they showed up' : "they didn't";
  return supports ? "they weren't there" : 'they were there';
}

function resolveReview(w: World, review: Review, status: 'accepted' | 'rejected' | 'defaulted'): void {
  review.status = status;
  review.resolvedAt = w.now;
  const inst = instanceById(w, review.instanceId);
  const word = status === 'accepted' ? 'upheld' : status === 'rejected' ? 'turned down' : 'no votes, the result stands';
  event(w, 'review_resolved', `${firstName(w, review.subject)}'s ${fmtDateShort(inst.localDate)} ${review.kind}: ${word}.`, inst.id);
  refreshInstance(w, inst);
}

// ---------- settlement ----------

function settleDue(w: World): void {
  // every week whose Monday-noon settlement moment has passed, from the first pact week on
  let weekStart = weekStartOf(w.startLocalDate);
  const nowDate = localDateOf(w.now, w.pact.tz);
  while (weekStart <= nowDate) {
    const runAt = instantOf(addDays(weekStart, 7), '12:00', w.pact.tz);
    if (runAt <= w.now && !w.settlements.some((s) => s.weekStart === weekStart)) settleWeek(w, weekStart);
    weekStart = addDays(weekStart, 7);
  }
}

/** `settle_due_groups` for one group and week (CONTRACT.md Settlement). Idempotent per week. */
function settleWeek(w: World, weekStart: string): void {
  const weekEnd = addDays(weekStart, 6);
  const inWeek = w.instances.filter((i) => i.localDate >= weekStart && i.localDate <= weekEnd);
  // 1. reviews still open default by the votes cast
  for (const r of w.reviews) {
    if (r.status !== 'open' || !inWeek.some((i) => i.id === r.instanceId)) continue;
    const yes = Object.values(r.votes).filter((v) => v === true).length;
    const no = Object.values(r.votes).filter((v) => v === false).length;
    resolveReview(w, r, settlementReviewStatus(yes, no));
  }
  // 2. corrections are already posted by refreshInstance; mark the week's days settled
  for (const i of inWeek) {
    if (i.status === 'closed' || i.status === 'voided') {
      i.settledAt = w.now;
      if (i.status === 'closed') i.status = 'settled';
    }
  }
  // 3. previous pending obligations are replaced; marked-paid ones survive as provisionally paid
  for (const o of w.obligations) if (o.status === 'pending') o.status = 'superseded';
  // 4. billable balances: settled days plus settlement payments; marked-paid amounts count as paid (W-3)
  const balances = billableBalances(w);
  const { obligations, ridingInCarryCents } = simplifyDebts(balances);
  const settlementId = `s${++w.seq}`;
  w.settlements.push({ id: settlementId, weekStart, ranAt: w.now, ridingInCarryCents });
  for (const o of obligations) {
    w.obligations.push({
      id: `o${++w.seq}`,
      settlementId,
      from: o.from as MemberId,
      to: o.to as MemberId,
      amountCents: o.amountCents,
      status: 'pending',
      markedPaidAt: null,
      confirmedAt: null,
    });
  }
  const you = obligations.filter((o) => o.from === 'you' || o.to === 'you');
  const owed = you.filter((o) => o.to === 'you').reduce((a, o) => a + o.amountCents, 0);
  const owe = you.filter((o) => o.from === 'you').reduce((a, o) => a + o.amountCents, 0);
  event(w, 'settlement', `Settle-up for the week of ${fmtDateShort(weekStart)}: ${obligations.length} payment${obligations.length === 1 ? '' : 's'}${owed - owe > 0 ? `, you're owed ${fmtCents(owed - owe)}` : owed - owe < 0 ? `, you owe ${fmtCents(owe - owed)}` : ', you are square'}.`);
}

/** `billable_member_balances`, less what is marked paid and awaiting confirmation. */
export function billableBalances(w: World): Record<MemberId, number> {
  const settledIds = new Set(w.instances.filter((i) => i.status === 'settled').map((i) => i.id));
  const balances = memberBalances(w, (e) => e.instanceId === null || settledIds.has(e.instanceId));
  for (const o of w.obligations) {
    if (o.status !== 'marked_paid') continue;
    balances[o.from] += o.amountCents;
    balances[o.to] -= o.amountCents;
  }
  return balances;
}

// ---------- settle-up actions (Venmo-style) ----------

export function markObligationPaid(w0: World, obligationId: string): World {
  const o0 = w0.obligations.find((o) => o.id === obligationId);
  if (!o0 || o0.status !== 'pending') return w0;
  const w = structuredClone(w0);
  const o = w.obligations.find((x) => x.id === obligationId)!;
  o.status = 'marked_paid';
  o.markedPaidAt = w.now;
  event(w, 'payment', `${firstName(w, o.from)} marked ${fmtCents(o.amountCents)} to ${firstName(w, o.to)} as paid on Venmo.`);
  return w;
}

/** The payee confirms: the one place a settlement payment reaches the ledger (`payment:<id>`). */
export function confirmObligation(w0: World, obligationId: string): World {
  const o0 = w0.obligations.find((o) => o.id === obligationId);
  if (!o0 || (o0.status !== 'pending' && o0.status !== 'marked_paid')) return w0;
  const w = structuredClone(w0);
  const o = w.obligations.find((x) => x.id === obligationId)!;
  o.status = 'confirmed';
  o.confirmedAt = w.now;
  postEntry(w, 'settlement_payment', `payment:${o.id}`, null, `${firstName(w, o.from)} paid ${firstName(w, o.to)} on Venmo`, [
    { account: memberAccount(o.to), amountCents: -o.amountCents },
    { account: memberAccount(o.from), amountCents: o.amountCents },
  ]);
  event(w, 'payment', `${firstName(w, o.to)} confirmed ${fmtCents(o.amountCents)} from ${firstName(w, o.from)}.`);
  return w;
}

export function disputeObligation(w0: World, obligationId: string): World {
  const o0 = w0.obligations.find((o) => o.id === obligationId);
  if (!o0 || o0.status !== 'marked_paid') return w0;
  const w = structuredClone(w0);
  const o = w.obligations.find((x) => x.id === obligationId)!;
  o.status = 'pending';
  o.markedPaidAt = null;
  event(w, 'payment', `${firstName(w, o.to)} hasn't received ${fmtCents(o.amountCents)} from ${firstName(w, o.from)}; back to unpaid.`);
  return w;
}

// ---------- transitions (the fast-forward buttons) ----------

export type Transition = 'next_window' | 'final_call' | 'gate_closed' | 'next_day' | 'monday_noon';

export const TRANSITION_LABEL: Record<Transition, string> = {
  next_window: 'Next window',
  final_call: 'Final call',
  gate_closed: 'Gate closed',
  next_day: 'Next day',
  monday_noon: 'Monday noon',
};

/** The instant a transition jumps to, or null when there is nothing ahead of that kind. */
export function transitionTarget(w: World, t: Transition): number | null {
  const open = openInstance(w);
  const next = nextScheduled(w);
  switch (t) {
    case 'next_window':
      return next ? next.windowOpenAt : null;
    case 'final_call': {
      if (open && w.now < open.deadlineAt - FINAL_CALL_BEFORE_MS) return open.deadlineAt - FINAL_CALL_BEFORE_MS;
      return next ? next.deadlineAt - FINAL_CALL_BEFORE_MS : null;
    }
    case 'gate_closed': {
      if (open) return open.deadlineAt + MINUTE;
      return next ? next.deadlineAt + MINUTE : null;
    }
    case 'next_day': {
      const tomorrow = addDays(localDateOf(w.now, w.pact.tz), 1);
      return instantOf(tomorrow, '07:00', w.pact.tz);
    }
    case 'monday_noon': {
      // the next settlement moment that has a week of pact days to settle (Monday's own 8–9 window
      // happens on the way, as it does in real life)
      let monday = weekStartOf(localDateOf(w.now, w.pact.tz));
      for (let i = 0; i < 3; i++) {
        const noon = instantOf(monday, '12:00', w.pact.tz);
        const weekHasDays = w.instances.some((inst) => inst.localDate < monday && inst.localDate >= addDays(monday, -7));
        if (noon > w.now && weekHasDays) return noon;
        monday = addDays(monday, 7);
      }
      return null;
    }
  }
}

export function transition(w: World, t: Transition): World {
  const target = transitionTarget(w, t);
  return target === null ? w : advanceTo(w, target);
}

// ---------- derived views ----------

/** Your net for one day as posted (corrections included). */
export function youDeltaFor(w: World, instanceId: string): number {
  return postedForInstance(w, instanceId).get(memberAccount('you')) ?? 0;
}

export function memberDeltaFor(w: World, instanceId: string, id: MemberId): number {
  return postedForInstance(w, instanceId).get(memberAccount(id)) ?? 0;
}

/** The latest gate-closed event not yet seen by the UI, for the reveal. */
export function latestGateClosed(w: World): SimEvent | null {
  for (let i = w.events.length - 1; i >= 0; i--) {
    const e = w.events[i]!;
    if (e.kind === 'gate_closed') return e;
  }
  return null;
}

/** Live "2 of 4 checked in" for the home card. */
export function checkedInIds(w: World, inst: Instance): MemberId[] {
  if (inst.status === 'closed' || inst.status === 'settled' || inst.status === 'voided') {
    return inst.roster.filter((id) => inst.results[id]?.status === 'success');
  }
  return inst.roster.filter((id) => visibleCheckins(w, inst.id, id).some((c) => c.verdict === 'in_fence'));
}

/** Your live state on a day before the result posts, in the app's words. */
export type LiveState = 'waiting' | 'checked_in' | 'out_of_fence' | 'unjudged' | 'queued' | 'frozen' | 'refused';

export function yourLiveState(w: World, inst: Instance): LiveState {
  if (hasFreeze(w, inst.id, 'you')) return 'frozen';
  const mine = visibleCheckins(w, inst.id, 'you');
  if (mine.some((c) => c.verdict === 'in_fence')) return 'checked_in';
  if (queuedCheckins(w, inst.id).length > 0) return 'queued';
  const last = mine.at(-1);
  if (last?.verdict === 'out_of_fence') return 'out_of_fence';
  if (last?.verdict === 'unjudgeable') return 'unjudged';
  if (w.refusedTaps.some((t) => t.instanceId === inst.id)) return 'refused';
  return 'waiting';
}

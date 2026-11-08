/**
 * Realistic in-memory data for demo mode. Everything hangs off `DEMO_T0`, the instant the module
 * loaded, so "today" always has an instance before its window, one open with 2 of 4 checked in,
 * one closed with every result kind, and one voided. The store is mutable: demo RPCs push rows
 * into it so refetches show the change.
 */
import { addDaysToLocalDate, isoWeekday, localDateInZone, zonedLocalToUtc } from '../../lib/time';
import type {
  CheckinRow,
  FreezeRow,
  GroupMemberRow,
  GroupRow,
  InstanceMemberNetRow,
  MemberBalanceRow,
  ObligationRow,
  PactInstanceRow,
  PactParticipantPlaceRow,
  PactParticipantRow,
  PactRow,
  PlaceEventRow,
  ProfileRow,
  ResultRow,
  ReviewRow,
  ReviewVoteRow,
  SettlementRow,
} from '../types';
import { DEMO_USER_ID } from './settings';

export const DEMO_T0 = Date.now();
export const TZ = 'America/Los_Angeles';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const iso = (ms: number) => new Date(ms).toISOString();
const ago = (ms: number) => iso(DEMO_T0 - ms);
const ahead = (ms: number) => iso(DEMO_T0 + ms);

export const USERS = {
  you: DEMO_USER_ID,
  maya: 'u-maya',
  diego: 'u-diego',
  priya: 'u-priya',
} as const;

export const profiles: ProfileRow[] = [
  { id: USERS.you, display_name: 'Sam Okafor', venmo_username: 'sam-okafor', created_at: ago(60 * DAY) },
  { id: USERS.maya, display_name: 'Maya Chen', venmo_username: 'maya-chen', created_at: ago(58 * DAY) },
  { id: USERS.diego, display_name: 'Diego Alvarez', venmo_username: null, created_at: ago(57 * DAY) },
  { id: USERS.priya, display_name: 'Priya Nair', venmo_username: 'priyanair', created_at: ago(55 * DAY) },
];

export const GROUP_ID = 'g1';
export const EMPTY_GROUP_ID = 'g-empty';
export const INVITE_CODE = 'KANE9AM';

export const groups: GroupRow[] = [
  { id: GROUP_ID, name: 'Morning crew', invite_code: INVITE_CODE, settlement_tz: TZ, created_by: USERS.you, created_at: ago(42 * DAY) },
  { id: EMPTY_GROUP_ID, name: 'New group', invite_code: 'FRESH01', settlement_tz: TZ, created_by: USERS.you, created_at: ago(5 * MIN) },
];

export const members: GroupMemberRow[] = [
  { group_id: GROUP_ID, user_id: USERS.you, role: 'owner', joined_at: ago(42 * DAY), left_at: null },
  { group_id: GROUP_ID, user_id: USERS.maya, role: 'member', joined_at: ago(41 * DAY), left_at: null },
  { group_id: GROUP_ID, user_id: USERS.diego, role: 'member', joined_at: ago(41 * DAY), left_at: null },
  { group_id: GROUP_ID, user_id: USERS.priya, role: 'member', joined_at: ago(40 * DAY), left_at: null },
  { group_id: EMPTY_GROUP_ID, user_id: USERS.you, role: 'owner', joined_at: ago(5 * MIN), left_at: null },
];

export const PACTS = { classA: 'p1', gym: 'p2', run: 'p3', library: 'p4' } as const;

export const pacts: PactRow[] = [
  { id: PACTS.classA, group_id: GROUP_ID, title: '9am in Kane Hall', days_of_week: [1, 2, 3, 4, 5], window_open_local: '08:00:00', deadline_local: '09:00:00', stake_cents: 500, tz: TZ, paused: false, created_by: USERS.you, created_at: ago(40 * DAY) },
  { id: PACTS.gym, group_id: GROUP_ID, title: 'Gym before dinner', days_of_week: [1, 3, 5], window_open_local: '16:30:00', deadline_local: '18:00:00', stake_cents: 300, tz: TZ, paused: false, created_by: USERS.maya, created_at: ago(30 * DAY) },
  { id: PACTS.run, group_id: GROUP_ID, title: 'Sunrise run', days_of_week: [1, 2, 3, 4, 5, 6, 7], window_open_local: '06:00:00', deadline_local: '07:00:00', stake_cents: 200, tz: TZ, paused: false, created_by: USERS.diego, created_at: ago(28 * DAY) },
  { id: PACTS.library, group_id: GROUP_ID, title: 'Library by 8', days_of_week: [1, 2, 3, 4], window_open_local: '19:00:00', deadline_local: '20:00:00', stake_cents: 100, tz: TZ, paused: true, created_by: USERS.priya, created_at: ago(20 * DAY) },
];

const place = (pactId: string, userId: string, lat: number, lng: number, radius: number, label: string, joinedAgo: number): PactParticipantRow => ({
  pact_id: pactId,
  user_id: userId,
  place_lat: lat,
  place_lng: lng,
  place_radius_m: radius,
  place_label: label,
  joined_at: ago(joinedAgo),
  left_at: null,
});

export const participants: PactParticipantRow[] = [
  place(PACTS.classA, USERS.you, 47.6567, -122.309, 75, 'Kane Hall', 40 * DAY),
  place(PACTS.classA, USERS.maya, 47.6534, -122.3078, 60, 'Savery Hall', 39 * DAY),
  place(PACTS.classA, USERS.diego, 47.6553, -122.3105, 100, 'Mary Gates', 39 * DAY),
  place(PACTS.classA, USERS.priya, 47.6567, -122.309, 75, 'Kane Hall', 38 * DAY),
  place(PACTS.gym, USERS.you, 47.6536, -122.3017, 120, 'IMA', 30 * DAY),
  place(PACTS.gym, USERS.maya, 47.6536, -122.3017, 120, 'IMA', 29 * DAY),
  place(PACTS.gym, USERS.priya, 47.6536, -122.3017, 120, 'IMA', 28 * DAY),
  place(PACTS.run, USERS.you, 47.6456, -122.3052, 150, 'Montlake Cut', 28 * DAY),
  place(PACTS.run, USERS.maya, 47.6456, -122.3052, 150, 'Montlake Cut', 27 * DAY),
  place(PACTS.run, USERS.diego, 47.6456, -122.3052, 150, 'Montlake Cut', 27 * DAY),
  place(PACTS.run, USERS.priya, 47.6456, -122.3052, 150, 'Montlake Cut', 26 * DAY),
  place(PACTS.library, USERS.you, 47.6557, -122.3094, 60, 'Suzzallo', 20 * DAY),
  place(PACTS.library, USERS.priya, 47.6557, -122.3094, 60, 'Suzzallo', 20 * DAY),
];

const historyRow = (p: PactParticipantRow, extra: Partial<PactParticipantPlaceRow> = {}): PactParticipantPlaceRow => ({
  id: `ph-${p.pact_id}-${p.user_id}`,
  pact_id: p.pact_id,
  user_id: p.user_id,
  lat: p.place_lat,
  lng: p.place_lng,
  radius_m: p.place_radius_m,
  label: p.place_label,
  effective_from: p.joined_at,
  created_at: p.joined_at,
  requires_ack: false,
  acknowledged_at: null,
  acknowledged_by: null,
  objected_at: null,
  objected_by: null,
  objection_reason: null,
  effective_event_at: null,
  ...extra,
});

export const placeHistory: PactParticipantPlaceRow[] = participants.map((p) => historyRow(p));

// ---------- place accountability scenarios (9am in Kane Hall) ----------
// Maya moved her place 2 h ago (Savery Hall → Odegaard Library): pending until a friend confirms it
// or 24 h pass. Diego moved his to his dorm 5 h ago and Priya objected: he has to set a new one.
// pact_participants keeps the requested place (what the server does); the history holds the truth.
export const PLACE_IDS = { mayaPending: 'ph-p1-u-maya-2', diegoObjected: 'ph-p1-u-diego-2' } as const;
{
  const maya = participants.find((p) => p.pact_id === PACTS.classA && p.user_id === USERS.maya)!;
  const diego = participants.find((p) => p.pact_id === PACTS.classA && p.user_id === USERS.diego)!;
  placeHistory.push(
    historyRow({ ...maya, place_lat: 47.6565, place_lng: -122.3105, place_radius_m: 60, place_label: 'Odegaard Library' }, {
      id: PLACE_IDS.mayaPending,
      created_at: ago(2 * HOUR),
      effective_from: ahead(22 * HOUR),
      requires_ack: true,
    }),
    historyRow({ ...diego, place_lat: 47.6553, place_lng: -122.34, place_radius_m: 100, place_label: 'Lander Hall' }, {
      id: PLACE_IDS.diegoObjected,
      created_at: ago(5 * HOUR),
      effective_from: ahead(19 * HOUR),
      requires_ack: true,
      objected_at: ago(4 * HOUR),
      objected_by: USERS.priya,
      objection_reason: "That's your dorm, not the lecture hall.",
    }),
  );
  Object.assign(maya, { place_lat: 47.6565, place_lng: -122.3105, place_radius_m: 60, place_label: 'Odegaard Library' });
  Object.assign(diego, { place_lat: 47.6553, place_lng: -122.34, place_radius_m: 100, place_label: 'Lander Hall' });
}

export const placeEvents: PlaceEventRow[] = [
  {
    id: 1,
    group_id: GROUP_ID,
    pact_id: PACTS.classA,
    place_id: PLACE_IDS.diegoObjected,
    user_id: USERS.diego,
    actor_id: USERS.diego,
    kind: 'created',
    label: 'Lander Hall',
    lat: 47.6553,
    lng: -122.34,
    radius_m: 100,
    prev_label: 'Mary Gates',
    prev_lat: 47.6553,
    prev_lng: -122.3105,
    prev_radius_m: 100,
    distance_from_prev_m: 2214,
    reason: null,
    created_at: ago(5 * HOUR),
  },
  {
    id: 2,
    group_id: GROUP_ID,
    pact_id: PACTS.classA,
    place_id: PLACE_IDS.diegoObjected,
    user_id: USERS.diego,
    actor_id: USERS.priya,
    kind: 'objected',
    label: 'Lander Hall',
    lat: 47.6553,
    lng: -122.34,
    radius_m: 100,
    prev_label: 'Mary Gates',
    prev_lat: 47.6553,
    prev_lng: -122.3105,
    prev_radius_m: 100,
    distance_from_prev_m: 2214,
    reason: "That's your dorm, not the lecture hall.",
    created_at: ago(4 * HOUR),
  },
  {
    id: 3,
    group_id: GROUP_ID,
    pact_id: PACTS.classA,
    place_id: PLACE_IDS.mayaPending,
    user_id: USERS.maya,
    actor_id: USERS.maya,
    kind: 'created',
    label: 'Odegaard Library',
    lat: 47.6565,
    lng: -122.3105,
    radius_m: 60,
    prev_label: 'Savery Hall',
    prev_lat: 47.6534,
    prev_lng: -122.3078,
    prev_radius_m: 60,
    distance_from_prev_m: 403,
    reason: null,
    created_at: ago(2 * HOUR),
  },
];

// ---------- instances ----------

export const TODAY = localDateInZone(DEMO_T0, TZ);
export const INSTANCES = { open: 'i-open', before: 'i-before', closed: 'i-closed', voided: 'i-void' } as const;

/** Today's four, anchored to T0 regardless of the real wall clock so every state is on screen. */
export const todayInstances: PactInstanceRow[] = [
  { id: INSTANCES.open, pact_id: PACTS.classA, local_date: TODAY, window_open_at: ago(38 * MIN), deadline_at: ahead(22 * MIN), status: 'open', carry_in_cents: null, closed_at: null, deadline_soon_sent_at: null },
  { id: INSTANCES.before, pact_id: PACTS.gym, local_date: TODAY, window_open_at: ahead(3 * HOUR + 10 * MIN), deadline_at: ahead(4 * HOUR + 40 * MIN), status: 'scheduled', carry_in_cents: null, closed_at: null, deadline_soon_sent_at: null },
  { id: INSTANCES.closed, pact_id: PACTS.run, local_date: TODAY, window_open_at: ago(3 * HOUR + 15 * MIN), deadline_at: ago(2 * HOUR + 15 * MIN), status: 'closed', carry_in_cents: 0, closed_at: ago(2 * HOUR + 14 * MIN), deadline_soon_sent_at: ago(2 * HOUR + 30 * MIN) },
  { id: INSTANCES.voided, pact_id: PACTS.library, local_date: TODAY, window_open_at: ahead(5 * HOUR), deadline_at: ahead(6 * HOUR), status: 'voided', carry_in_cents: null, closed_at: null, deadline_soon_sent_at: null },
];

const checkin = (id: string, instance: string, user: string, atMs: number, verdict: CheckinRow['verdict'], distance: number | null, accuracy: number | null): CheckinRow => ({
  id,
  instance_id: instance,
  user_id: user,
  client_captured_at: iso(atMs),
  server_received_at: iso(atMs + 1500),
  lat: null,
  lng: null,
  accuracy_m: accuracy,
  distance_m: distance,
  is_simulated: false,
  verdict,
  client_attempt_id: null,
});

export const todayCheckins: CheckinRow[] = [
  checkin('c1', INSTANCES.open, USERS.maya, DEMO_T0 - 20 * MIN, 'in_fence', 12, 8),
  checkin('c2', INSTANCES.open, USERS.diego, DEMO_T0 - 12 * MIN, 'in_fence', 41, 14),
  checkin('c3', INSTANCES.closed, USERS.you, DEMO_T0 - 2 * HOUR - 40 * MIN, 'in_fence', 9, 6),
  checkin('c4', INSTANCES.closed, USERS.priya, DEMO_T0 - 2 * HOUR - 20 * MIN, 'unjudgeable', null, 640),
];

export const todayResults: ResultRow[] = [
  { instance_id: INSTANCES.closed, user_id: USERS.you, status: 'success', first_success_at: ago(2 * HOUR + 40 * MIN), decided_at: ago(2 * HOUR + 14 * MIN) },
  { instance_id: INSTANCES.closed, user_id: USERS.maya, status: 'frozen', first_success_at: null, decided_at: ago(2 * HOUR + 14 * MIN) },
  { instance_id: INSTANCES.closed, user_id: USERS.diego, status: 'failed', first_success_at: null, decided_at: ago(2 * HOUR + 14 * MIN) },
  { instance_id: INSTANCES.closed, user_id: USERS.priya, status: 'unverified', first_success_at: null, decided_at: ago(2 * HOUR + 14 * MIN) },
  { instance_id: INSTANCES.voided, user_id: USERS.you, status: 'void', first_success_at: null, decided_at: ago(1 * HOUR) },
  { instance_id: INSTANCES.voided, user_id: USERS.priya, status: 'void', first_success_at: null, decided_at: ago(1 * HOUR) },
];

export const freezes: FreezeRow[] = [
  { id: 'f1', pact_id: PACTS.run, user_id: USERS.maya, instance_id: INSTANCES.closed, declared_at: ago(14 * HOUR), iso_week: '2026-W45' },
];

/** Upcoming scheduled days for each pact (7 days ahead), for pact detail and the place picker. */
export const upcomingInstances: PactInstanceRow[] = pacts.flatMap((p) =>
  Array.from({ length: 7 }, (_, i) => i + 1)
    .map((i) => addDaysToLocalDate(TODAY, i))
    .filter((d) => p.days_of_week.includes(isoWeekday(d)))
    .map<PactInstanceRow>((d) => ({
      id: `i-${p.id}-${d}`,
      pact_id: p.id,
      local_date: d,
      window_open_at: iso(zonedLocalToUtc(d, p.window_open_local, TZ)),
      deadline_at: iso(zonedLocalToUtc(d, p.deadline_local, TZ)),
      status: p.paused ? 'voided' : 'scheduled',
      carry_in_cents: null,
      closed_at: null,
      deadline_soon_sent_at: null,
    })),
);

// ---------- four weeks of history ----------

const mondayOf = (localDate: string): string => addDaysToLocalDate(localDate, 1 - isoWeekday(localDate));
export const THIS_MONDAY = mondayOf(TODAY);
export const LAST_MONDAY = addDaysToLocalDate(THIS_MONDAY, -7);
export const SETTLEMENT_IDS = { latest: 's-latest', previous: 's-prev' } as const;

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

type Outcome = ResultRow['status'];

/** Deterministic but varied: mostly shows up, Diego misses more, Priya's GPS is flaky. */
function outcomeFor(pactId: string, user: string, localDate: string): Outcome {
  const r = hash(`${pactId}|${user}|${localDate}`) % 100;
  const missRate = user === USERS.diego ? 30 : user === USERS.priya ? 18 : 12;
  if (r < missRate) return 'failed';
  if (user === USERS.priya && r < missRate + 10) return 'unverified';
  if (r > 94) return 'frozen';
  return 'success';
}

const historyInstances: PactInstanceRow[] = [];
const historyResults: ResultRow[] = [];
const historyCheckins: CheckinRow[] = [];

for (let back = 1; back <= 27; back += 1) {
  const d = addDaysToLocalDate(TODAY, -back);
  for (const p of pacts) {
    if (!p.days_of_week.includes(isoWeekday(d))) continue;
    if (p.id === PACTS.library && back > 6) continue; // created 20 days ago, paused a week in
    const deadline = zonedLocalToUtc(d, p.deadline_local, TZ);
    const open = zonedLocalToUtc(d, p.window_open_local, TZ);
    const id = `h-${p.id}-${d}`;
    const settled = d < THIS_MONDAY;
    const roster = participants.filter((pp) => pp.pact_id === p.id).map((pp) => pp.user_id);
    if (p.id === PACTS.library && back === 1) {
      historyInstances.push({ id, pact_id: p.id, local_date: d, window_open_at: iso(open), deadline_at: iso(deadline), status: 'voided', carry_in_cents: null, closed_at: null, deadline_soon_sent_at: null });
      for (const u of roster) historyResults.push({ instance_id: id, user_id: u, status: 'void', first_success_at: null, decided_at: iso(deadline) });
      continue;
    }
    historyInstances.push({ id, pact_id: p.id, local_date: d, window_open_at: iso(open), deadline_at: iso(deadline), status: settled ? 'settled' : 'closed', carry_in_cents: 0, closed_at: iso(deadline + MIN), deadline_soon_sent_at: iso(deadline - 15 * MIN) });
    for (const u of roster) {
      const status = outcomeFor(p.id, u, d);
      const successAt = status === 'success' ? deadline - (5 + (hash(`${id}${u}`) % 40)) * MIN : null;
      historyResults.push({ instance_id: id, user_id: u, status, first_success_at: successAt ? iso(successAt) : null, decided_at: iso(deadline + MIN) });
      if (successAt) historyCheckins.push(checkin(`hc-${id}-${u}`, id, u, successAt - 1500, 'in_fence', 10 + (hash(u) % 30), 5 + (hash(id) % 20)));
    }
  }
}

// Review scenarios layered on top of the generated history.
const yesterday = addDaysToLocalDate(TODAY, -1);
const findResult = (pactId: string, user: string, daysBack: number): ResultRow | undefined => {
  const d = addDaysToLocalDate(TODAY, -daysBack);
  return historyResults.find((r) => r.instance_id === `h-${pactId}-${d}` && r.user_id === user);
};
const force = (r: ResultRow | undefined, status: Outcome) => {
  if (r) r.status = status;
};

export const reviews: ReviewRow[] = [];
export const reviewVotes: ReviewVoteRow[] = [];

// 1. Open appeal: Priya missed yesterday's run and says the GPS never locked. You can vote.
{
  const r = findResult(PACTS.run, USERS.priya, 1);
  force(r, 'failed');
  if (r) {
    reviews.push({ id: 'r-open', instance_id: r.instance_id, subject_user_id: USERS.priya, opened_by: USERS.priya, kind: 'appeal', reason: 'I was at the Cut by 6:40, GPS spun forever under the bridge. Photo attached.', photo_path: `${GROUP_ID}/${USERS.priya}/evidence.jpg`, status: 'open', opened_at: ago(14 * HOUR), resolved_at: null, system_opened: false });
    reviewVotes.push({ review_id: 'r-open', voter_id: USERS.maya, supports: true, cast_at: ago(10 * HOUR) });
  }
}
// 2. Accepted challenge: Diego's "success" 9 days ago was challenged by Maya and the group agreed.
{
  const r = findResult(PACTS.classA, USERS.diego, 9);
  force(r, 'failed');
  if (r) {
    reviews.push({ id: 'r-challenge-accepted', instance_id: r.instance_id, subject_user_id: USERS.diego, opened_by: USERS.maya, kind: 'challenge', reason: 'He was in the Ave coffee line at 8:58, I was behind him.', photo_path: null, status: 'accepted', opened_at: ago(9 * DAY - 2 * HOUR), resolved_at: ago(8 * DAY), system_opened: false });
    reviewVotes.push({ review_id: 'r-challenge-accepted', voter_id: USERS.maya, supports: true, cast_at: ago(9 * DAY - 2 * HOUR) });
    reviewVotes.push({ review_id: 'r-challenge-accepted', voter_id: USERS.you, supports: true, cast_at: ago(9 * DAY - HOUR) });
    reviewVotes.push({ review_id: 'r-challenge-accepted', voter_id: USERS.priya, supports: false, cast_at: ago(8 * DAY) });
  }
}
// 3. Rejected appeal: you appealed a miss 12 days ago; the group turned it down.
{
  const r = findResult(PACTS.classA, USERS.you, 12);
  force(r, 'failed');
  if (r) {
    reviews.push({ id: 'r-appeal-rejected', instance_id: r.instance_id, subject_user_id: USERS.you, opened_by: USERS.you, kind: 'appeal', reason: 'Bus broke down on 45th, got there at 9:04.', photo_path: null, status: 'rejected', opened_at: ago(12 * DAY - HOUR), resolved_at: ago(11 * DAY), system_opened: false });
    reviewVotes.push({ review_id: 'r-appeal-rejected', voter_id: USERS.maya, supports: false, cast_at: ago(11 * DAY) });
    reviewVotes.push({ review_id: 'r-appeal-rejected', voter_id: USERS.diego, supports: true, cast_at: ago(11 * DAY) });
    reviewVotes.push({ review_id: 'r-appeal-rejected', voter_id: USERS.priya, supports: false, cast_at: ago(11 * DAY) });
  }
}
// 4. Defaulted appeal: nobody voted, so Priya's miss 19 days ago stands as a miss (N3-1: the
//    result stands and the forfeit is kept; nothing becomes Excluded any more).
{
  const r = findResult(PACTS.gym, USERS.priya, 19);
  force(r, 'failed');
  if (r) {
    reviews.push({ id: 'r-appeal-defaulted', instance_id: r.instance_id, subject_user_id: USERS.priya, opened_by: USERS.priya, kind: 'appeal', reason: 'Front desk scanner was down, I have the receipt.', photo_path: null, status: 'defaulted', opened_at: ago(19 * DAY - HOUR), resolved_at: ago(14 * DAY), system_opened: false });
  }
}
// One historical Excluded result (the pre-night-1 default for an unvoted appeal) so the status pill
// and the "moves no money" rows still render; no rule produces this status any more (N3-1).
force(findResult(PACTS.classA, USERS.diego, 3), 'excluded');
void yesterday;

export { historyCheckins, historyInstances, historyResults };

// ---------- extra check-in states (pushed after the history loop so the feed and settle-up are unchanged) ----------

/** A pact you have not joined: group home shows "Set your place"; /checkin/i-notin is the not-a-participant state. */
export const PACT_NOT_JOINED = 'p5';
pacts.push({ id: PACT_NOT_JOINED, group_id: GROUP_ID, title: 'Chem lab by 2', days_of_week: [2, 4], window_open_local: '13:00:00', deadline_local: '14:00:00', stake_cents: 400, tz: TZ, paused: false, created_by: USERS.maya, created_at: ago(3 * DAY) });
participants.push(
  place(PACT_NOT_JOINED, USERS.maya, 47.6532, -122.3086, 80, 'Bagley Hall', 3 * DAY),
  place(PACT_NOT_JOINED, USERS.diego, 47.6532, -122.3086, 80, 'Bagley Hall', 2 * DAY),
);
export const EXTRA_INSTANCES = { notJoined: 'i-notin', frozen: 'i-frozen' } as const;
todayInstances.push(
  { id: EXTRA_INSTANCES.notJoined, pact_id: PACT_NOT_JOINED, local_date: TODAY, window_open_at: ago(10 * MIN), deadline_at: ahead(50 * MIN), status: 'open', carry_in_cents: null, closed_at: null, deadline_soon_sent_at: null },
  // a second run day you froze in advance (window not open yet): /checkin/i-frozen
  { id: EXTRA_INSTANCES.frozen, pact_id: PACTS.run, local_date: TODAY, window_open_at: ahead(HOUR + 50 * MIN), deadline_at: ahead(2 * HOUR + 50 * MIN), status: 'scheduled', carry_in_cents: null, closed_at: null, deadline_soon_sent_at: null },
);
todayCheckins.push(checkin('c5', EXTRA_INSTANCES.notJoined, USERS.maya, DEMO_T0 - 6 * MIN, 'in_fence', 15, 9));
freezes.push({ id: 'f2', pact_id: PACTS.run, user_id: USERS.you, instance_id: EXTRA_INSTANCES.frozen, declared_at: ago(5 * HOUR), iso_week: '2026-W45' });

/**
 * A Missed day of yours today with no review yet (P3-6): the Maestro appeal flow and the feed's
 * "You, Forfeited $2.00 to the pool" row no longer depend on the date-hashed history. Two-person
 * pact (you + Maya), closed 3 h ago: you missed, Maya showed up.
 */
export const PACT_MISSED = 'p6';
export const INSTANCE_MISSED = 'i-missed';
pacts.push({ id: PACT_MISSED, group_id: GROUP_ID, title: 'Lab notebook by noon', days_of_week: [1, 2, 3, 4, 5, 6, 7], window_open_local: '11:00:00', deadline_local: '12:00:00', stake_cents: 200, tz: TZ, paused: false, created_by: USERS.you, created_at: ago(9 * DAY) });
const missedParticipants = [
  place(PACT_MISSED, USERS.you, 47.6532, -122.3086, 80, 'Bagley Hall', 9 * DAY),
  place(PACT_MISSED, USERS.maya, 47.6532, -122.3086, 80, 'Bagley Hall', 8 * DAY),
];
participants.push(...missedParticipants);
placeHistory.push(...missedParticipants.map((p) => historyRow(p)));
todayInstances.push({ id: INSTANCE_MISSED, pact_id: PACT_MISSED, local_date: TODAY, window_open_at: ago(4 * HOUR), deadline_at: ago(3 * HOUR), status: 'closed', carry_in_cents: 0, closed_at: ago(3 * HOUR - MIN), deadline_soon_sent_at: ago(3 * HOUR + 15 * MIN) });
todayCheckins.push(checkin('c6', INSTANCE_MISSED, USERS.maya, DEMO_T0 - 3 * HOUR - 25 * MIN, 'in_fence', 11, 7));
todayResults.push(
  { instance_id: INSTANCE_MISSED, user_id: USERS.you, status: 'failed', first_success_at: null, decided_at: ago(3 * HOUR - MIN) },
  { instance_id: INSTANCE_MISSED, user_id: USERS.maya, status: 'success', first_success_at: ago(3 * HOUR + 25 * MIN), decided_at: ago(3 * HOUR - MIN) },
);

// ---------- ledger ----------

export const balances: MemberBalanceRow[] = [
  { group_id: GROUP_ID, user_id: USERS.you, balance_cents: 1250 },
  { group_id: GROUP_ID, user_id: USERS.maya, balance_cents: 375 },
  { group_id: GROUP_ID, user_id: USERS.diego, balance_cents: -825 },
  { group_id: GROUP_ID, user_id: USERS.priya, balance_cents: -800 },
];

export const settlements: SettlementRow[] = [
  { id: SETTLEMENT_IDS.latest, group_id: GROUP_ID, week_start: LAST_MONDAY, ran_at: iso(zonedLocalToUtc(THIS_MONDAY, '12:00:00', TZ)) },
  { id: SETTLEMENT_IDS.previous, group_id: GROUP_ID, week_start: addDaysToLocalDate(LAST_MONDAY, -7), ran_at: iso(zonedLocalToUtc(LAST_MONDAY, '12:00:00', TZ)) },
];

export const obligations: ObligationRow[] = [
  { id: 'o1', settlement_id: SETTLEMENT_IDS.latest, group_id: GROUP_ID, from_user: USERS.diego, to_user: USERS.you, amount_cents: 825, status: 'pending', marked_paid_at: null, confirmed_at: null },
  { id: 'o2', settlement_id: SETTLEMENT_IDS.latest, group_id: GROUP_ID, from_user: USERS.priya, to_user: USERS.you, amount_cents: 425, status: 'marked_paid', marked_paid_at: ago(6 * HOUR), confirmed_at: null },
  { id: 'o3', settlement_id: SETTLEMENT_IDS.latest, group_id: GROUP_ID, from_user: USERS.priya, to_user: USERS.maya, amount_cents: 375, status: 'pending', marked_paid_at: null, confirmed_at: null },
  { id: 'o4', settlement_id: SETTLEMENT_IDS.previous, group_id: GROUP_ID, from_user: USERS.you, to_user: USERS.maya, amount_cents: 200, status: 'pending', marked_paid_at: null, confirmed_at: null },
  { id: 'o5', settlement_id: SETTLEMENT_IDS.previous, group_id: GROUP_ID, from_user: USERS.diego, to_user: USERS.maya, amount_cents: 300, status: 'confirmed', marked_paid_at: ago(8 * DAY), confirmed_at: ago(7 * DAY) },
  // `?settle=owe` only: a week where you missed and owe two friends (ov- rows are hidden otherwise).
  { id: 'ov-owe-1', settlement_id: SETTLEMENT_IDS.latest, group_id: GROUP_ID, from_user: USERS.you, to_user: USERS.maya, amount_cents: 500, status: 'pending', marked_paid_at: null, confirmed_at: null },
  { id: 'ov-owe-2', settlement_id: SETTLEMENT_IDS.latest, group_id: GROUP_ID, from_user: USERS.you, to_user: USERS.diego, amount_cents: 300, status: 'pending', marked_paid_at: null, confirmed_at: null },
];

/** Which open obligations (and balances) the settle-up screen shows per `?settle=` variant. */
export const SETTLE_VARIANTS: Record<'mixed' | 'owe' | 'owed', { obligationIds: string[]; balances: MemberBalanceRow[] }> = {
  mixed: { obligationIds: obligations.filter((o) => !o.id.startsWith('ov-')).map((o) => o.id), balances },
  owe: {
    obligationIds: ['ov-owe-1', 'ov-owe-2', 'o3'],
    balances: [
      { group_id: GROUP_ID, user_id: USERS.you, balance_cents: -800 },
      { group_id: GROUP_ID, user_id: USERS.maya, balance_cents: 875 },
      { group_id: GROUP_ID, user_id: USERS.diego, balance_cents: 300 },
      { group_id: GROUP_ID, user_id: USERS.priya, balance_cents: -375 },
    ],
  },
  owed: { obligationIds: ['o1', 'o2', 'o3'], balances },
};

// ---------- seasons and settle-up history (Q2) ----------

/** "9am in Kane Hall" runs a 4-week season that started two Mondays ago: week 3 of 4 on the Stats screen. */
export const SEASON_START = addDaysToLocalDate(THIS_MONDAY, -14);
{
  const p = pacts.find((x) => x.id === PACTS.classA)!;
  p.season_start = SEASON_START;
  p.season_weeks = 4;
}

/**
 * Four older settle-ups, every obligation confirmed: with the five open rows above the group's
 * settle-up completion reads 17 of 21 (81%). Confirmed rows never show on the settle-up screen.
 */
export const OLDER_SETTLEMENT_IDS = ['s-w3', 's-w4', 's-w5', 's-w6'] as const;
OLDER_SETTLEMENT_IDS.forEach((id, i) => {
  const weekStart = addDaysToLocalDate(LAST_MONDAY, -7 * (i + 2));
  settlements.push({ id, group_id: GROUP_ID, week_start: weekStart, ran_at: iso(zonedLocalToUtc(addDaysToLocalDate(weekStart, 7), '12:00:00', TZ)) });
  const pairs: [string, string, number][] = [
    [USERS.diego, USERS.you, 500 + 25 * i],
    [USERS.priya, USERS.maya, 300],
    [USERS.diego, USERS.maya, 200 + 50 * i],
    [USERS.you, USERS.priya, 150],
  ];
  pairs.forEach(([from, to, amount], j) => {
    const paidAt = (i + 2) * 7 * DAY - (j + 1) * HOUR;
    obligations.push({ id: `${id}-o${j + 1}`, settlement_id: id, group_id: GROUP_ID, from_user: from, to_user: to, amount_cents: amount, status: 'confirmed', marked_paid_at: ago(paidAt), confirmed_at: ago(paidAt - 30 * MIN) });
  });
});

// ---------- the mutable store ----------

export interface DemoStore {
  profiles: ProfileRow[];
  groups: GroupRow[];
  members: GroupMemberRow[];
  pacts: PactRow[];
  participants: PactParticipantRow[];
  placeHistory: PactParticipantPlaceRow[];
  placeEvents: PlaceEventRow[];
  instances: PactInstanceRow[];
  checkins: CheckinRow[];
  results: ResultRow[];
  freezes: FreezeRow[];
  reviews: ReviewRow[];
  votes: ReviewVoteRow[];
  balances: MemberBalanceRow[];
  settlements: SettlementRow[];
  obligations: ObligationRow[];
}

const clone = <T>(xs: T[]): T[] => xs.map((x) => ({ ...x }));

export function createStore(): DemoStore {
  return {
    profiles: clone(profiles),
    groups: clone(groups),
    members: clone(members),
    pacts: clone(pacts),
    participants: clone(participants),
    placeHistory: clone(placeHistory),
    placeEvents: clone(placeEvents),
    instances: [...clone(todayInstances), ...clone(upcomingInstances), ...clone(historyInstances)],
    checkins: [...clone(todayCheckins), ...clone(historyCheckins)],
    results: [...clone(todayResults), ...clone(historyResults)],
    freezes: clone(freezes),
    reviews: clone(reviews),
    votes: clone(reviewVotes),
    balances: clone(balances),
    settlements: clone(settlements),
    obligations: clone(obligations),
  };
}

export const store: DemoStore = createStore();

// ---------- the ledger's view of one day (demo stand-in for `instance_member_nets`) ----------

/**
 * What the server's `instance_member_nets` view would return for an instance: the payout rule
 * (CONTRACT.md "Payout") applied to its results. Demo only; the app never computes money for real
 * data, it reads this view from the ledger.
 */
export function netsFor(instance: PactInstanceRow, results: readonly ResultRow[], stakeCents: number, groupId = GROUP_ID): InstanceMemberNetRow[] {
  if (instance.status === 'voided') return [];
  const winners = results
    .filter((r) => r.status === 'success')
    .sort((a, b) => {
      const ta = a.first_success_at ? Date.parse(a.first_success_at) : Number.POSITIVE_INFINITY;
      const tb = b.first_success_at ? Date.parse(b.first_success_at) : Number.POSITIVE_INFINITY;
      return ta - tb || a.user_id.localeCompare(b.user_id);
    });
  const losers = results.filter((r) => r.status === 'failed');
  if (winners.length + losers.length < 2) return [];
  const carry = winners.length > 0 ? (instance.carry_in_cents ?? 0) : 0;
  const pot = stakeCents * losers.length + carry;
  const row = (user_id: string, net_cents: number): InstanceMemberNetRow => ({ instance_id: instance.id, group_id: groupId, user_id, net_cents, pot_cents: pot });
  const out = losers.map((l) => row(l.user_id, -stakeCents));
  if (winners.length === 0) return out; // all failed: the pot rolls into the carry
  const share = Math.floor(pot / winners.length);
  const left = pot % winners.length;
  winners.forEach((w, i) => {
    const amount = share + (i < left ? 1 : 0);
    if (amount !== 0) out.push(row(w.user_id, amount));
  });
  return out;
}

/** The roster of today's closed fixture instance, in `?outcome=` variants (DECISIONS.md Q1). */
export function outcomeResults(outcome: 'win' | 'forfeit' | 'unverified' | 'frozen' | 'void'): ResultRow[] {
  const decided = ago(2 * HOUR + 14 * MIN);
  const r = (user_id: string, status: ResultRow['status'], successMinutesAgo: number | null = null): ResultRow => ({
    instance_id: INSTANCES.closed,
    user_id,
    status,
    first_success_at: successMinutesAgo === null ? null : ago(successMinutesAgo * MIN),
    decided_at: decided,
  });
  switch (outcome) {
    case 'win':
      return [r(USERS.you, 'success', 160), r(USERS.maya, 'success', 150), r(USERS.diego, 'failed'), r(USERS.priya, 'failed')];
    case 'forfeit':
      return [r(USERS.you, 'failed'), r(USERS.maya, 'success', 160), r(USERS.diego, 'success', 150), r(USERS.priya, 'success', 140)];
    case 'unverified':
      return [r(USERS.you, 'unverified'), r(USERS.maya, 'success', 160), r(USERS.diego, 'failed'), r(USERS.priya, 'success', 150)];
    case 'frozen':
      return [r(USERS.you, 'frozen'), r(USERS.maya, 'success', 160), r(USERS.diego, 'failed'), r(USERS.priya, 'unverified')];
    case 'void':
      return [r(USERS.you, 'void'), r(USERS.maya, 'void'), r(USERS.diego, 'void'), r(USERS.priya, 'void')];
  }
}

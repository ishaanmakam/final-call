/**
 * Demo implementations of every query hook and RPC in `../queries.ts` and `../rpc.ts`. Each hook
 * returns the same TanStack Query shape as the real one (same keys, so screens' invalidations still
 * work) and resolves against the in-memory fixtures. See settings.ts for the route params.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useGlobalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { attemptId, type CheckinAttempt, type SendOutcome } from '../../lib/checkinQueue';
import { DbError, userMessage } from '../../lib/errors';
import { summarizeInstance } from '../../lib/instanceStatus';
import { OPEN_OBLIGATION_STATUSES } from '../../lib/obligations';
import { derivePlaceState, effectivePlaceAt, haversineM, nextWindow, placeForWindow } from '../../lib/places';
import { gateClosePollInterval } from '../../lib/gatePoll';
import { localDateInZone } from '../../lib/time';
import type {
  Feed,
  FeedItem,
  GroupHome,
  InstanceDetail,
  Ledger,
  MyGroup,
  PactDetail,
  PlaceSchedule,
  TodayItem,
} from '../queries';
import type { CreatePactInput, JoinPactInput, OpenReviewInput } from '../rpc';
import type { CheckinRow, GroupSettlementStatsRow, InstanceMemberNetRow, PactInstanceRow, PactParticipantPlaceRow, PactPlaceVisibleRow, PactSeasonRecapRow, PactStreakRow, PlaceDistanceRow, PlaceEventKind, ProfileRow, ResultRow } from '../types';
import type { GroupStats, PactStats } from '../statsQueries';
import { seasonEnd, seasonOf } from '../../features/stats/season';
import { DEMO_T0, EMPTY_GROUP_ID, GROUP_ID, INSTANCES, INVITE_CODE, SETTLE_VARIANTS, netsFor, outcomeResults, store } from './fixtures';
import { DEMO, DEMO_USER_ID, demoKey, demoSettingsFromParams, getDemoSettings, setDemoSettings, type DemoSettings } from './settings';

export { DEMO, DEMO_USER_ID, getDemoSettings, type DemoSettings } from './settings';
export { DEMO_T0 } from './fixtures';

const queryKeys = {
  myGroups: (userId: string) => ['groups', userId] as const,
  groupHome: (groupId: string) => ['group', groupId, 'home'] as const,
  pact: (pactId: string) => ['pact', pactId] as const,
  instance: (instanceId: string) => ['instance', instanceId] as const,
  feed: (groupId: string) => ['group', groupId, 'feed'] as const,
  ledger: (groupId: string) => ['group', groupId, 'ledger'] as const,
  profile: (userId: string) => ['profile', userId] as const,
};

/** Mirrors queries.ts (A6): a profile edit refreshes every query that embeds the name. */
const PROFILE_DEPENDENT_KEYS = (userId: string) => [['profile', userId], ['group'], ['groups']];

// ---------- settings plumbing ----------

/** Reads the demo params from the current URL and publishes them to the process-wide store. */
export function useDemoSettings(): DemoSettings {
  const params = useGlobalSearchParams<Record<string, string | string[]>>();
  const settings = demoSettingsFromParams(params as Record<string, string | string[] | undefined>);
  useEffect(() => setDemoSettings(settings), [settings.verdict, settings.empty, settings.state, settings.perm, settings.signedOut, settings.freeze, settings.settle, settings.fix, settings.precise, settings.budget, settings.skew, settings.outcome]); // eslint-disable-line react-hooks/exhaustive-deps
  return settings;
}

/** Mount once near the root so RPCs and the location adapter see the URL's demo params. */
export function DemoParamsSync() {
  useDemoSettings();
  return null;
}

const LATENCY = 350;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A real RpcError (status 0 = transport failure) so the screens' `instanceof RpcError` queueing
 * logic behaves exactly as it does against Supabase. Imported lazily: rpc.ts imports this module.
 */
async function networkError(): Promise<Error> {
  const { RpcError } = await import('../rpc');
  return new RpcError('check_in', { message: 'Network request failed' }, 0);
}

async function gate(settings: DemoSettings): Promise<void> {
  await wait(LATENCY);
  if (settings.state === 'offline') throw await networkError();
  if (settings.state === 'error') throw new DbError({ message: 'internal error', code: 'XX000' });
}

const profileMap = (): Map<string, ProfileRow> => new Map(store.profiles.map((p) => [p.id, p]));
const groupOf = (groupId: string) => store.groups.find((g) => g.id === groupId) ?? store.groups[0]!;
const isEmptyGroup = (groupId: string, s: DemoSettings) => s.empty || groupId === EMPTY_GROUP_ID;
const nameOf = (id: string) => store.profiles.find((p) => p.id === id)?.display_name ?? null;

// ---------- places as the group sees them (mirrors pact_places_visible / pact_place_distances) ----------

function visiblePlaces(pactId: string, nowMs = Date.now()): PactPlaceVisibleRow[] {
  const pact = store.pacts.find((p) => p.id === pactId);
  if (!pact) return [];
  const current = new Set(store.participants.filter((p) => p.pact_id === pactId && !p.left_at).map((p) => p.user_id));
  const rows = store.placeHistory.filter((h) => h.pact_id === pactId && current.has(h.user_id));
  return rows.map((h) => ({
    place_id: h.id,
    pact_id: h.pact_id,
    group_id: pact.group_id,
    user_id: h.user_id,
    user_name: nameOf(h.user_id),
    lat: h.lat,
    lng: h.lng,
    radius_m: h.radius_m,
    label: h.label,
    created_at: h.created_at,
    effective_from: h.effective_from,
    requires_ack: h.requires_ack,
    acknowledged_at: h.acknowledged_at,
    acknowledged_by: h.acknowledged_by,
    acknowledged_by_name: h.acknowledged_by ? nameOf(h.acknowledged_by) : null,
    objected_at: h.objected_at,
    objected_by: h.objected_by,
    objected_by_name: h.objected_by ? nameOf(h.objected_by) : null,
    objection_reason: h.objection_reason,
    ...derivePlaceState(h, rows.filter((r) => r.user_id === h.user_id), nowMs),
  }));
}

function placeDistances(pactId: string): PlaceDistanceRow[] {
  const rows = visiblePlaces(pactId);
  const out: PlaceDistanceRow[] = [];
  for (const a of rows) {
    if (!(a.is_current || a.state === 'pending')) continue;
    for (const b of rows) {
      if (b.user_id === a.user_id || !b.is_current) continue;
      out.push({
        pact_id: pactId,
        place_id: a.place_id,
        user_id: a.user_id,
        label: a.label,
        state: a.is_current ? 'effective' : 'pending',
        other_user_id: b.user_id,
        other_place_id: b.place_id,
        other_label: b.label,
        distance_m: haversineM(a.lat, a.lng, b.lat, b.lng),
      });
    }
  }
  return out;
}

function pushPlaceEvent(place: PactParticipantPlaceRow, kind: PlaceEventKind, actorId: string, reason: string | null) {
  const pact = store.pacts.find((p) => p.id === place.pact_id);
  if (!pact) return;
  const mine = store.placeHistory.filter((h) => h.pact_id === place.pact_id && h.user_id === place.user_id);
  const prev = effectivePlaceAt(mine, place.created_at);
  const prevRow = prev && prev.id !== place.id ? prev : null;
  store.placeEvents.push({
    id: store.placeEvents.reduce((m, e) => Math.max(m, e.id), 0) + 1,
    group_id: pact.group_id,
    pact_id: place.pact_id,
    place_id: place.id,
    user_id: place.user_id,
    actor_id: actorId,
    kind,
    label: place.label,
    lat: place.lat,
    lng: place.lng,
    radius_m: place.radius_m,
    prev_label: prevRow?.label ?? null,
    prev_lat: prevRow?.lat ?? null,
    prev_lng: prevRow?.lng ?? null,
    prev_radius_m: prevRow?.radius_m ?? null,
    distance_from_prev_m: prevRow ? Math.round(haversineM(prevRow.lat, prevRow.lng, place.lat, place.lng)) : null,
    reason,
    created_at: new Date().toISOString(),
  });
}

// ---------- queries ----------

export function useProfile(userId: string) {
  const s = useDemoSettings();
  return useQuery({
    queryKey: [...queryKeys.profile(userId), demoKey(s)],
    queryFn: async () => {
      await gate(s);
      return store.profiles.find((p) => p.id === userId) ?? store.profiles[0]!;
    },
  });
}

export function useUpdateProfile(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: { display_name?: string; venmo_username?: string | null }) => {
      await gate(getDemoSettings());
      const p = store.profiles.find((x) => x.id === userId);
      if (p) Object.assign(p, patch);
    },
    onSuccess: () => Promise.all(PROFILE_DEPENDENT_KEYS(userId).map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

export function useMyGroups(userId: string) {
  const s = useDemoSettings();
  return useQuery({
    queryKey: [...queryKeys.myGroups(userId), demoKey(s)],
    queryFn: async (): Promise<MyGroup[]> => {
      await gate(s);
      if (s.empty) return [];
      return store.groups
        .filter((g) => store.members.some((m) => m.group_id === g.id && m.user_id === userId && !m.left_at))
        .map((group) => ({
          group,
          role: store.members.find((m) => m.group_id === group.id && m.user_id === userId)?.role ?? 'member',
          memberCount: store.members.filter((m) => m.group_id === group.id && !m.left_at).length,
        }))
        .sort((a, b) => a.group.name.localeCompare(b.group.name));
    },
  });
}

export function useGroupHome(groupId: string, userId: string, enabled = true) {
  const s = useDemoSettings();
  return useQuery({
    queryKey: [...queryKeys.groupHome(groupId), demoKey(s)],
    enabled,
    queryFn: async (): Promise<GroupHome> => {
      await gate(s);
      const group = groupOf(groupId);
      const profiles = profileMap();
      if (isEmptyGroup(groupId, s)) {
        const me = store.members.filter((m) => m.group_id === EMPTY_GROUP_ID);
        return { group: { ...group, id: groupId }, members: me, profiles, pacts: [], unjoinedPactIds: new Set(), today: [] };
      }
      const members = store.members.filter((m) => m.group_id === group.id && !m.left_at);
      const pacts = store.pacts.filter((p) => p.group_id === group.id);
      const todayByPact = new Map(pacts.map((p) => [p.id, localDateInZone(Date.now(), p.tz)]));
      const todays = store.instances.filter(
        (i) => pacts.some((p) => p.id === i.pact_id) && (todayByPact.get(i.pact_id) === i.local_date || i.id.startsWith('i-')),
      );
      // keep one instance per pact: the anchored "today" fixtures win over generated ones
      const seen = new Set<string>();
      const today: TodayItem[] = [];
      for (const instance of todays.sort((a, b) => (a.id.startsWith('i-') ? -1 : 1) - (b.id.startsWith('i-') ? -1 : 1))) {
        if (seen.has(instance.pact_id)) continue;
        seen.add(instance.pact_id);
        const pact = pacts.find((p) => p.id === instance.pact_id)!;
        const participantIds = store.participants.filter((p) => p.pact_id === pact.id && !p.left_at).map((p) => p.user_id);
        const view = instanceView(instance, s);
        const summary = summarizeInstance({
          participantIds,
          deadlineAt: view.instance.deadline_at,
          checkins: view.checkins,
          results: view.results,
        });
        today.push({ instance: view.instance, pact, participantIds, summary, myState: summary.byUser[userId] ?? null });
      }
      today.sort((a, b) => Date.parse(a.instance.deadline_at) - Date.parse(b.instance.deadline_at));
      const joined = new Set(store.participants.filter((p) => p.user_id === userId && !p.left_at).map((p) => p.pact_id));
      return { group, members, profiles, pacts, unjoinedPactIds: new Set(pacts.map((p) => p.id).filter((id) => !joined.has(id))), today };
    },
    refetchInterval: 30_000,
  });
}

export function usePactDetail(pactId: string, userId: string) {
  const s = useDemoSettings();
  return useQuery({
    queryKey: [...queryKeys.pact(pactId), demoKey(s)],
    queryFn: async (): Promise<PactDetail> => {
      await gate(s);
      const pact = store.pacts.find((p) => p.id === pactId) ?? store.pacts[0]!;
      const participants = s.empty ? [] : store.participants.filter((p) => p.pact_id === pact.id && !p.left_at);
      const since = Date.now() - 86_400_000;
      const upcoming = store.instances
        .filter((i) => i.pact_id === pact.id && Date.parse(i.deadline_at) >= since)
        .sort((a, b) => Date.parse(a.deadline_at) - Date.parse(b.deadline_at))
        .slice(0, 10);
      return {
        pact,
        participants,
        profiles: profileMap(),
        upcoming: s.empty ? [] : upcoming,
        myFreezes: store.freezes.filter((f) => f.pact_id === pact.id && f.user_id === userId),
        places: s.empty ? [] : visiblePlaces(pact.id),
        distances: s.empty ? [] : placeDistances(pact.id),
      };
    },
  });
}

export function usePlaceSchedule(pactId: string, userId: string, enabled = true) {
  const s = useDemoSettings();
  return useQuery({
    queryKey: [...queryKeys.pact(pactId), 'places', userId, demoKey(s)] as const,
    enabled,
    queryFn: async (): Promise<PlaceSchedule> => {
      await gate(s);
      const now = Date.now();
      const places = store.placeHistory.filter((p) => p.pact_id === pactId && p.user_id === userId);
      const upcoming = store.instances.filter((i) => i.pact_id === pactId && Date.parse(i.window_open_at) > now && i.status !== 'voided');
      const nextInstance = nextWindow(upcoming, now);
      const latestSaved = places.reduce<(typeof places)[number] | null>(
        (a, p) => (a === null || Date.parse(p.created_at) > Date.parse(a.created_at) ? p : a),
        null,
      );
      return { places, nextInstance, nextPlace: nextInstance ? effectivePlaceAt(places, nextInstance.window_open_at) : null, latestSaved };
    },
  });
}

export function useInstanceDetail(instanceId: string, userId: string) {
  const s = useDemoSettings();
  return useQuery({
    queryKey: [...queryKeys.instance(instanceId), demoKey(s)],
    queryFn: async (): Promise<InstanceDetail> => {
      await gate(s);
      const base = store.instances.find((i) => i.id === instanceId) ?? store.instances[0]!;
      const { instance, results, checkins, nets } = instanceView(base, s);
      const pact = store.pacts.find((p) => p.id === instance.pact_id)!;
      const mine = store.participants.find((p) => p.pact_id === pact.id && p.user_id === userId && !p.left_at) ?? null;
      const history = store.placeHistory.filter((p) => p.pact_id === pact.id && p.user_id === userId);
      return {
        instance,
        pact,
        myPlace: mine,
        judgedPlace: mine ? placeForWindow(history, instance.window_open_at, mine) : null,
        myCheckins: checkins.filter((c) => c.user_id === userId).sort((a, b) => Date.parse(a.server_received_at) - Date.parse(b.server_received_at)),
        myResult: results.find((r) => r.user_id === userId) ?? null,
        myFreeze:
          s.outcome === 'frozen' && instanceId === INSTANCES.closed
            ? { id: 'f-demo', pact_id: pact.id, user_id: userId, instance_id: instanceId, declared_at: new Date(DEMO_T0 - 14 * 3_600_000).toISOString(), iso_week: '2026-W45' }
            : (store.freezes.find((f) => f.instance_id === instanceId && f.user_id === userId) ?? null),
        results,
        profiles: profileMap(),
        nets,
      };
    },
    refetchInterval: (query) => gateClosePollInterval(query.state.data, Date.now()),
  });
}

/** The group home's compact gate-close line: the ledger effect of one closed day. */
export function useInstanceNets(instanceId: string, enabled = true) {
  const s = useDemoSettings();
  return useQuery({
    queryKey: [...queryKeys.instance(instanceId), 'nets', demoKey(s)],
    enabled,
    queryFn: async (): Promise<InstanceMemberNetRow[]> => {
      await gate(s);
      const base = store.instances.find((i) => i.id === instanceId);
      return base ? instanceView(base, s).nets : [];
    },
  });
}

/**
 * One instance as the demo params want it shown: ?state=gate-closed pushes the open instance a
 * minute past its deadline with nothing posted (tallying); ?outcome= rewrites today's closed
 * instance's results (and, for the outcomes where you did not tap, drops your taps). Nets are the
 * payout rule applied to whatever results are shown (the server's view, in demo).
 */
function instanceView(base: PactInstanceRow, s: DemoSettings): { instance: PactInstanceRow; results: ResultRow[]; checkins: CheckinRow[]; nets: InstanceMemberNetRow[] } {
  let instance = base;
  let results = store.results.filter((r) => r.instance_id === base.id);
  let checkins = store.checkins.filter((c) => c.instance_id === base.id);
  if (s.state === 'gate-closed' && base.id === INSTANCES.open) {
    const deadline = DEMO_T0 - 70_000;
    instance = { ...base, window_open_at: new Date(deadline - 3_600_000).toISOString(), deadline_at: new Date(deadline).toISOString(), deadline_soon_sent_at: new Date(deadline - 900_000).toISOString() };
    results = [];
  } else if (s.outcome !== 'fixture' && base.id === INSTANCES.closed) {
    results = outcomeResults(s.outcome);
    if (s.outcome === 'void') instance = { ...base, status: 'voided', carry_in_cents: null };
    if (s.outcome !== 'win') checkins = checkins.filter((c) => c.user_id !== DEMO_USER_ID);
  }
  const pact = store.pacts.find((p) => p.id === instance.pact_id);
  const nets = instance.status === 'closed' || instance.status === 'settled' ? netsFor(instance, results, pact?.stake_cents ?? 0, pact?.group_id) : [];
  return { instance, results, checkins, nets };
}

export const FEED_DAYS = 28;

export function useFeed(groupId: string) {
  const s = useDemoSettings();
  return useQuery({
    queryKey: [...queryKeys.feed(groupId), demoKey(s)],
    queryFn: async (): Promise<Feed> => {
      await gate(s);
      const profiles = profileMap();
      const empty: Feed = { items: [], profiles, rosterByInstance: new Map(), placeEvents: [], pacts: [], placesById: new Map() };
      if (isEmptyGroup(groupId, s)) return empty;
      const now = Date.now();
      const since = now - FEED_DAYS * 86_400_000;
      const pacts = store.pacts.filter((p) => p.group_id === GROUP_ID);
      empty.pacts = pacts;
      empty.placeEvents = store.placeEvents
        .filter((e) => e.group_id === GROUP_ID && Date.parse(e.created_at) >= since)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      empty.placesById = new Map(pacts.flatMap((p) => visiblePlaces(p.id)).map((r) => [r.place_id, r]));
      const instances = store.instances.filter(
        (i) => pacts.some((p) => p.id === i.pact_id) && Date.parse(i.deadline_at) >= since && ['closed', 'settled', 'voided'].includes(i.status),
      );
      const ids = new Set(instances.map((i) => i.id));
      const results = store.results.filter((r) => ids.has(r.instance_id) && r.status !== 'pending');
      const items: FeedItem[] = results.map((result) => {
        const instance = instances.find((i) => i.id === result.instance_id)!;
        const pact = pacts.find((p) => p.id === instance.pact_id)!;
        return {
          result,
          instance,
          pact,
          reviews: store.reviews
            .filter((r) => r.instance_id === result.instance_id && r.subject_user_id === result.user_id)
            .map((review) => ({ review, votes: store.votes.filter((v) => v.review_id === review.id) })),
        };
      });
      items.sort(
        (a, b) =>
          Date.parse(b.instance.deadline_at) - Date.parse(a.instance.deadline_at) || a.result.user_id.localeCompare(b.result.user_id),
      );
      const rosterByInstance = new Map<string, string[]>();
      for (const r of results) rosterByInstance.set(r.instance_id, [...(rosterByInstance.get(r.instance_id) ?? []), r.user_id]);
      return { ...empty, items, rosterByInstance };
    },
  });
}

/** Demo: the unverified-budget count comes from `?budget=N` (settings.ts). */
export function useUnverifiedBudget(_pactId: string, _userId: string, _localDate: string): number {
  return useDemoSettings().budget;
}

export function useLedger(groupId: string) {
  const s = useDemoSettings();
  return useQuery({
    queryKey: [...queryKeys.ledger(groupId), demoKey(s)],
    queryFn: async (): Promise<Ledger> => {
      await gate(s);
      const profiles = profileMap();
      if (isEmptyGroup(groupId, s)) return { balances: [], latestSettlement: null, settlements: [], obligations: [], profiles };
      const settlements = [...store.settlements].sort((a, b) => b.week_start.localeCompare(a.week_start));
      // `?settle=owe|owed` shows one side of the latest settle-up; rows stay in the store so RPCs find them
      const variant = SETTLE_VARIANTS[s.settle];
      const obligations = store.obligations
        .filter((o) => OPEN_OBLIGATION_STATUSES.includes(o.status) && variant.obligationIds.includes(o.id))
        .sort((a, b) => b.amount_cents - a.amount_cents);
      return {
        balances: [...variant.balances].sort((a, b) => b.balance_cents - a.balance_cents),
        latestSettlement: settlements[0] ?? null,
        settlements,
        obligations,
        profiles,
      };
    },
  });
}

// ---------- RPCs ----------

const id = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

export const createGroup = async (name: string, settlementTz: string): Promise<string> => {
  await gate(getDemoSettings());
  const g = { id: id('g'), name, invite_code: id('INV').toUpperCase(), settlement_tz: settlementTz, created_by: DEMO_USER_ID, created_at: new Date().toISOString() };
  store.groups.push(g);
  store.members.push({ group_id: g.id, user_id: DEMO_USER_ID, role: 'owner', joined_at: g.created_at, left_at: null });
  return g.id;
};

export const joinGroup = async (inviteCode: string): Promise<string> => {
  await gate(getDemoSettings());
  const g = store.groups.find((x) => x.invite_code === inviteCode.trim().toUpperCase());
  if (!g) throw new DbError({ message: 'invalid invite code', code: 'P0002' });
  return g.id;
};

export const leaveGroup = async (groupId: string): Promise<undefined> => {
  await gate(getDemoSettings());
  const m = store.members.find((x) => x.group_id === groupId && x.user_id === DEMO_USER_ID);
  if (m) m.left_at = new Date().toISOString();
  return undefined;
};

/** Demo account deletion: leaves every group and anonymizes the fixture profile (relaunch resets it). */
export const deleteMyAccount = async (): Promise<undefined> => {
  await gate(getDemoSettings());
  const now = new Date().toISOString();
  for (const m of store.members) if (m.user_id === DEMO_USER_ID && !m.left_at) m.left_at = now;
  for (const pp of store.participants) if (pp.user_id === DEMO_USER_ID && !pp.left_at) pp.left_at = now;
  const me = store.profiles.find((x) => x.id === DEMO_USER_ID);
  if (me) Object.assign(me, { display_name: 'Deleted member', venmo_username: null });
  setDemoSettings({ ...getDemoSettings(), signedOut: true });
  return undefined;
};

export const createPact = async (p: CreatePactInput): Promise<string> => {
  await gate(getDemoSettings());
  const pact = {
    id: id('p'),
    group_id: p.groupId,
    title: p.title,
    days_of_week: p.days,
    window_open_local: p.windowOpen,
    deadline_local: p.deadline,
    stake_cents: p.stakeCents,
    tz: p.tz,
    paused: false,
    created_by: DEMO_USER_ID,
    created_at: new Date().toISOString(),
  };
  store.pacts.push(pact);
  return pact.id;
};

export const joinPact = async (p: JoinPactInput): Promise<undefined> => {
  await gate(getDemoSettings());
  const now = new Date().toISOString();
  const existing = store.participants.find((x) => x.pact_id === p.pactId && x.user_id === DEMO_USER_ID && !x.left_at);
  if (existing) Object.assign(existing, { place_lat: p.lat, place_lng: p.lng, place_radius_m: p.radiusM, place_label: p.label });
  else store.participants.push({ pact_id: p.pactId, user_id: DEMO_USER_ID, place_lat: p.lat, place_lng: p.lng, place_radius_m: p.radiusM, place_label: p.label, joined_at: now, left_at: null });
  // a change is gated (another member must confirm it, or 24 h pass) when anybody else is in the group
  const groupId = store.pacts.find((x) => x.id === p.pactId)?.group_id;
  const others = store.members.some((m) => m.group_id === groupId && m.user_id !== DEMO_USER_ID && !m.left_at);
  const gated = existing !== undefined && others;
  const effective = !existing ? now : new Date(Date.now() + (gated ? 24 : 12) * 3_600_000).toISOString();
  // a new request replaces a change that does not count yet
  for (let i = store.placeHistory.length - 1; i >= 0; i -= 1) {
    const h = store.placeHistory[i]!;
    if (h.pact_id === p.pactId && h.user_id === DEMO_USER_ID && Date.parse(h.effective_from) > Date.now() && !h.objected_at) store.placeHistory.splice(i, 1);
  }
  const row: PactParticipantPlaceRow = {
    id: id('ph'),
    pact_id: p.pactId,
    user_id: DEMO_USER_ID,
    lat: p.lat,
    lng: p.lng,
    radius_m: p.radiusM,
    label: p.label,
    effective_from: effective,
    created_at: now,
    requires_ack: gated,
    acknowledged_at: null,
    acknowledged_by: null,
    objected_at: null,
    objected_by: null,
    objection_reason: null,
    effective_event_at: null,
  };
  store.placeHistory.push(row);
  pushPlaceEvent(row, 'created', DEMO_USER_ID, null);
  return undefined;
};

export const acknowledgePlace = async (placeId: string): Promise<undefined> => {
  await gate(getDemoSettings());
  const h = store.placeHistory.find((x) => x.id === placeId);
  if (!h) throw new DbError({ message: 'place not found', code: 'P0002' });
  if (h.user_id === DEMO_USER_ID) throw new DbError({ message: 'you cannot confirm your own place', code: '42501' });
  if (h.objected_at) throw new DbError({ message: 'this place was objected to and cannot be confirmed', code: '23514' });
  if (h.acknowledged_at) throw new DbError({ message: 'this place was already confirmed', code: '23514' });
  if (!h.requires_ack || Date.parse(h.effective_from) <= Date.now()) throw new DbError({ message: 'this place already counts', code: '23514' });
  const now = Date.now();
  h.acknowledged_at = new Date(now).toISOString();
  h.acknowledged_by = DEMO_USER_ID;
  h.effective_from = new Date(Math.max(now, Date.parse(h.created_at) + 12 * 3_600_000)).toISOString();
  pushPlaceEvent(h, 'acknowledged', DEMO_USER_ID, null);
  return undefined;
};

export const objectPlace = async (placeId: string, reason: string): Promise<undefined> => {
  await gate(getDemoSettings());
  const h = store.placeHistory.find((x) => x.id === placeId);
  if (!h) throw new DbError({ message: 'place not found', code: 'P0002' });
  if (reason.trim().length === 0) throw new DbError({ message: 'a reason is required', code: '22023' });
  if (h.user_id === DEMO_USER_ID) throw new DbError({ message: 'you cannot object to your own place', code: '42501' });
  if (h.objected_at) throw new DbError({ message: 'this place was already objected to', code: '23514' });
  if (h.acknowledged_at) throw new DbError({ message: 'another member already confirmed this place', code: '23514' });
  if (Date.parse(h.created_at) + 24 * 3_600_000 <= Date.now()) throw new DbError({ message: 'too late to object', code: '23514' });
  h.objected_at = new Date().toISOString();
  h.objected_by = DEMO_USER_ID;
  h.objection_reason = reason.trim();
  pushPlaceEvent(h, 'objected', DEMO_USER_ID, reason.trim());
  return undefined;
};

export const setPactPaused = async (pactId: string, paused: boolean): Promise<undefined> => {
  await gate(getDemoSettings());
  const p = store.pacts.find((x) => x.id === pactId);
  if (p) p.paused = paused;
  return undefined;
};

export const CHECK_IN_TIMEOUT_MS = 15_000;

/** Resolves after a short "sending" delay with the verdict chosen by `?verdict=`. */
export const checkIn = async (a: CheckinAttempt): Promise<CheckinRow> => {
  const s = getDemoSettings();
  await wait(300);
  if (s.state === 'offline' || s.state === 'queued') throw await networkError();
  if (s.state === 'error') throw new DbError({ message: 'internal error', code: 'XX000' });
  const verdict = a.lat === null ? 'unjudgeable' : s.verdict;
  const now = new Date().toISOString();
  const row: CheckinRow = {
    id: id('c'),
    instance_id: a.instanceId,
    user_id: DEMO_USER_ID,
    client_captured_at: a.clientCapturedAt,
    server_received_at: now,
    lat: a.lat,
    lng: a.lng,
    accuracy_m: verdict === 'unjudgeable' ? 480 : a.accuracyM,
    distance_m: verdict === 'in_fence' ? 18 : verdict === 'out_of_fence' ? 212 : null,
    is_simulated: verdict === 'rejected_simulated',
    verdict,
    client_attempt_id: attemptId(a),
  };
  store.checkins.push(row);
  return row;
};

export async function sendQueuedCheckin(a: CheckinAttempt): Promise<SendOutcome<CheckinRow>> {
  try {
    return { kind: 'ok', result: await checkIn(a) };
  } catch (e) {
    const { RpcError } = await import('../rpc');
    const transport = e instanceof RpcError && e.kind !== 'rejected';
    return transport ? { kind: 'retry', error: (e as Error).message } : { kind: 'reject', error: userMessage(e) };
  }
}

export const declareFreeze = async (instanceId: string): Promise<string> => {
  await gate(getDemoSettings());
  const inst = store.instances.find((i) => i.id === instanceId);
  const f = {
    id: id('f'),
    pact_id: inst?.pact_id ?? '',
    user_id: DEMO_USER_ID,
    instance_id: instanceId,
    declared_at: new Date().toISOString(),
    iso_week: inst ? `${inst.local_date.slice(0, 4)}-W${inst.local_date.slice(5, 7)}` : '',
  };
  store.freezes.push(f);
  return f.id;
};

export const openReview = async (r: OpenReviewInput): Promise<string> => {
  await gate(getDemoSettings());
  const review = { id: id('r'), instance_id: r.instanceId, subject_user_id: r.subjectUserId, opened_by: DEMO_USER_ID, kind: r.kind, reason: r.reason, photo_path: r.photoPath ?? null, status: 'open' as const, opened_at: new Date().toISOString(), resolved_at: null, system_opened: false };
  store.reviews.push(review);
  return review.id;
};

export const castVote = async (reviewId: string, supports: boolean): Promise<undefined> => {
  await gate(getDemoSettings());
  const existing = store.votes.find((v) => v.review_id === reviewId && v.voter_id === DEMO_USER_ID);
  if (existing) existing.supports = supports;
  else store.votes.push({ review_id: reviewId, voter_id: DEMO_USER_ID, supports, cast_at: new Date().toISOString() });
  return undefined;
};

const setObligation = async (obligationId: string, status: 'pending' | 'marked_paid' | 'confirmed') => {
  await gate(getDemoSettings());
  const o = store.obligations.find((x) => x.id === obligationId);
  if (!o) throw new DbError({ message: 'obligation not found', code: 'P0002' });
  o.status = status;
  const now = new Date().toISOString();
  if (status === 'marked_paid') o.marked_paid_at = now;
  if (status === 'confirmed') o.confirmed_at = now;
  if (status === 'pending') o.marked_paid_at = null;
  return undefined;
};

export const markObligationPaid = (obligationId: string) => setObligation(obligationId, 'marked_paid');
export const confirmObligation = (obligationId: string) => setObligation(obligationId, 'confirmed');
export const disputeObligation = (obligationId: string) => setObligation(obligationId, 'pending');

export const registerPushToken = async (): Promise<undefined> => undefined;

/** Exposed for the screenshot harness and the README. */
export const demoRoutes = {
  groupId: GROUP_ID,
  emptyGroupId: EMPTY_GROUP_ID,
  inviteCode: INVITE_CODE,
  anchoredAt: DEMO_T0,
};

// ---------- seasons, streaks and settle-up completion (Q2; mirrors 20261108000700_seasons.sql) ----------

export const setPactSeason = async (pactId: string, start: string | null, weeks: number | null): Promise<undefined> => {
  await gate(getDemoSettings());
  const p = store.pacts.find((x) => x.id === pactId);
  if (!p) throw new DbError({ message: 'pact not found', code: 'P0002' });
  if ((start === null) !== (weeks === null)) throw new DbError({ message: 'a season needs both a start date and a length in weeks, or neither', code: '22023' });
  if (weeks !== null && (weeks < 1 || weeks > 12)) throw new DbError({ message: 'a season runs between 1 and 12 weeks', code: '23514' });
  p.season_start = start;
  p.season_weeks = weeks;
  return undefined;
};

const closedInstancesOf = (pactId: string) =>
  store.instances.filter((i) => i.pact_id === pactId && (i.status === 'closed' || i.status === 'settled'));

/** `pact_streaks` over the fixtures: success extends, frozen is neutral, missed / unverified break, voided days ignored. */
function demoStreaks(pactId: string): PactStreakRow[] {
  const dateOf = new Map(closedInstancesOf(pactId).map((i) => [i.id, i.local_date]));
  const perUser = new Map<string, { date: string; success: boolean }[]>();
  for (const r of store.results) {
    const date = dateOf.get(r.instance_id);
    if (!date || (r.status !== 'success' && r.status !== 'failed' && r.status !== 'unverified')) continue;
    const list = perUser.get(r.user_id) ?? [];
    list.push({ date, success: r.status === 'success' });
    perUser.set(r.user_id, list);
  }
  return [...perUser.entries()].map(([user_id, days]) => {
    let current = 0;
    let best = 0;
    for (const d of days.sort((a, b) => a.date.localeCompare(b.date))) {
      current = d.success ? current + 1 : 0;
      best = Math.max(best, current);
    }
    return { pact_id: pactId, user_id, current_streak: current, best_streak: best };
  });
}

/** `pact_season_recaps` over the fixtures for one pact (empty without a season). */
function demoRecaps(pactId: string): PactSeasonRecapRow[] {
  const pact = store.pacts.find((p) => p.id === pactId);
  const season = pact ? seasonOf(pact) : null;
  if (!pact || !season) return [];
  const end = seasonEnd(season);
  const insts = closedInstancesOf(pactId).filter((i) => i.local_date >= season.start && i.local_date <= end);
  const rows = new Map<string, PactSeasonRecapRow>();
  const rowFor = (user_id: string) => {
    let r = rows.get(user_id);
    if (!r) {
      r = { pact_id: pactId, user_id, season_start: season.start, season_end: end, days: 0, showed_up: 0, missed: 0, unverified: 0, frozen: 0, net_cents: 0 };
      rows.set(user_id, r);
    }
    return r;
  };
  for (const inst of insts) {
    for (const res of store.results.filter((r) => r.instance_id === inst.id)) {
      const r = rowFor(res.user_id);
      if (res.status === 'success') (r.days += 1), (r.showed_up += 1);
      else if (res.status === 'failed') (r.days += 1), (r.missed += 1);
      else if (res.status === 'unverified') (r.days += 1), (r.unverified += 1);
      else if (res.status === 'frozen') (r.days += 1), (r.frozen += 1);
    }
    for (const n of netsFor(inst, store.results.filter((r) => r.instance_id === inst.id), pact.stake_cents)) rowFor(n.user_id).net_cents += n.net_cents;
  }
  return [...rows.values()];
}

/** `group_settlement_stats` over the fixtures (the `ov-` rows exist only for the `?settle=owe` variant). */
function demoSettlementStats(groupId: string): GroupSettlementStatsRow {
  const obligations = store.obligations.filter((o) => o.group_id === groupId && !o.id.startsWith('ov-'));
  const created = obligations.filter((o) => o.status !== 'superseded').length;
  const confirmed = obligations.filter((o) => o.status === 'confirmed').length;
  const settlements = store.settlements.filter((s) => s.group_id === groupId);
  return {
    group_id: groupId,
    obligations_created: created,
    obligations_confirmed: confirmed,
    completion_rate: created === 0 ? null : Math.round((confirmed / created) * 10_000) / 10_000,
    weeks_settled: settlements.length,
    last_settled_week: settlements.map((s) => s.week_start).sort().at(-1) ?? null,
  };
}

export function useGroupStats(groupId: string) {
  const s = useDemoSettings();
  return useQuery({
    queryKey: ['group', groupId, 'stats', demoKey(s)],
    queryFn: async (): Promise<GroupStats> => {
      await gate(s);
      const profiles = profileMap();
      if (isEmptyGroup(groupId, s)) {
        const members = store.members.filter((m) => m.group_id === EMPTY_GROUP_ID);
        return { stats: demoSettlementStats(EMPTY_GROUP_ID), pacts: [], members, profiles, recaps: [], streaks: [], hasClosedDays: false };
      }
      const pacts = store.pacts.filter((p) => p.group_id === GROUP_ID);
      return {
        stats: demoSettlementStats(GROUP_ID),
        pacts,
        members: store.members.filter((m) => m.group_id === GROUP_ID && !m.left_at),
        profiles,
        recaps: pacts.flatMap((p) => demoRecaps(p.id)),
        streaks: pacts.flatMap((p) => demoStreaks(p.id)),
        hasClosedDays: pacts.some((p) => closedInstancesOf(p.id).length > 0),
      };
    },
  });
}

export function usePactStats(pactId: string, enabled = true) {
  const s = useDemoSettings();
  return useQuery({
    queryKey: ['pact', pactId, 'stats', demoKey(s)],
    enabled,
    queryFn: async (): Promise<PactStats> => {
      await gate(s);
      if (s.empty) return { streaks: [], recaps: [] };
      return { streaks: demoStreaks(pactId), recaps: demoRecaps(pactId) };
    },
  });
}

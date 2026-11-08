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
import { effectivePlaceAt, nextWindow, placeForWindow } from '../../lib/places';
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
import type { CheckinRow, ProfileRow } from '../types';
import { DEMO_T0, EMPTY_GROUP_ID, GROUP_ID, INVITE_CODE, SETTLE_VARIANTS, store } from './fixtures';
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

// ---------- settings plumbing ----------

/** Reads the demo params from the current URL and publishes them to the process-wide store. */
export function useDemoSettings(): DemoSettings {
  const params = useGlobalSearchParams<Record<string, string | string[]>>();
  const settings = demoSettingsFromParams(params as Record<string, string | string[] | undefined>);
  useEffect(() => setDemoSettings(settings), [settings.verdict, settings.empty, settings.state, settings.perm, settings.signedOut, settings.freeze, settings.settle, settings.fix]); // eslint-disable-line react-hooks/exhaustive-deps
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
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.profile(userId) }),
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

export function useGroupHome(groupId: string, userId: string) {
  const s = useDemoSettings();
  return useQuery({
    queryKey: [...queryKeys.groupHome(groupId), demoKey(s)],
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
        const summary = summarizeInstance({
          participantIds,
          deadlineAt: instance.deadline_at,
          checkins: store.checkins.filter((c) => c.instance_id === instance.id),
          results: store.results.filter((r) => r.instance_id === instance.id),
        });
        today.push({ instance, pact, participantIds, summary, myState: summary.byUser[userId] ?? null });
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
      const instance = store.instances.find((i) => i.id === instanceId) ?? store.instances[0]!;
      const pact = store.pacts.find((p) => p.id === instance.pact_id)!;
      const mine = store.participants.find((p) => p.pact_id === pact.id && p.user_id === userId && !p.left_at) ?? null;
      const history = store.placeHistory.filter((p) => p.pact_id === pact.id && p.user_id === userId);
      return {
        instance,
        pact,
        myPlace: mine,
        judgedPlace: mine ? placeForWindow(history, instance.window_open_at, mine) : null,
        myCheckins: store.checkins
          .filter((c) => c.instance_id === instanceId && c.user_id === userId)
          .sort((a, b) => Date.parse(a.server_received_at) - Date.parse(b.server_received_at)),
        myResult: store.results.find((r) => r.instance_id === instanceId && r.user_id === userId) ?? null,
        myFreeze: store.freezes.find((f) => f.instance_id === instanceId && f.user_id === userId) ?? null,
      };
    },
  });
}

export const FEED_DAYS = 28;

export function useFeed(groupId: string) {
  const s = useDemoSettings();
  return useQuery({
    queryKey: [...queryKeys.feed(groupId), demoKey(s)],
    queryFn: async (): Promise<Feed> => {
      await gate(s);
      const profiles = profileMap();
      const empty: Feed = { items: [], profiles, rosterByInstance: new Map(), excludedThisMonth: new Map() };
      if (isEmptyGroup(groupId, s)) return empty;
      const now = Date.now();
      const since = now - FEED_DAYS * 86_400_000;
      const pacts = store.pacts.filter((p) => p.group_id === GROUP_ID);
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
      const monthPrefix = new Date(now).toISOString().slice(0, 7);
      const excludedThisMonth = new Map<string, number>();
      for (const item of items) {
        if (item.result.status === 'excluded' && item.instance.local_date.startsWith(monthPrefix)) {
          excludedThisMonth.set(item.result.user_id, (excludedThisMonth.get(item.result.user_id) ?? 0) + 1);
        }
      }
      const rosterByInstance = new Map<string, string[]>();
      for (const r of results) rosterByInstance.set(r.instance_id, [...(rosterByInstance.get(r.instance_id) ?? []), r.user_id]);
      return { items, profiles, rosterByInstance, excludedThisMonth };
    },
  });
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
  const effective = existing ? new Date(Date.now() + 12 * 3_600_000).toISOString() : now;
  store.placeHistory.push({ pact_id: p.pactId, user_id: DEMO_USER_ID, lat: p.lat, lng: p.lng, radius_m: p.radiusM, label: p.label, effective_from: effective, created_at: now });
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
  const review = { id: id('r'), instance_id: r.instanceId, subject_user_id: r.subjectUserId, opened_by: DEMO_USER_ID, kind: r.kind, reason: r.reason, photo_path: r.photoPath ?? null, status: 'open' as const, opened_at: new Date().toISOString(), resolved_at: null };
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

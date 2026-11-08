import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { DbError } from '../lib/errors';
import { OPEN_OBLIGATION_STATUSES } from '../lib/obligations';
import { effectivePlaceAt, nextWindow, placeForWindow, type WindowPlace } from '../lib/places';
import { summarizeInstance, type InstanceSummary, type MemberDayState } from '../lib/instanceStatus';
import { gateClosePollInterval } from '../lib/gatePoll';
import { currentLocalDate, summaryFromProgress } from '../features/goal/progress';
import { isGoalKind } from '../features/goal/goal';
import { windowState } from '../lib/time';
import * as demo from './demo';
import { DEMO } from './demo/settings';
import { supabase } from './supabase';
import type {
  CheckinRow,
  FreezeRow,
  GroupMemberRow,
  GroupRow,
  InstanceMemberNetRow,
  InstanceProgressRow,
  InstanceStandingRow,
  MemberBalanceRow,
  ObligationRow,
  PactActivityRow,
  PactInstanceRow,
  PactParticipantPlaceRow,
  PactParticipantRow,
  PactPlaceVisibleRow,
  PactRow,
  PlaceDistanceRow,
  PlaceEventRow,
  ProfileRow,
  ResultRow,
  ReviewRow,
  ReviewVoteRow,
  SettlementRow,
} from './types';

/** Queries that cache a person's display name next to their own data; a profile edit refreshes them. */
export const PROFILE_DEPENDENT_KEYS = (userId: string): QueryKey[] => [['profile', userId], ['group'], ['groups']];

export const queryKeys = {
  myGroups: (userId: string) => ['groups', userId] as const,
  groupHome: (groupId: string) => ['group', groupId, 'home'] as const,
  pact: (pactId: string) => ['pact', pactId] as const,
  instance: (instanceId: string) => ['instance', instanceId] as const,
  feed: (groupId: string) => ['group', groupId, 'feed'] as const,
  ledger: (groupId: string) => ['group', groupId, 'ledger'] as const,
  profile: (userId: string) => ['profile', userId] as const,
};

/** Unwraps a PostgREST response, throwing its error. */
function must<T>(res: { data: T | null; error: { message: string; code?: string } | null }): NonNullable<T> {
  if (res.error) throw new DbError(res.error);
  if (res.data === null || res.data === undefined) throw new Error('No data returned');
  return res.data as NonNullable<T>;
}

const uniq = <T,>(xs: readonly T[]): T[] => [...new Set(xs)];

async function fetchProfiles(userIds: string[]): Promise<Map<string, ProfileRow>> {
  if (userIds.length === 0) return new Map();
  const rows = must(await supabase.from('profiles').select('*').in('id', uniq(userIds)));
  return new Map(rows.map((p) => [p.id, p]));
}

export const displayName = (profiles: Map<string, ProfileRow>, userId: string): string =>
  profiles.get(userId)?.display_name ?? 'Someone';

// ---------- profile ----------

function useProfileReal(userId: string) {
  return useQuery({
    queryKey: queryKeys.profile(userId),
    queryFn: async () => await supabase.from('profiles').select('*').eq('id', userId).single().then(must),
  });
}

function useUpdateProfileReal(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: { display_name?: string; venmo_username?: string | null }) => {
      const { error } = await supabase.from('profiles').update(patch).eq('id', userId);
      if (error) throw new DbError(error);
    },
    // the name is embedded in every group, feed and ledger query (A6), and in the groups list
    onSuccess: () => Promise.all(PROFILE_DEPENDENT_KEYS(userId).map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

// ---------- my groups ----------

export interface MyGroup {
  group: GroupRow;
  role: GroupMemberRow['role'];
  memberCount: number;
}

function useMyGroupsReal(userId: string) {
  return useQuery({
    queryKey: queryKeys.myGroups(userId),
    queryFn: async (): Promise<MyGroup[]> => {
      const memberships = must(
        await supabase.from('group_members').select('*').eq('user_id', userId).is('left_at', null),
      );
      const ids = memberships.map((m) => m.group_id);
      if (ids.length === 0) return [];
      const [groups, allMembers] = await Promise.all([
        supabase.from('groups').select('*').in('id', ids).then(must),
        supabase.from('group_members').select('group_id').in('group_id', ids).is('left_at', null).then(must),
      ]);
      return groups
        .map((group) => ({
          group,
          role: memberships.find((m) => m.group_id === group.id)?.role ?? 'member',
          memberCount: allMembers.filter((m) => m.group_id === group.id).length,
        }))
        .sort((a, b) => a.group.name.localeCompare(b.group.name));
    },
  });
}

// ---------- group home ----------

/** Goal kinds: everyone's progress and the ranked standings for one instance (`instance_progress`, `instance_standings`). */
export interface GoalSnapshot {
  progress: InstanceProgressRow[];
  standings: InstanceStandingRow[];
}

export interface TodayItem {
  /** today's instance; for a weekly pact this week's (local_date = Monday); for a race, the race */
  instance: PactInstanceRow;
  pact: PactRow;
  participantIds: string[];
  /** for goal kinds, "checked in" means "reached the goal" (summaryFromProgress) */
  summary: InstanceSummary;
  myState: MemberDayState | null;
  /** present for goal kinds */
  goal?: GoalSnapshot;
}

export interface GroupHome {
  group: GroupRow;
  members: GroupMemberRow[];
  profiles: Map<string, ProfileRow>;
  pacts: PactRow[];
  /** pacts the current user has not joined (no place set yet) */
  unjoinedPactIds: Set<string>;
  today: TodayItem[];
}

function useGroupHomeReal(groupId: string, userId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.groupHome(groupId),
    enabled,
    queryFn: async (): Promise<GroupHome> => {
      const now = Date.now();
      const [group, members, pacts] = await Promise.all([
        supabase.from('groups').select('*').eq('id', groupId).single().then(must),
        supabase.from('group_members').select('*').eq('group_id', groupId).is('left_at', null).then(must),
        supabase.from('pacts').select('*').eq('group_id', groupId).order('created_at').then(must),
      ]);
      const pactIds = pacts.map((p) => p.id);
      const profiles = await fetchProfiles(members.map((m) => m.user_id));
      if (pactIds.length === 0) {
        return { group, members, profiles, pacts, unjoinedPactIds: new Set(), today: [] };
      }
      // daily pacts: today; weekly: this week's Monday; a race: its start (features/goal/progress.ts)
      const todayByPact = new Map(pacts.map((p) => [p.id, currentLocalDate(p, now)]));
      const [participants, instances] = await Promise.all([
        supabase.from('pact_participants').select('*').in('pact_id', pactIds).is('left_at', null).then(must),
        supabase
          .from('pact_instances')
          .select('*')
          .in('pact_id', pactIds)
          .in('local_date', uniq([...todayByPact.values()]))
          .then(must),
      ]);
      const todays = instances.filter((i) => todayByPact.get(i.pact_id) === i.local_date);
      const instanceIds = todays.map((i) => i.id);
      const goalInstanceIds = todays.filter((i) => isGoalKind(pacts.find((p) => p.id === i.pact_id)?.kind ?? 'show_up')).map((i) => i.id);
      const [checkins, results, progress, standings] =
        instanceIds.length === 0
          ? [[], [], [], []]
          : await Promise.all([
              supabase
                .from('checkins')
                .select('instance_id,user_id,verdict,server_received_at')
                .in('instance_id', instanceIds)
                .then(must),
              supabase.from('results').select('*').in('instance_id', instanceIds).then(must),
              goalInstanceIds.length === 0 ? [] : supabase.from('instance_progress').select('*').in('instance_id', goalInstanceIds).then(must),
              goalInstanceIds.length === 0 ? [] : supabase.from('instance_standings').select('*').in('instance_id', goalInstanceIds).order('rank').then(must),
            ]);
      const today: TodayItem[] = todays
        .map((instance) => {
          const pact = pacts.find((p) => p.id === instance.pact_id)!;
          const participantIds = participants.filter((p) => p.pact_id === pact.id).map((p) => p.user_id);
          const instanceResults = results.filter((r) => r.instance_id === instance.id);
          if (isGoalKind(pact.kind)) {
            const goal: GoalSnapshot = {
              progress: progress.filter((p) => p.instance_id === instance.id),
              standings: standings.filter((s) => s.instance_id === instance.id),
            };
            const summary = summaryFromProgress(participantIds, instance.deadline_at, goal.progress, instanceResults);
            return { instance, pact, participantIds, summary, myState: summary.byUser[userId] ?? null, goal };
          }
          const summary = summarizeInstance({
            participantIds,
            deadlineAt: instance.deadline_at,
            checkins: checkins.filter((c) => c.instance_id === instance.id),
            results: instanceResults,
          });
          return { instance, pact, participantIds, summary, myState: summary.byUser[userId] ?? null };
        })
        .sort((a, b) => Date.parse(a.instance.deadline_at) - Date.parse(b.instance.deadline_at));
      const joined = new Set(participants.filter((p) => p.user_id === userId).map((p) => p.pact_id));
      return {
        group,
        members,
        profiles,
        pacts,
        unjoinedPactIds: new Set(pactIds.filter((id) => !joined.has(id))),
        today,
      };
    },
    // Live "2 of 4 checked in": poll quickly while any window is open.
    refetchInterval: (query) => {
      const data = query.state.data;
      const anyOpen = data?.today.some(
        (t) => windowState(Date.now(), t.instance.window_open_at, t.instance.deadline_at) === 'open',
      );
      return anyOpen ? 10_000 : 60_000;
    },
  });
}

// ---------- pact detail ----------

/**
 * Goal kinds on the pact screen: the current instance (this week / the race) and the last closed
 * one, everyone's progress and standings for both, their posted results and ledger nets, and the
 * activities that count toward (or were rejected for) them, newest first.
 */
export interface PactGoalDetail {
  current: PactInstanceRow | null;
  last: PactInstanceRow | null;
  progress: InstanceProgressRow[];
  standings: InstanceStandingRow[];
  results: ResultRow[];
  nets: InstanceMemberNetRow[];
  activities: PactActivityRow[];
}

export interface PactDetail {
  pact: PactRow;
  participants: PactParticipantRow[];
  profiles: Map<string, ProfileRow>;
  upcoming: PactInstanceRow[];
  myFreezes: FreezeRow[];
  /** every current participant's place rows (in force, pending, objected), as the group sees them; empty for goal kinds */
  places: PactPlaceVisibleRow[];
  /** metres from each place to the other participants' places in force; empty for goal kinds */
  distances: PlaceDistanceRow[];
  /** present for goal kinds */
  goal?: PactGoalDetail;
}

/** The pact's current instance (this week / today / the race) and the most recent closed one before it. */
export function pickGoalInstances(pact: PactRow, instances: readonly PactInstanceRow[], nowMs: number): { current: PactInstanceRow | null; last: PactInstanceRow | null } {
  const wanted = currentLocalDate(pact, nowMs);
  const sorted = [...instances].sort((a, b) => Date.parse(a.deadline_at) - Date.parse(b.deadline_at));
  const current = sorted.find((i) => i.local_date === wanted) ?? sorted.find((i) => Date.parse(i.deadline_at) > nowMs) ?? null;
  const last = [...sorted].reverse().find((i) => i.id !== current?.id && Date.parse(i.deadline_at) <= nowMs && i.status !== 'voided') ?? null;
  return { current, last };
}

async function fetchGoalDetail(pact: PactRow, nowMs: number): Promise<PactGoalDetail> {
  const since = new Date(nowMs - 21 * 86_400_000).toISOString();
  const instances = must(
    await supabase.from('pact_instances').select('*').eq('pact_id', pact.id).gte('deadline_at', since).order('deadline_at').limit(12),
  );
  const { current, last } = pickGoalInstances(pact, instances, nowMs);
  const ids = [current?.id, last?.id].filter((x): x is string => !!x);
  if (ids.length === 0) return { current, last, progress: [], standings: [], results: [], nets: [], activities: [] };
  const [progress, standings, results, nets, activities] = await Promise.all([
    supabase.from('instance_progress').select('*').in('instance_id', ids).then(must),
    supabase.from('instance_standings').select('*').in('instance_id', ids).order('rank').then(must),
    supabase.from('results').select('*').in('instance_id', ids).then(must),
    supabase.from('instance_member_nets').select('*').in('instance_id', ids).then(must),
    supabase.from('pact_activities').select('*').in('instance_id', ids).order('started_at', { ascending: false }).limit(100).then(must),
  ]);
  return { current, last, progress, standings, results, nets, activities };
}

function usePactDetailReal(pactId: string, userId: string) {
  return useQuery({
    queryKey: queryKeys.pact(pactId),
    queryFn: async (): Promise<PactDetail> => {
      const now = Date.now();
      const since = new Date(now - 86_400_000).toISOString();
      const pact = await supabase.from('pacts').select('*').eq('id', pactId).single().then(must);
      const goalKind = isGoalKind(pact.kind);
      const [participants, upcoming, myFreezes, places, distances, goal] = await Promise.all([
        supabase.from('pact_participants').select('*').eq('pact_id', pactId).is('left_at', null).then(must),
        supabase
          .from('pact_instances')
          .select('*')
          .eq('pact_id', pactId)
          .gte('deadline_at', since)
          .order('deadline_at')
          .limit(10)
          .then(must),
        supabase.from('freezes').select('*').eq('pact_id', pactId).eq('user_id', userId).then(must),
        // places exist only for show_up
        goalKind ? [] : supabase.from('pact_places_visible').select('*').eq('pact_id', pactId).order('created_at').then(must),
        goalKind ? [] : supabase.rpc('pact_place_distances', { p_pact: pactId }).then(must),
        goalKind ? fetchGoalDetail(pact, now) : undefined,
      ]);
      const profiles = await fetchProfiles(participants.map((p) => p.user_id));
      return { pact, participants, profiles, upcoming, myFreezes, places, distances, ...(goal ? { goal } : {}) };
    },
    // goal kinds: a friend's sync can change the standings any time; a gentle poll while the week is open
    refetchInterval: (query) => (query.state.data?.goal?.current && windowState(Date.now(), query.state.data.goal.current.window_open_at, query.state.data.goal.current.deadline_at) === 'open' ? 60_000 : false),
  });
}

// ---------- place schedule (place picker) ----------

export interface PlaceSchedule {
  /** my place history for this pact */
  places: PactParticipantPlaceRow[];
  nextInstance: PactInstanceRow | null;
  /** the place that applies to nextInstance's window */
  nextPlace: PactParticipantPlaceRow | null;
  /** most recently saved place (may not apply yet) */
  latestSaved: PactParticipantPlaceRow | null;
}

function usePlaceScheduleReal(pactId: string, userId: string, enabled = true) {
  return useQuery({
    queryKey: [...queryKeys.pact(pactId), 'places', userId] as const,
    enabled,
    queryFn: async (): Promise<PlaceSchedule> => {
      const now = Date.now();
      const [places, upcoming] = await Promise.all([
        supabase
          .from('pact_participant_places')
          .select('*')
          .eq('pact_id', pactId)
          .eq('user_id', userId)
          .order('effective_from')
          .then(must),
        supabase
          .from('pact_instances')
          .select('*')
          .eq('pact_id', pactId)
          .gt('window_open_at', new Date(now).toISOString())
          .neq('status', 'voided')
          .order('window_open_at')
          .limit(5)
          .then(must),
      ]);
      const nextInstance = nextWindow(upcoming, now);
      const latestSaved =
        places.reduce<PactParticipantPlaceRow | null>(
          (a, p) => (a === null || Date.parse(p.created_at) > Date.parse(a.created_at) ? p : a),
          null,
        );
      return {
        places,
        nextInstance,
        nextPlace: nextInstance ? effectivePlaceAt(places, nextInstance.window_open_at) : null,
        latestSaved,
      };
    },
  });
}

// ---------- single instance (check-in screen) ----------

export interface InstanceDetail {
  instance: PactInstanceRow;
  pact: PactRow;
  /** my participant row (null = not in this pact) */
  myPlace: PactParticipantRow | null;
  /** the place this instance's check-ins are judged against (may differ from a newly saved one) */
  judgedPlace: WindowPlace | null;
  myCheckins: CheckinRow[];
  myResult: ResultRow | null;
  myFreeze: FreezeRow | null;
  /** everyone's posted result for this day (empty until the gate closes); the roster once closed */
  results: ResultRow[];
  /** names for the people in `results` */
  profiles: Map<string, ProfileRow>;
  /** what this day did to each member's ledger, from `instance_member_nets` (empty = no pledge moved) */
  nets: InstanceMemberNetRow[];
}

async function fetchInstanceNets(instanceId: string): Promise<InstanceMemberNetRow[]> {
  return must(await supabase.from('instance_member_nets').select('*').eq('instance_id', instanceId));
}

/** The ledger effect of one closed day, for the group home's compact gate-close line. */
function useInstanceNetsReal(instanceId: string, enabled = true) {
  return useQuery({
    queryKey: [...queryKeys.instance(instanceId), 'nets'],
    enabled,
    queryFn: () => fetchInstanceNets(instanceId),
    staleTime: 60_000,
  });
}

function useInstanceDetailReal(instanceId: string, userId: string) {
  return useQuery({
    queryKey: queryKeys.instance(instanceId),
    refetchInterval: (query) => gateClosePollInterval(query.state.data, Date.now()),
    queryFn: async (): Promise<InstanceDetail> => {
      const instance = await supabase.from('pact_instances').select('*').eq('id', instanceId).single().then(must);
      const [pact, places, history, myCheckins, results, freezes, nets] = await Promise.all([
        supabase.from('pacts').select('*').eq('id', instance.pact_id).single().then(must),
        supabase
          .from('pact_participants')
          .select('*')
          .eq('pact_id', instance.pact_id)
          .eq('user_id', userId)
          .is('left_at', null)
          .then(must),
        supabase
          .from('pact_participant_places')
          .select('*')
          .eq('pact_id', instance.pact_id)
          .eq('user_id', userId)
          .then(must),
        supabase
          .from('checkins')
          .select('*')
          .eq('instance_id', instanceId)
          .eq('user_id', userId)
          .order('server_received_at')
          .then(must),
        supabase.from('results').select('*').eq('instance_id', instanceId).then(must),
        supabase.from('freezes').select('*').eq('instance_id', instanceId).eq('user_id', userId).then(must),
        fetchInstanceNets(instanceId),
      ]);
      const profiles = await fetchProfiles(results.map((r) => r.user_id));
      return {
        instance,
        pact,
        myPlace: places[0] ?? null,
        judgedPlace: places[0] ? placeForWindow(history, instance.window_open_at, places[0]) : null,
        myCheckins,
        myResult: results.find((r) => r.user_id === userId) ?? null,
        myFreeze: freezes[0] ?? null,
        results,
        profiles,
        nets,
      };
    },
  });
}

// ---------- feed ----------

export interface ReviewWithVotes {
  review: ReviewRow;
  votes: ReviewVoteRow[];
}

export interface FeedItem {
  result: ResultRow;
  instance: PactInstanceRow;
  pact: PactRow;
  reviews: ReviewWithVotes[];
}

export interface Feed {
  items: FeedItem[];
  profiles: Map<string, ProfileRow>;
  /** roster per instance (users with a result row): who may challenge and vote, as the server checks */
  rosterByInstance: Map<string, string[]>;
  /** place set / confirmed / objected / now-counts rows of the last FEED_DAYS, newest first */
  placeEvents: PlaceEventRow[];
  pacts: PactRow[];
  /** today's state of every place row the events point at (actions come from here) */
  placesById: Map<string, PactPlaceVisibleRow>;
}

export const FEED_DAYS = 28;

function useFeedReal(groupId: string) {
  return useQuery({
    queryKey: queryKeys.feed(groupId),
    queryFn: async (): Promise<Feed> => {
      const now = Date.now();
      const [pacts, members] = await Promise.all([
        supabase.from('pacts').select('*').eq('group_id', groupId).then(must),
        supabase.from('group_members').select('user_id').eq('group_id', groupId).then(must),
      ]);
      const profiles = await fetchProfiles(members.map((m) => m.user_id));
      const empty: Feed = {
        items: [],
        profiles,
        rosterByInstance: new Map(),
        placeEvents: [],
        pacts,
        placesById: new Map(),
      };
      if (pacts.length === 0) return empty;
      const pactIds = pacts.map((p) => p.id);
      const since = new Date(now - FEED_DAYS * 86_400_000).toISOString();
      const [instances, placeEvents, places] = await Promise.all([
        supabase
          .from('pact_instances')
          .select('*')
          .in('pact_id', pactIds)
          .gte('deadline_at', since)
          .in('status', ['closed', 'settled', 'voided'])
          .then(must),
        supabase
          .from('place_events')
          .select('*')
          .eq('group_id', groupId)
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(200)
          .then(must),
        supabase.from('pact_places_visible').select('*').in('pact_id', pactIds).then(must),
      ]);
      empty.placeEvents = placeEvents;
      empty.placesById = new Map(places.map((p) => [p.place_id, p]));
      const instanceIds = instances.map((i) => i.id);
      if (instanceIds.length === 0) return empty;
      const [results, reviews] = await Promise.all([
        supabase.from('results').select('*').in('instance_id', instanceIds).neq('status', 'pending').then(must),
        supabase.from('reviews').select('*').in('instance_id', instanceIds).order('opened_at').then(must),
      ]);
      const votes =
        reviews.length === 0
          ? []
          : must(await supabase.from('review_votes').select('*').in('review_id', reviews.map((r) => r.id)));

      const items: FeedItem[] = results.map((result) => {
        const instance = instances.find((i) => i.id === result.instance_id)!;
        const pact = pacts.find((p) => p.id === instance.pact_id)!;
        return {
          result,
          instance,
          pact,
          reviews: reviews
            .filter((r) => r.instance_id === result.instance_id && r.subject_user_id === result.user_id)
            .map((review) => ({ review, votes: votes.filter((v) => v.review_id === review.id) })),
        };
      });
      items.sort(
        (a, b) =>
          Date.parse(b.instance.deadline_at) - Date.parse(a.instance.deadline_at) ||
          a.result.user_id.localeCompare(b.result.user_id),
      );

      const rosterByInstance = new Map<string, string[]>();
      for (const r of results) {
        rosterByInstance.set(r.instance_id, [...(rosterByInstance.get(r.instance_id) ?? []), r.user_id]);
      }
      return { ...empty, items, rosterByInstance };
    },
  });
}

// ---------- unverified budget ----------

/** First day of the calendar month of a pact-local date ('2030-01-09' -> '2030-01-01'). */
export const monthOf = (localDate: string): string => `${localDate.slice(0, 7)}-01`;

/**
 * How many of this person's days in this pact are unverified this calendar month (pact zone), from
 * the `unverified_month_counts` view (CONTRACT.md). The third opens an automatic group vote, so the
 * check-in screen shows the count from the first one (features/checkin/copy.ts#budgetLine). 0 while
 * loading or on error: the line is a courtesy, never a gate.
 */
function useUnverifiedBudgetReal(pactId: string, userId: string, localDate: string): number {
  const month = monthOf(localDate);
  const query = useQuery({
    queryKey: ['unverified-budget', pactId, userId, month],
    enabled: !!pactId && !!userId,
    staleTime: 60_000,
    queryFn: async (): Promise<number> => {
      const { data, error } = await supabase
        .from('unverified_month_counts')
        .select('count')
        .eq('pact_id', pactId)
        .eq('user_id', userId)
        .eq('month', month)
        .maybeSingle();
      if (error) throw error;
      return typeof data?.count === 'number' ? data.count : 0;
    },
  });
  return query.data ?? 0;
}

// ---------- ledger ----------

export interface Ledger {
  /** live member_balances: includes closed-but-unsettled days, so it can differ from what's owed now */
  balances: MemberBalanceRow[];
  /** most recent settlement run, if any */
  latestSettlement: SettlementRow | null;
  /** settlements referenced by `obligations` plus the latest one */
  settlements: SettlementRow[];
  /**
   * Open obligations (pending or marked_paid) from every settlement, not just the latest:
   * settlement supersedes only pending ones, so marked_paid ones persist until confirmed or disputed.
   */
  obligations: ObligationRow[];
  profiles: Map<string, ProfileRow>;
}

function useLedgerReal(groupId: string) {
  return useQuery({
    queryKey: queryKeys.ledger(groupId),
    queryFn: async (): Promise<Ledger> => {
      const [balances, latest, obligations, members] = await Promise.all([
        supabase.from('member_balances').select('*').eq('group_id', groupId).then(must),
        supabase
          .from('settlements')
          .select('*')
          .eq('group_id', groupId)
          .order('week_start', { ascending: false })
          .limit(1)
          .then(must),
        supabase
          .from('obligations')
          .select('*')
          .eq('group_id', groupId)
          .in('status', [...OPEN_OBLIGATION_STATUSES])
          .order('amount_cents', { ascending: false })
          .then(must),
        supabase.from('group_members').select('user_id').eq('group_id', groupId).then(must),
      ]);
      const latestSettlement = latest[0] ?? null;
      const missing = uniq(obligations.map((o) => o.settlement_id)).filter((id) => id !== latestSettlement?.id);
      const older =
        missing.length === 0 ? [] : must(await supabase.from('settlements').select('*').in('id', missing));
      const profiles = await fetchProfiles([
        ...members.map((m) => m.user_id),
        ...balances.map((b) => b.user_id),
        ...obligations.flatMap((o) => [o.from_user, o.to_user]),
      ]);
      return {
        balances: [...balances].sort((a, b) => b.balance_cents - a.balance_cents),
        latestSettlement,
        settlements: latestSettlement ? [latestSettlement, ...older] : older,
        obligations,
        profiles,
      };
    },
  });
}

// ---------- shared mutation helper ----------

export function useRpcMutation<TVars, TResult>(
  fn: (vars: TVars) => Promise<TResult>,
  invalidate: (vars: TVars, result: TResult) => QueryKey[],
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result, vars) => {
      await Promise.all(invalidate(vars, result).map((queryKey) => qc.invalidateQueries({ queryKey })));
    },
  });
}


// ---------- demo-mode switch ----------
// With EXPO_PUBLIC_DEMO=1 every hook resolves against in-memory fixtures (see ./demo). The real
// implementations above are untouched; the switch is a module constant, so hook order is stable.

export const useProfile = DEMO ? demo.useProfile : useProfileReal;
export const useUpdateProfile = DEMO ? demo.useUpdateProfile : useUpdateProfileReal;
export const useMyGroups = DEMO ? demo.useMyGroups : useMyGroupsReal;
export const useGroupHome = DEMO ? demo.useGroupHome : useGroupHomeReal;
export const usePactDetail = DEMO ? demo.usePactDetail : usePactDetailReal;
export const usePlaceSchedule = DEMO ? demo.usePlaceSchedule : usePlaceScheduleReal;
export const useInstanceDetail = DEMO ? demo.useInstanceDetail : useInstanceDetailReal;
export const useInstanceNets = DEMO ? demo.useInstanceNets : useInstanceNetsReal;
export const useFeed = DEMO ? demo.useFeed : useFeedReal;
export const useLedger = DEMO ? demo.useLedger : useLedgerReal;
export const useUnverifiedBudget = DEMO ? demo.useUnverifiedBudget : useUnverifiedBudgetReal;

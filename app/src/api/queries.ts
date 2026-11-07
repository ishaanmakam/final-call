import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { summarizeInstance, type InstanceSummary, type MemberDayState } from '../lib/instanceStatus';
import { localDateInZone, windowState } from '../lib/time';
import { supabase } from './supabase';
import type {
  CheckinRow,
  FreezeRow,
  GroupMemberRow,
  GroupRow,
  MemberBalanceRow,
  ObligationRow,
  PactInstanceRow,
  PactParticipantRow,
  PactRow,
  ProfileRow,
  ResultRow,
  ReviewRow,
  ReviewVoteRow,
  SettlementRow,
} from './types';

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
function must<T>(res: { data: T | null; error: { message: string } | null }): NonNullable<T> {
  if (res.error) throw new Error(res.error.message);
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

export function useProfile(userId: string) {
  return useQuery({
    queryKey: queryKeys.profile(userId),
    queryFn: async () => await supabase.from('profiles').select('*').eq('id', userId).single().then(must),
  });
}

export function useUpdateProfile(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: { display_name?: string; venmo_username?: string | null }) => {
      const { error } = await supabase.from('profiles').update(patch).eq('id', userId);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.profile(userId) }),
  });
}

// ---------- my groups ----------

export interface MyGroup {
  group: GroupRow;
  role: GroupMemberRow['role'];
  memberCount: number;
}

export function useMyGroups(userId: string) {
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

export interface TodayItem {
  instance: PactInstanceRow;
  pact: PactRow;
  participantIds: string[];
  summary: InstanceSummary;
  myState: MemberDayState | null;
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

export function useGroupHome(groupId: string, userId: string) {
  return useQuery({
    queryKey: queryKeys.groupHome(groupId),
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
      const todayByPact = new Map(pacts.map((p) => [p.id, localDateInZone(now, p.tz)]));
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
      const [checkins, results] =
        instanceIds.length === 0
          ? [[], []]
          : await Promise.all([
              supabase
                .from('checkins')
                .select('instance_id,user_id,verdict,server_received_at')
                .in('instance_id', instanceIds)
                .then(must),
              supabase.from('results').select('*').in('instance_id', instanceIds).then(must),
            ]);
      const today: TodayItem[] = todays
        .map((instance) => {
          const pact = pacts.find((p) => p.id === instance.pact_id)!;
          const participantIds = participants.filter((p) => p.pact_id === pact.id).map((p) => p.user_id);
          const summary = summarizeInstance({
            participantIds,
            deadlineAt: instance.deadline_at,
            checkins: checkins.filter((c) => c.instance_id === instance.id),
            results: results.filter((r) => r.instance_id === instance.id),
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

export interface PactDetail {
  pact: PactRow;
  participants: PactParticipantRow[];
  profiles: Map<string, ProfileRow>;
  upcoming: PactInstanceRow[];
  myFreezes: FreezeRow[];
}

export function usePactDetail(pactId: string, userId: string) {
  return useQuery({
    queryKey: queryKeys.pact(pactId),
    queryFn: async (): Promise<PactDetail> => {
      const since = new Date(Date.now() - 86_400_000).toISOString();
      const [pact, participants, upcoming, myFreezes] = await Promise.all([
        supabase.from('pacts').select('*').eq('id', pactId).single().then(must),
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
      ]);
      const profiles = await fetchProfiles(participants.map((p) => p.user_id));
      return { pact, participants, profiles, upcoming, myFreezes };
    },
  });
}

// ---------- single instance (check-in screen) ----------

export interface InstanceDetail {
  instance: PactInstanceRow;
  pact: PactRow;
  myPlace: PactParticipantRow | null;
  myCheckins: CheckinRow[];
  myResult: ResultRow | null;
  myFreeze: FreezeRow | null;
}

export function useInstanceDetail(instanceId: string, userId: string) {
  return useQuery({
    queryKey: queryKeys.instance(instanceId),
    queryFn: async (): Promise<InstanceDetail> => {
      const instance = await supabase.from('pact_instances').select('*').eq('id', instanceId).single().then(must);
      const [pact, places, myCheckins, results, freezes] = await Promise.all([
        supabase.from('pacts').select('*').eq('id', instance.pact_id).single().then(must),
        supabase
          .from('pact_participants')
          .select('*')
          .eq('pact_id', instance.pact_id)
          .eq('user_id', userId)
          .is('left_at', null)
          .then(must),
        supabase
          .from('checkins')
          .select('*')
          .eq('instance_id', instanceId)
          .eq('user_id', userId)
          .order('server_received_at')
          .then(must),
        supabase.from('results').select('*').eq('instance_id', instanceId).eq('user_id', userId).then(must),
        supabase.from('freezes').select('*').eq('instance_id', instanceId).eq('user_id', userId).then(must),
      ]);
      return {
        instance,
        pact,
        myPlace: places[0] ?? null,
        myCheckins,
        myResult: results[0] ?? null,
        myFreeze: freezes[0] ?? null,
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
  /** participant ids per pact, to know who may vote */
  participantsByPact: Map<string, string[]>;
  /** Excluded results this calendar month per user: visible so it can't be farmed quietly. */
  excludedThisMonth: Map<string, number>;
}

export const FEED_DAYS = 28;

export function useFeed(groupId: string) {
  return useQuery({
    queryKey: queryKeys.feed(groupId),
    queryFn: async (): Promise<Feed> => {
      const now = Date.now();
      const [pacts, members] = await Promise.all([
        supabase.from('pacts').select('*').eq('group_id', groupId).then(must),
        supabase.from('group_members').select('user_id').eq('group_id', groupId).then(must),
      ]);
      const profiles = await fetchProfiles(members.map((m) => m.user_id));
      const empty: Feed = { items: [], profiles, participantsByPact: new Map(), excludedThisMonth: new Map() };
      if (pacts.length === 0) return empty;
      const pactIds = pacts.map((p) => p.id);
      const since = new Date(now - FEED_DAYS * 86_400_000).toISOString();
      const [instances, participants] = await Promise.all([
        supabase
          .from('pact_instances')
          .select('*')
          .in('pact_id', pactIds)
          .gte('deadline_at', since)
          .in('status', ['closed', 'settled', 'voided'])
          .then(must),
        supabase.from('pact_participants').select('pact_id,user_id').in('pact_id', pactIds).is('left_at', null).then(must),
      ]);
      const participantsByPact = new Map<string, string[]>();
      for (const p of participants) {
        participantsByPact.set(p.pact_id, [...(participantsByPact.get(p.pact_id) ?? []), p.user_id]);
      }
      const instanceIds = instances.map((i) => i.id);
      if (instanceIds.length === 0) return { ...empty, participantsByPact };
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

      const monthPrefix = new Date(now).toISOString().slice(0, 7);
      const excludedThisMonth = new Map<string, number>();
      for (const item of items) {
        if (item.result.status === 'excluded' && item.instance.local_date.startsWith(monthPrefix)) {
          excludedThisMonth.set(item.result.user_id, (excludedThisMonth.get(item.result.user_id) ?? 0) + 1);
        }
      }
      return { items, profiles, participantsByPact, excludedThisMonth };
    },
  });
}

// ---------- ledger ----------

export interface Ledger {
  balances: MemberBalanceRow[];
  settlement: SettlementRow | null;
  obligations: ObligationRow[];
  profiles: Map<string, ProfileRow>;
}

export function useLedger(groupId: string) {
  return useQuery({
    queryKey: queryKeys.ledger(groupId),
    queryFn: async (): Promise<Ledger> => {
      const [balances, settlements, members] = await Promise.all([
        supabase.from('member_balances').select('*').eq('group_id', groupId).then(must),
        supabase
          .from('settlements')
          .select('*')
          .eq('group_id', groupId)
          .order('week_start', { ascending: false })
          .limit(1)
          .then(must),
        supabase.from('group_members').select('user_id').eq('group_id', groupId).then(must),
      ]);
      const settlement = settlements[0] ?? null;
      const obligations = settlement
        ? must(
            await supabase
              .from('obligations')
              .select('*')
              .eq('settlement_id', settlement.id)
              .neq('status', 'superseded')
              .order('amount_cents', { ascending: false }),
          )
        : [];
      const profiles = await fetchProfiles([
        ...members.map((m) => m.user_id),
        ...balances.map((b) => b.user_id),
      ]);
      return {
        balances: [...balances].sort((a, b) => b.balance_cents - a.balance_cents),
        settlement,
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


/**
 * Read models for the Stats screen and the pact's Season group: `group_settlement_stats`,
 * `pact_season_recaps` and `pact_streaks` (CONTRACT.md "Seasons and stats"). Kept apart from
 * queries.ts so the two can change independently; demo mode resolves the same shapes from fixtures.
 */
import { useQuery, type QueryKey } from '@tanstack/react-query';
import { DbError } from '../lib/errors';
import * as demo from './demo';
import { DEMO } from './demo/settings';
import { supabase } from './supabase';
import type {
  GroupMemberRow,
  GroupSettlementStatsRow,
  PactRow,
  PactSeasonRecapRow,
  PactStreakRow,
  ProfileRow,
} from './types';

export const statsKeys = {
  /** under ['group', groupId] so the group's existing invalidations refresh it too */
  group: (groupId: string) => ['group', groupId, 'stats'] as const,
  /** under ['pact', pactId] for the same reason */
  pact: (pactId: string) => ['pact', pactId, 'stats'] as const,
};

/** Keys to invalidate after `set_pact_season`: the pact (detail + stats) and its group (home + stats). */
export const seasonInvalidationKeys = (pactId: string, groupId: string): QueryKey[] => [['pact', pactId], ['group', groupId]];

function must<T>(res: { data: T | null; error: { message: string; code?: string } | null }): NonNullable<T> {
  if (res.error) throw new DbError(res.error);
  if (res.data === null || res.data === undefined) throw new Error('No data returned');
  return res.data as NonNullable<T>;
}

export interface GroupStats {
  /** null only if the group row is invisible (not a member) */
  stats: GroupSettlementStatsRow | null;
  pacts: PactRow[];
  members: GroupMemberRow[];
  profiles: Map<string, ProfileRow>;
  /** every member's recap for every pact with a season (empty rows do not exist: no closed day, no row) */
  recaps: PactSeasonRecapRow[];
  streaks: PactStreakRow[];
  /** at least one closed or settled day across the group's pacts */
  hasClosedDays: boolean;
}

function useGroupStatsReal(groupId: string) {
  return useQuery({
    queryKey: statsKeys.group(groupId),
    staleTime: 30_000,
    queryFn: async (): Promise<GroupStats> => {
      const [statsRows, pacts, members] = await Promise.all([
        supabase.from('group_settlement_stats').select('*').eq('group_id', groupId).then(must),
        supabase.from('pacts').select('*').eq('group_id', groupId).order('created_at').then(must),
        supabase.from('group_members').select('*').eq('group_id', groupId).is('left_at', null).then(must),
      ]);
      const pactIds = pacts.map((p) => p.id);
      const [profileRows, recaps, streaks, closed] =
        pactIds.length === 0
          ? [[], [], [], []]
          : await Promise.all([
              supabase.from('profiles').select('*').in('id', [...new Set(members.map((m) => m.user_id))]).then(must),
              supabase.from('pact_season_recaps').select('*').in('pact_id', pactIds).then(must),
              supabase.from('pact_streaks').select('*').in('pact_id', pactIds).then(must),
              supabase.from('pact_instances').select('id').in('pact_id', pactIds).in('status', ['closed', 'settled']).limit(1).then(must),
            ]);
      return {
        stats: statsRows[0] ?? null,
        pacts,
        members,
        profiles: new Map(profileRows.map((p) => [p.id, p])),
        recaps,
        streaks,
        hasClosedDays: closed.length > 0,
      };
    },
  });
}

export interface PactStats {
  streaks: PactStreakRow[];
  recaps: PactSeasonRecapRow[];
}

function usePactStatsReal(pactId: string, enabled = true) {
  return useQuery({
    queryKey: statsKeys.pact(pactId),
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<PactStats> => {
      const [streaks, recaps] = await Promise.all([
        supabase.from('pact_streaks').select('*').eq('pact_id', pactId).then(must),
        supabase.from('pact_season_recaps').select('*').eq('pact_id', pactId).then(must),
      ]);
      return { streaks, recaps };
    },
  });
}

export const useGroupStats = DEMO ? demo.useGroupStats : useGroupStatsReal;
export const usePactStats = DEMO ? demo.usePactStats : usePactStatsReal;

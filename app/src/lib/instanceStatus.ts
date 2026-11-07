import type { CheckinVerdict, ResultStatus } from '../api/types';

export type MemberDayState =
  | Exclude<ResultStatus, 'pending'>
  | 'checked_in'
  | 'late'
  | 'unjudged'
  | 'out_of_fence'
  | 'waiting';

export interface InstanceSummaryInput {
  participantIds: string[];
  deadlineAt: string;
  checkins: Array<{ user_id: string; verdict: CheckinVerdict; server_received_at: string }>;
  results: Array<{ user_id: string; status: ResultStatus }>;
}

export interface InstanceSummary {
  total: number;
  checkedIn: number;
  byUser: Record<string, MemberDayState>;
  label: string;
}

const NOT_COUNTED: ReadonlySet<MemberDayState> = new Set(['frozen', 'void', 'excluded']);

function liveState(userId: string, deadlineMs: number, checkins: InstanceSummaryInput['checkins']): MemberDayState {
  const mine = checkins.filter((c) => c.user_id === userId);
  if (mine.length === 0) return 'waiting';
  const onTime = mine.filter((c) => Date.parse(c.server_received_at) <= deadlineMs);
  if (onTime.some((c) => c.verdict === 'in_fence')) return 'checked_in';
  if (mine.some((c) => c.verdict === 'in_fence')) return 'late';
  if (mine.some((c) => c.verdict === 'unjudgeable')) return 'unjudged';
  return 'out_of_fence';
}

export function summarizeInstance(input: InstanceSummaryInput): InstanceSummary {
  const deadlineMs = Date.parse(input.deadlineAt);
  const resultByUser = new Map(input.results.map((r) => [r.user_id, r.status] as const));
  const byUser: Record<string, MemberDayState> = {};
  let total = 0;
  let checkedIn = 0;
  for (const userId of input.participantIds) {
    const posted = resultByUser.get(userId);
    const state: MemberDayState =
      posted && posted !== 'pending' ? posted : liveState(userId, deadlineMs, input.checkins);
    byUser[userId] = state;
    if (NOT_COUNTED.has(state)) continue;
    total += 1;
    if (state === 'success' || state === 'checked_in') checkedIn += 1;
  }
  return { total, checkedIn, byUser, label: `${checkedIn} of ${total} checked in` };
}

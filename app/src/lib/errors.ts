export type RpcErrorKind = 'network' | 'auth' | 'rejected';

export interface RpcErrorLike {
  status?: number;
  code?: string;
  message?: string;
}

const NETWORK_STATUSES = new Set([0, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const NETWORK_MESSAGE = /network request failed|failed to fetch|fetch failed|network error|timed? ?out|aborterror|aborted|offline|internet connection/i;
const AUTH_CODES = new Set(['PGRST301', 'PGRST302', 'PGRST303']);

export function classifyRpcError(error: unknown): RpcErrorKind {
  const e = (typeof error === 'object' && error !== null ? error : {}) as RpcErrorLike;
  const message = typeof e.message === 'string' ? e.message : String(error);
  const status = typeof e.status === 'number' ? e.status : undefined;
  if (status !== undefined && NETWORK_STATUSES.has(status)) return 'network';
  if (status === 401 || (e.code && AUTH_CODES.has(e.code))) return 'auth';
  if (status === undefined && NETWORK_MESSAGE.test(message)) return 'network';
  return 'rejected';
}

export const CHECKIN_CAP_MESSAGE = "You've already checked in enough times for today.";
const GENERIC_MESSAGE = 'Something went wrong.';

/** Server says the per-instance check-in cap (20) is reached. Matches wording, not the window rules. */
const CHECKIN_CAP = /check-?ins?\b.*\b(limit|cap|at most|maximum|max)\b|\b(at most|max(imum)?|too many|limit of)\b.*check-?ins?/i;

/**
 * Copy for an error shown to the user. Rule violations (23514, P0001, ...) carry a readable server
 * message, which is shown as is (e.g. "can't leave during an active window"); known ones get friendlier copy.
 */
export function userMessage(error: unknown): string {
  if (error === null || error === undefined) return GENERIC_MESSAGE;
  const message = (
    typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message ?? '') : errorMessage(error)
  ).trim();
  if (message.length === 0) return GENERIC_MESSAGE;
  if (CHECKIN_CAP.test(message)) return CHECKIN_CAP_MESSAGE;
  return message;
}

export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const m = (error as { message: unknown }).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  return String(error);
}

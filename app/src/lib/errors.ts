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
const NETWORK_COPY = "No connection, or the server didn't answer. Try again.";
const AUTH_COPY = 'Your session expired. Sign in again.';

/** Server says the per-instance check-in cap (20) is reached. Matches wording, not the window rules. */
const CHECKIN_CAP = /check-?ins?\b.*\b(limit|cap|at most|maximum|max)\b|\b(at most|max(imum)?|too many|limit of)\b.*check-?ins?/i;

type Rule = readonly [pattern: RegExp, copy: string | ((m: RegExpExecArray) => string)];

/**
 * Copy for every SQLSTATE the migrations raise (and the PostgREST check/unique errors the client can hit).
 * Known messages get specific copy; anything else falls back per code. Raw database text is never shown,
 * because it can contain column names and code words (stake, instance) that the UI doesn't use.
 */
const RULES: Record<string, readonly Rule[]> = {
  '28000': [[/./, "You're signed out. Sign in again."]],
  '42501': [
    [/not a member of this group/i, "You're not a member of this group."],
    [
      /not a participant of this pact instance/i,
      "You're not counted for this day. Only people who joined before its window opened take part.",
    ],
    [/not an eligible voter/i, "You can't vote on this review."],
    [/group owner or the pact creator/i, 'Only the group owner or the person who created this pact can pause or resume it.'],
    [/only the payee can confirm/i, 'Only the person being paid can confirm this.'],
    [/only the payee can dispute/i, 'Only the person being paid can say it was not received.'],
    [/only the payer can mark/i, 'Only the person paying can mark this paid.'],
    [/only the subject can appeal/i, 'You can only appeal your own result.'],
    [/cannot challenge your own/i, "You can't challenge your own result."],
    [/./, "You don't have permission to do that."],
  ],
  P0002: [
    [/invalid invite code/i, "That invite code doesn't match any group."],
    [/instance(?: \S+)? not found/i, 'That day no longer exists. Pull to refresh.'],
    [/pact not found/i, 'That pact no longer exists. Pull to refresh.'],
    [/obligation not found/i, 'That payment no longer exists. Pull to refresh.'],
    [/review not found/i, 'That review no longer exists. Pull to refresh.'],
    [/subject has no result/i, 'There is no result to review for that person yet.'],
    [/./, "That couldn't be found. Pull to refresh."],
  ],
  PGRST116: [[/./, "That couldn't be found. Pull to refresh."]],
  '22023': [
    [/client_captured_at is more than/i, "Your phone's clock looks wrong. Set Date & Time to automatic and try again."],
    [/days_of_week/i, 'Pick at least one day.'],
    [/group name/i, 'Group name must be 1 to 80 characters.'],
    [/invalid time zone/i, "That time zone isn't recognized. Use a name like America/Chicago."],
    [/late check-ins are accepted only/i, 'That check-in arrived more than 24 hours after the deadline, so it cannot count.'],
    [/\b(place_)?(lat|lng) must be/i, "That location isn't valid. Capture it again."],
    [/pact title/i, 'Pact title must be 1 to 80 characters.'],
    [/place label/i, 'Place name must be at most 80 characters.'],
    [/radius/i, 'The circle must be between 25 and 500 m.'],
    [/platform must|push token/i, "This device couldn't be registered for notifications."],
    [/reason and photo/i, 'Keep the reason under 500 characters.'],
    [/stake must be between/i, 'Pledge must be between $0.01 and $100.00.'],
    [/window open time must be before|deadline is required/i, 'The window must open before the deadline on the same day.'],
    [/./, "Something in that request isn't valid. Check it and try again."],
  ],
  '23514': [
    [CHECKIN_CAP, CHECKIN_CAP_MESSAGE],
    [/freeze must be declared before/i, 'Freezes must be set before the window opens.'],
    [/freeze already used/i, "You've already used this week's freeze for this pact."],
    [/review of this result is already open/i, 'There is already an open review for this result.'],
    [/check-in window has not opened/i, "The check-in window hasn't opened yet."],
    [/check-in window is closed/i, 'The check-in window is closed.'],
    [/group is full/i, 'That group is full (8 members max).'],
    [/instance was cancelled/i, 'This day was cancelled because the pact is paused.'],
    [/obligation is already confirmed/i, 'This payment is already confirmed.'],
    [/obligation is superseded/i, 'This payment was replaced by a newer settle-up. Pull to refresh.'],
    [/only a failed result can be appealed/i, 'Only a missed day can be appealed.'],
    [/only a success or unverified/i, 'Only a showed-up or unverified result can be challenged.'],
    [/only closed, unsettled/i, "This day can't be reviewed: it hasn't closed yet or is already settled."],
    [/review is already resolved/i, 'Voting on this review has closed.'],
    [/already had its (appeal|challenge)/i, (m) => `This result has already had its ${m[1]!.toLowerCase()}.`],
    [/cannot leave while/i, "You can't leave while a check-in window you're part of is open or waiting for its result. Try again after it closes."],
    [/cannot join, rejoin or change your place/i, "You can't join or change your place while a check-in window is open. Try again after it closes."],
    [/venmo/i, 'Venmo usernames are 5 to 30 letters, numbers, - or _.'],
    [/display_name/i, 'Display name must be 1 to 50 characters.'],
    [/./, "That isn't allowed right now."],
  ],
  '23505': [[/./, "That's already been done."]],
  '55000': [[/./, "That record can't be changed once it's posted."]],
};

function errorFields(error: unknown): { message: string; code: string } {
  const message = (
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message ?? '')
      : errorMessage(error)
  ).trim();
  const rawCode = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return { message, code: typeof rawCode === 'string' ? rawCode : '' };
}

/**
 * Copy for an error shown to the user. Database/RPC errors (anything with a code) are mapped by SQLSTATE
 * and message; client-side errors without a code (form validation, GPS) are shown as written.
 */
export function userMessage(error: unknown): string {
  if (error === null || error === undefined) return GENERIC_MESSAGE;
  const { message, code } = errorFields(error);
  const kind = classifyRpcError(error);
  if (kind === 'network') return NETWORK_COPY;
  if (kind === 'auth') return AUTH_COPY;
  if (code) {
    const rules = RULES[code];
    if (!rules) return GENERIC_MESSAGE;
    for (const [pattern, copy] of rules) {
      const m = pattern.exec(message);
      if (m) return typeof copy === 'string' ? copy : copy(m);
    }
    return GENERIC_MESSAGE;
  }
  if (message.length === 0) return GENERIC_MESSAGE;
  if (CHECKIN_CAP.test(message)) return CHECKIN_CAP_MESSAGE;
  return message;
}

/** Error carrying the PostgREST/SQLSTATE code, so table reads get the same copy as RPCs. */
export class DbError extends Error {
  readonly code: string;
  constructor(error: { message: string; code?: string }) {
    super(error.message);
    this.name = 'DbError';
    this.code = error.code ?? '';
  }
}

export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const m = (error as { message: unknown }).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  return String(error);
}

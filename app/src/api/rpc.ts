import { attemptId, type CheckinAttempt, type SendOutcome } from '../lib/checkinQueue';
import { classifyRpcError, userMessage, type RpcErrorKind } from '../lib/errors';
import * as demo from './demo';
import { DEMO } from './demo/settings';
import { supabase } from './supabase';
import type { CheckinRow, ReviewKind, RpcArgs, RpcName, RpcReturn } from './types';

export class RpcError extends Error {
  readonly kind: RpcErrorKind;
  readonly status: number;
  readonly code: string;
  readonly rpc: RpcName;

  constructor(rpc: RpcName, error: { message: string; code?: string; details?: string }, status: number) {
    super(error.message);
    this.name = 'RpcError';
    this.rpc = rpc;
    this.status = status;
    this.code = error.code ?? '';
    this.kind = classifyRpcError({ status, code: this.code, message: error.message });
  }
}

export const isNetworkError = (e: unknown): boolean => e instanceof RpcError && e.kind === 'network';

type RpcCaller = <N extends RpcName>(
  name: N,
  args: RpcArgs<N>,
) => {
  abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null; status: number }>;
} & PromiseLike<{ data: unknown; error: { message: string; code?: string } | null; status: number }>;

const rpc = supabase.rpc.bind(supabase) as unknown as RpcCaller;

async function call<N extends RpcName>(name: N, args: RpcArgs<N>, timeoutMs?: number): Promise<RpcReturn<N>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const builder = rpc(name, args);
    let request: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null; status: number }> = builder;
    if (timeoutMs !== undefined) {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);
      request = builder.abortSignal(controller.signal);
    }
    const { data, error, status } = await request;
    if (error) throw new RpcError(name, error, status);
    return data as RpcReturn<N>;
  } catch (e) {
    if (e instanceof RpcError) throw e;
    // fetch threw instead of resolving with an error object: treat as transport failure
    throw new RpcError(name, { message: e instanceof Error ? e.message : String(e) }, 0);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const createGroupReal = (name: string, settlementTz: string) =>
  call('create_group', { p_name: name, p_settlement_tz: settlementTz });

const joinGroupReal = (inviteCode: string) => call('join_group', { p_invite_code: inviteCode.trim() });

const leaveGroupReal = (groupId: string) => call('leave_group', { p_group: groupId });

export interface CreatePactInput {
  groupId: string;
  title: string;
  /** ISO weekdays 1=Mon..7=Sun */
  days: number[];
  /** 'HH:MM:SS' local to tz */
  windowOpen: string;
  deadline: string;
  stakeCents: number;
  tz: string;
}

const createPactReal = (p: CreatePactInput) =>
  call('create_pact', {
    p_group: p.groupId,
    p_title: p.title,
    p_days: p.days,
    p_window_open: p.windowOpen,
    p_deadline: p.deadline,
    p_stake_cents: p.stakeCents,
    p_tz: p.tz,
  });

export interface JoinPactInput {
  pactId: string;
  lat: number;
  lng: number;
  radiusM: number;
  label: string;
}

const joinPactReal = (p: JoinPactInput) =>
  call('join_pact', { p_pact: p.pactId, p_lat: p.lat, p_lng: p.lng, p_radius_m: p.radiusM, p_label: p.label });

const setPactPausedReal = (pactId: string, paused: boolean) =>
  call('set_pact_paused', { p_pact: pactId, p_paused: paused });

/** 15 s cap so a dead network at 8:59 falls through to the offline queue quickly. */
export const CHECK_IN_TIMEOUT_MS = 15_000;

const checkInReal = (a: CheckinAttempt): Promise<CheckinRow> =>
  call(
    'check_in',
    {
      p_instance: a.instanceId,
      p_lat: a.lat,
      p_lng: a.lng,
      p_accuracy_m: a.accuracyM,
      p_client_captured_at: a.clientCapturedAt,
      p_is_simulated: a.isSimulated,
      p_client_attempt_id: attemptId(a),
    },
    CHECK_IN_TIMEOUT_MS,
  );

/** Transport adapter for the offline queue. */
async function sendQueuedCheckinReal(a: CheckinAttempt): Promise<SendOutcome<CheckinRow>> {
  try {
    return { kind: 'ok', result: await checkIn(a) };
  } catch (e) {
    const err = e instanceof RpcError ? e : new RpcError('check_in', { message: String(e) }, 0);
    return err.kind === 'rejected' ? { kind: 'reject', error: userMessage(err) } : { kind: 'retry', error: err.message };
  }
}

const declareFreezeReal = (instanceId: string) => call('declare_freeze', { p_instance: instanceId });

export interface OpenReviewInput {
  instanceId: string;
  subjectUserId: string;
  kind: ReviewKind;
  reason: string;
  photoPath?: string | null;
}

const openReviewReal = (r: OpenReviewInput) =>
  call('open_review', {
    p_instance: r.instanceId,
    p_subject: r.subjectUserId,
    p_kind: r.kind,
    p_reason: r.reason,
    p_photo_path: r.photoPath ?? null,
  });

const castVoteReal = (reviewId: string, supports: boolean) =>
  call('cast_vote', { p_review: reviewId, p_supports: supports });

const markObligationPaidReal = (obligationId: string) =>
  call('mark_obligation_paid', { p_obligation: obligationId });

const confirmObligationReal = (obligationId: string) =>
  call('confirm_obligation', { p_obligation: obligationId });

const disputeObligationReal = (obligationId: string) =>
  call('dispute_obligation', { p_obligation: obligationId });

const registerPushTokenReal = (token: string, platform: string) =>
  call('register_push_token', { p_token: token, p_platform: platform });

/** Another member confirms a changed place; it counts from then (never before 12 h after the change). */
const acknowledgePlaceReal = (placeId: string) => call('acknowledge_place', { p_place: placeId });

/** Another member blocks a place set in the last 24 h; the owner must set a new one. */
const objectPlaceReal = (placeId: string, reason: string) =>
  call('object_place', { p_place: placeId, p_reason: reason.trim() });

/** Settings → Delete account. Refused (23514) while the caller is on an open check-in roster. */
const deleteMyAccountReal = () => call('delete_my_account', {});

/**
 * Start a season (`start` 'YYYY-MM-DD' in the pact's zone, 1..12 weeks) or end it (both null).
 * Owner or pact creator only (42501).
 */
const setPactSeasonReal = (pactId: string, start: string | null, weeks: number | null) =>
  call('set_pact_season', { p_pact: pactId, p_start: start, p_weeks: weeks });

// ---------- demo-mode switch ----------
// With EXPO_PUBLIC_DEMO=1 every RPC resolves against the in-memory fixtures (see ./demo).

export const createGroup = DEMO ? demo.createGroup : createGroupReal;
export const joinGroup = DEMO ? demo.joinGroup : joinGroupReal;
export const leaveGroup = DEMO ? demo.leaveGroup : leaveGroupReal;
export const createPact = DEMO ? demo.createPact : createPactReal;
export const joinPact = DEMO ? demo.joinPact : joinPactReal;
export const setPactPaused = DEMO ? demo.setPactPaused : setPactPausedReal;
export const checkIn = DEMO ? demo.checkIn : checkInReal;
export const sendQueuedCheckin = DEMO ? demo.sendQueuedCheckin : sendQueuedCheckinReal;
export const declareFreeze = DEMO ? demo.declareFreeze : declareFreezeReal;
export const openReview = DEMO ? demo.openReview : openReviewReal;
export const castVote = DEMO ? demo.castVote : castVoteReal;
export const markObligationPaid = DEMO ? demo.markObligationPaid : markObligationPaidReal;
export const confirmObligation = DEMO ? demo.confirmObligation : confirmObligationReal;
export const disputeObligation = DEMO ? demo.disputeObligation : disputeObligationReal;
export const registerPushToken = DEMO ? demo.registerPushToken : registerPushTokenReal;
export const acknowledgePlace = DEMO ? demo.acknowledgePlace : acknowledgePlaceReal;
export const objectPlace = DEMO ? demo.objectPlace : objectPlaceReal;
export const deleteMyAccount = DEMO ? demo.deleteMyAccount : deleteMyAccountReal;
export const setPactSeason = DEMO ? demo.setPactSeason : setPactSeasonReal;

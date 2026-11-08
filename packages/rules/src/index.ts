export type CheckinVerdict = "in_fence" | "out_of_fence" | "unjudgeable" | "rejected_simulated";
/** `excluded` is reserved: since RULES_VERSION 2 no rule produces it (history may still hold it). */
export type ResultStatus = "pending" | "success" | "failed" | "unverified" | "frozen" | "void" | "excluded";
export type ReviewKind = "appeal" | "challenge";
export type ReviewStatus = "open" | "accepted" | "rejected" | "defaulted";

/**
 * Bumped whenever a verdict, result, review, payout or settlement rule changes.
 * 1: launch rules. 2: a defaulted appeal leaves the original result standing (N3-1), was `excluded`.
 * 3: on a voided instance only success/failed become `void`; unverified (and frozen) stay on record
 *    (RT-2). The opener of a challenge is not one of its voters (RT-1; SQL `_review_voters`).
 * 4: challenge kinds (20261109000100): activity verdicts (`activityVerdict`), progress over accepted
 *    activities (`computeProgress`), goal results (`goalResult`; success / failed, never unverified,
 *    evidence submitted by deadline + 24 h), custom completions; `computeResults` takes a `kind`.
 */
export const RULES_VERSION = 4;

// ---------------------------------------------------------------------------------------------
// Challenge kinds
// ---------------------------------------------------------------------------------------------

export type PactKind = "show_up" | "distance" | "workouts" | "steps" | "custom";
export type PactPeriod = "daily" | "weekly" | "once";
export type ActivitySource = "healthkit" | "strava" | "manual";
export type ActivityVerdict = "accepted" | "rejected_manual" | "rejected_duplicate" | "rejected_type" | "rejected_future";

/** The workout types a pact can count. A daily step sample has the type `steps` (STEPS_ACTIVITY_TYPE). */
export const ACTIVITY_TYPES = ["running", "walking", "cycling", "swimming", "hiking", "rowing", "strength", "yoga", "other"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export const STEPS_ACTIVITY_TYPE = "steps";
/** A workout counts toward a `workouts` goal only from 10 minutes. */
export const MIN_WORKOUT_S = 600;
/** Evidence submitted later than this after the deadline is shown but never moves money (C0-2). */
export const LATE_EVIDENCE_MS = 24 * 60 * 60_000;
/** An activity may end this far in the future (clock skew) before it is `rejected_future`. */
export const FUTURE_SLACK_MS = 5 * 60_000;
/** Time overlap (share of the shorter activity) from which a second source is a duplicate. */
export const DUPLICATE_OVERLAP = 0.8;
/** Speed bounds per type (m/s); faster is `rejected_type` 'implausible pace'. */
export const MAX_SPEED_MPS: Readonly<Record<string, number>> = {
  running: 12,
  walking: 12,
  hiking: 12,
  swimming: 12,
  rowing: 12,
  cycling: 25,
};

export interface ActivityInput {
  source: ActivitySource;
  externalId: string;
  activityType: string;
  startedAt: string;
  endedAt: string;
  distanceM: number | null;
  /** null = elapsed seconds */
  durationS: number | null;
  steps: number | null;
  isManual: boolean;
}

export interface ActivityRecord extends ActivityInput {
  /** tie-breaker for equal start instants (SQL orders by started_at, id) */
  id?: string;
  userId: string;
  verdict: ActivityVerdict;
  /** when it reached the server; missing = counts for money */
  submittedAt?: string;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const durationS = (a: ActivityInput): number => (a.durationS === null ? Math.round((ms(a.endedAt) - ms(a.startedAt)) / 1000) : a.durationS);

/**
 * The verdict `submit_activities` gives one item, judged against the user's already accepted
 * activities (first accepted wins) at server time `now`. Order of the rules: unknown type, manual,
 * future, implausible pace, duplicate across sources (>= 80 % of the shorter one's time).
 */
export function activityVerdict(
  a: ActivityInput,
  previous: readonly ActivityRecord[],
  now: string,
): { verdict: ActivityVerdict; reason: string | null } {
  const start = ms(a.startedAt);
  const end = ms(a.endedAt);
  if (end <= start) throw new Error("ended_at must be after started_at");
  const type = a.activityType.trim().toLowerCase();
  if (type !== STEPS_ACTIVITY_TYPE && !(ACTIVITY_TYPES as readonly string[]).includes(type)) {
    return { verdict: "rejected_type", reason: "unknown activity type" };
  }
  if (a.isManual) return { verdict: "rejected_manual", reason: "entered by hand" };
  if (end > ms(now) + FUTURE_SLACK_MS) return { verdict: "rejected_future", reason: "ends in the future" };
  const limit = MAX_SPEED_MPS[type];
  if (limit !== undefined && a.distanceM !== null && a.distanceM / Math.max(durationS(a), 1) > limit) {
    return { verdict: "rejected_type", reason: "implausible pace" };
  }
  if (type !== STEPS_ACTIVITY_TYPE) {
    const dup = previous
      .filter((p) => p.verdict === "accepted" && p.source !== a.source && p.activityType !== STEPS_ACTIVITY_TYPE)
      .filter((p) => {
        const ps = ms(p.startedAt);
        const pe = ms(p.endedAt);
        if (!(ps < end && pe > start)) return false;
        const overlap = Math.min(pe, end) - Math.max(ps, start);
        return overlap >= DUPLICATE_OVERLAP * Math.min(pe - ps, end - start);
      })
      .sort((x, y) => ms(x.startedAt) - ms(y.startedAt) || cmp(x.id ?? "", y.id ?? ""))[0];
    if (dup) return { verdict: "rejected_duplicate", reason: `duplicate of ${dup.source} ${dup.externalId}` };
  }
  return { verdict: "accepted", reason: null };
}

/** Does an activity of this type belong to a pact of this kind? (SQL `activity_matches_pact`) */
export function activityMatchesPact(kind: PactKind, activityTypes: readonly string[], activityType: string): boolean {
  if (kind === "steps") return activityType === STEPS_ACTIVITY_TYPE;
  if (kind === "distance" || kind === "workouts") return activityTypes.includes(activityType);
  return false;
}

/** What one counted activity adds to the progress of a kind. */
export function activityAmount(kind: PactKind, a: ActivityInput): number {
  if (kind === "distance") return a.distanceM ?? 0;
  if (kind === "workouts") return 1;
  if (kind === "steps") return a.steps ?? 0;
  return 0;
}

export interface Progress {
  value: number;
  count: number;
  /** `endedAt` of the activity that first brought the running total to the goal */
  reachedAt: string | null;
}

/**
 * Progress on one instance (SQL view `instance_progress` / `_goal_progress`): accepted activities
 * of the pact's types started inside [openAt, deadlineAt), workouts only from 10 minutes, summed in
 * (startedAt, id) order. `activities` should already be one user's rows.
 */
export function computeProgress(
  kind: PactKind,
  goal: number,
  activityTypes: readonly string[],
  window: { openAt: string; deadlineAt: string },
  activities: readonly ActivityRecord[],
): Progress {
  const open = ms(window.openAt);
  const deadline = ms(window.deadlineAt);
  const counted = activities
    .filter((a) => a.verdict === "accepted")
    .filter((a) => {
      const s = ms(a.startedAt);
      return s >= open && s < deadline;
    })
    .filter((a) => activityMatchesPact(kind, activityTypes, a.activityType))
    .filter((a) => kind !== "workouts" || durationS(a) >= MIN_WORKOUT_S)
    .sort((a, b) => ms(a.startedAt) - ms(b.startedAt) || cmp(a.id ?? "", b.id ?? ""));
  let value = 0;
  let reachedAt: string | null = null;
  for (const a of counted) {
    value += activityAmount(kind, a);
    if (reachedAt === null && value >= goal) reachedAt = a.endedAt;
  }
  return { value, count: counted.length, reachedAt };
}

/** A goal kind's result at the deadline: there is no unverified (C0-2). */
export function goalResult(progress: Progress, goal: number): "success" | "failed" {
  return progress.value >= goal ? "success" : "failed";
}

export const MAX_ACCURACY_M = 200;
const EARTH_RADIUS_M = 6371008.8;

export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface Fix {
  lat: number;
  lng: number;
  accuracyM: number | null;
  isSimulated: boolean;
}

export interface Place {
  lat: number;
  lng: number;
  radiusM: number;
}

export function checkinVerdict(fix: Fix, place: Place): { verdict: CheckinVerdict; distanceM: number } {
  const distanceM = distanceMeters(fix.lat, fix.lng, place.lat, place.lng);
  if (fix.isSimulated) return { verdict: "rejected_simulated", distanceM };
  const acc = fix.accuracyM;
  if (acc === null || !Number.isFinite(acc) || acc < 0 || acc > MAX_ACCURACY_M) {
    return { verdict: "unjudgeable", distanceM };
  }
  return { verdict: distanceM - acc <= place.radiusM ? "in_fence" : "out_of_fence", distanceM };
}

export interface CheckinRecord {
  userId: string;
  verdict: CheckinVerdict;
  serverReceivedAt: string;
  clientCapturedAt: string;
}

export interface ParticipantResult {
  userId: string;
  status: ResultStatus;
  firstSuccessAt: string | null;
}

const ms = (iso: string) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`invalid instant: ${iso}`);
  return t;
};

export interface ComputeResultsInput {
  deadlineAt: string;
  participants: { userId: string; frozen: boolean }[];
  /** show_up: the day's check-ins */
  checkins?: CheckinRecord[];
  /** default show_up */
  kind?: PactKind;
  /** goal kinds: the instance window start */
  windowOpenAt?: string;
  goal?: number;
  activityTypes?: readonly string[];
  /** goal kinds: every participant's activities; those with `submittedAt` after deadline + 24 h do not count */
  activities?: readonly ActivityRecord[];
  /** custom: mark_done rows */
  completions?: readonly { userId: string; markedAt: string }[];
}

/**
 * Every participant's result at close (mirrors `_base_result` + the void rule). show_up uses the
 * check-ins; distance / workouts / steps use progress from accepted activities submitted by
 * deadline + 24 h (success at `reachedAt`, else failed); custom uses completions marked by the deadline.
 */
export function computeResults(input: ComputeResultsInput): { voided: boolean; results: ParticipantResult[] } {
  const deadline = ms(input.deadlineAt);
  const kind: PactKind = input.kind ?? "show_up";
  const participants = [...input.participants].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  const results: ParticipantResult[] = participants.map(({ userId, frozen }) => {
    if (frozen) return { userId, status: "frozen", firstSuccessAt: null };
    if (kind === "custom") {
      const done = (input.completions ?? [])
        .filter((c) => c.userId === userId && ms(c.markedAt) <= deadline)
        .sort((a, b) => ms(a.markedAt) - ms(b.markedAt))[0];
      return done ? { userId, status: "success", firstSuccessAt: done.markedAt } : { userId, status: "failed", firstSuccessAt: null };
    }
    if (kind !== "show_up") {
      if (input.windowOpenAt === undefined || input.goal === undefined) throw new Error(`${kind} needs windowOpenAt and goal`);
      const cutoff = deadline + LATE_EVIDENCE_MS;
      const mine = (input.activities ?? []).filter(
        (a) => a.userId === userId && (a.submittedAt === undefined || ms(a.submittedAt) <= cutoff),
      );
      const progress = computeProgress(kind, input.goal, input.activityTypes ?? [], { openAt: input.windowOpenAt, deadlineAt: input.deadlineAt }, mine);
      return goalResult(progress, input.goal) === "success"
        ? { userId, status: "success", firstSuccessAt: progress.reachedAt }
        : { userId, status: "failed", firstSuccessAt: null };
    }
    const mine = (input.checkins ?? []).filter((c) => c.userId === userId);
    const successes = mine
      .filter((c) => c.verdict === "in_fence" && ms(c.serverReceivedAt) <= deadline)
      .sort((a, b) => ms(a.serverReceivedAt) - ms(b.serverReceivedAt));
    const first = successes[0];
    if (first) return { userId, status: "success", firstSuccessAt: first.serverReceivedAt };
    const unverified = mine.some(
      (c) =>
        c.verdict === "unjudgeable" ||
        (c.verdict === "in_fence" && ms(c.serverReceivedAt) > deadline && ms(c.clientCapturedAt) <= deadline),
    );
    return { userId, status: unverified ? "unverified" : "failed", firstSuccessAt: null };
  });
  const active = results.filter((r) => r.status === "success" || r.status === "failed").length;
  if (active < 2) {
    // RT-2: the active statuses are voided; an unverified attempt stays on record (it counts toward
    // the unverified budget and can be challenged), as does a freeze.
    return {
      voided: true,
      results: results.map((r) =>
        r.status === "success" || r.status === "failed" ? { userId: r.userId, status: "void", firstSuccessAt: null } : r,
      ),
    };
  }
  return { voided: false, results };
}

/** How a review still open at settlement resolves: majority of votes cast; tie → rejected; none → defaulted. */
export function settlementReviewStatus(yes: number, no: number): Exclude<ReviewStatus, "open"> {
  if (!Number.isSafeInteger(yes) || !Number.isSafeInteger(no) || yes < 0 || no < 0) throw new Error("invalid vote counts");
  if (yes + no === 0) return "defaulted";
  return yes > no ? "accepted" : "rejected";
}

export interface ReviewOutcome {
  kind: ReviewKind;
  status: ReviewStatus;
}

/**
 * One resolved review applied to a participant's current result (mirrors `_refresh_result`):
 * appeal accepted → success at the deadline (D1); challenge accepted → failed; everything else,
 * including a defaulted appeal (N3-1), leaves the result as it is.
 */
export function applyReview(current: ParticipantResult, review: ReviewOutcome, deadlineAt: string): ParticipantResult {
  if (review.kind === "appeal" && review.status === "accepted") {
    return { userId: current.userId, status: "success", firstSuccessAt: deadlineAt };
  }
  if (review.kind === "challenge" && review.status === "accepted") {
    return { userId: current.userId, status: "failed", firstSuccessAt: null };
  }
  return current;
}

/** Resolved reviews applied in resolution order (resolved_at, then opened_at). */
export function applyReviews(base: ParticipantResult, deadlineAt: string, reviews: readonly ReviewOutcome[]): ParticipantResult {
  return reviews.reduce((cur, r) => applyReview(cur, r, deadlineAt), base);
}

export function computeInstancePayout(input: {
  stakeCents: number;
  carryInCents: number;
  results: ParticipantResult[];
}): { memberDeltas: Record<string, number>; carryDelta: number } {
  const { stakeCents, carryInCents } = input;
  if (!Number.isSafeInteger(stakeCents) || stakeCents <= 0) throw new Error(`invalid stake: ${stakeCents}`);
  if (!Number.isSafeInteger(carryInCents) || carryInCents < 0) throw new Error(`invalid carry: ${carryInCents}`);

  const winners = input.results
    .filter((r) => r.status === "success")
    .sort((a, b) => {
      const ta = a.firstSuccessAt ? ms(a.firstSuccessAt) : Infinity;
      const tb = b.firstSuccessAt ? ms(b.firstSuccessAt) : Infinity;
      if (ta !== tb) return ta - tb;
      return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
    });
  const losers = input.results.filter((r) => r.status === "failed");
  const memberDeltas: Record<string, number> = {};
  if (winners.length + losers.length < 2) return { memberDeltas, carryDelta: 0 };

  for (const l of losers) memberDeltas[l.userId] = -stakeCents;
  if (winners.length === 0) return { memberDeltas, carryDelta: stakeCents * losers.length };

  const pot = stakeCents * losers.length + carryInCents;
  const share = Math.floor(pot / winners.length);
  const leftover = pot % winners.length;
  winners.forEach((w, i) => {
    const amount = share + (i < leftover ? 1 : 0);
    if (amount !== 0) memberDeltas[w.userId] = amount;
  });
  return { memberDeltas, carryDelta: carryInCents === 0 ? 0 : -carryInCents };
}

export interface Obligation {
  from: string;
  to: string;
  amountCents: number;
}

export function simplifyDebts(balances: Record<string, number>): {
  obligations: Obligation[];
  ridingInCarryCents: number;
} {
  const entries = Object.entries(balances);
  for (const [u, v] of entries) if (!Number.isSafeInteger(v)) throw new Error(`invalid balance for ${u}`);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  if (total > 0) throw new Error(`balances sum to a positive total (${total}); money cannot appear from nowhere`);

  const byAmountThenId = (a: [string, number], b: [string, number]) =>
    b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const creditors = entries.filter(([, v]) => v > 0).map(([u, v]): [string, number] => [u, v]);
  const debtors = entries.filter(([, v]) => v < 0).map(([u, v]): [string, number] => [u, -v]);
  const obligations: Obligation[] = [];

  while (creditors.length > 0) {
    creditors.sort(byAmountThenId);
    debtors.sort(byAmountThenId);
    const c = creditors[0]!;
    const d = debtors[0]!;
    const amount = Math.min(c[1], d[1]);
    obligations.push({ from: d[0], to: c[0], amountCents: amount });
    c[1] -= amount;
    d[1] -= amount;
    if (c[1] === 0) creditors.shift();
    if (d[1] === 0) debtors.shift();
  }
  return { obligations, ridingInCarryCents: total === 0 ? 0 : -total };
}

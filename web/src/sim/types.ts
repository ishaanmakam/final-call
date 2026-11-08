import type { CheckinVerdict, ParticipantResult, ResultStatus, ReviewKind, ReviewStatus } from '@final-call/rules';

export type { CheckinVerdict, ParticipantResult, ResultStatus, ReviewKind, ReviewStatus };

export type MemberId = 'you' | 'maya' | 'diego' | 'priya';
export type FriendId = Exclude<MemberId, 'you'>;

/** What a scripted friend does on a day. Read when the window opens (Boarding). */
export type Behaviour = 'on_time' | 'out_of_fence' | 'no_show' | 'no_gps' | 'late_offline' | 'frozen';

export type LocationMode = 'precise' | 'approximate' | 'denied';

export interface Place {
  lat: number;
  lng: number;
  radiusM: number;
  label: string;
}

export interface Member {
  id: MemberId;
  name: string;
  /** initials on the avatar */
  initials: string;
  place: Place;
  /** index into the palette's avatar pairs */
  avatar: number;
}

export interface Pact {
  id: string;
  title: string;
  /** ISO weekdays, 1 = Monday */
  days: number[];
  windowOpenLocal: string;
  deadlineLocal: string;
  stakeCents: number;
  tz: string;
}

export type InstanceStatus = 'scheduled' | 'open' | 'closed' | 'settled' | 'voided';

export interface Instance {
  id: string;
  localDate: string;
  windowOpenAt: number;
  deadlineAt: number;
  status: InstanceStatus;
  /** carry balance of the pact at close (null until closed; 0 on a revived day) */
  carryInCents: number | null;
  closedAt: number | null;
  settledAt: number | null;
  finalCallAt: number | null;
  roster: MemberId[];
  /** effective results (base results with resolved reviews applied), keyed by member */
  results: Partial<Record<MemberId, ParticipantResult>>;
  /** results as computed from check-ins alone, before reviews */
  baseResults: Partial<Record<MemberId, ParticipantResult>>;
}

export interface Checkin {
  id: string;
  instanceId: string;
  userId: MemberId;
  verdict: CheckinVerdict;
  distanceM: number;
  accuracyM: number | null;
  clientCapturedAt: number;
  /** null while the tap sits in the offline queue */
  serverReceivedAt: number | null;
}

/** A tap the app refused to send (Approximate Location or no permission). Nothing reached the server. */
export interface RefusedTap {
  id: string;
  instanceId: string;
  at: number;
  mode: Exclude<LocationMode, 'precise'>;
  /** what the rules would have said had the fix been sent (approximate) or the consequence (denied) */
  wouldHave: { verdict: CheckinVerdict | null; status: ResultStatus; note: string };
}

export interface Freeze {
  id: string;
  instanceId: string;
  userId: MemberId;
  isoWeek: string;
  declaredAt: number;
}

export interface Review {
  id: string;
  instanceId: string;
  subject: MemberId;
  openedBy: MemberId;
  kind: ReviewKind;
  reason: string;
  status: ReviewStatus;
  systemOpened: boolean;
  votes: Partial<Record<MemberId, boolean>>;
  openedAt: number;
  resolvedAt: number | null;
}

export type EntryKind = 'stake' | 'payout' | 'rollover' | 'settlement_payment' | 'correction';

/** Account keys: `member:<id>`, `pot:<instanceId>`, `carry:<pactId>`. */
export type AccountKey = string;

export interface LedgerLine {
  account: AccountKey;
  amountCents: number;
}

export interface LedgerEntry {
  id: string;
  kind: EntryKind;
  idempotencyKey: string;
  instanceId: string | null;
  memo: string;
  lines: LedgerLine[];
  createdAt: number;
}

export interface Settlement {
  id: string;
  weekStart: string;
  ranAt: number;
  /** money sitting in carry, not owed to anyone yet (from the oracle) */
  ridingInCarryCents: number;
}

export type ObligationStatus = 'pending' | 'marked_paid' | 'confirmed' | 'superseded';

export interface Obligation {
  id: string;
  settlementId: string;
  from: MemberId;
  to: MemberId;
  amountCents: number;
  status: ObligationStatus;
  markedPaidAt: number | null;
  confirmedAt: number | null;
}

export type EventKind =
  | 'boarding'
  | 'final_call'
  | 'gate_closed'
  | 'checkin'
  | 'queued'
  | 'refused'
  | 'late_tap'
  | 'review_opened'
  | 'vote'
  | 'review_resolved'
  | 'correction'
  | 'settlement'
  | 'payment'
  | 'note';

export interface SimEvent {
  id: string;
  at: number;
  kind: EventKind;
  text: string;
  instanceId: string | null;
  /** your net for the day, for the gate-closed reveal */
  youDeltaCents?: number;
}

export interface YouState {
  /** metres east / north of your place's centre */
  dx: number;
  dy: number;
  accuracyM: number;
  online: boolean;
  locationMode: LocationMode;
}

export interface World {
  now: number;
  /** clock value at the previous tick, so newly visible late taps can be found */
  seenUntil: number;
  startLocalDate: string;
  pact: Pact;
  members: Member[];
  you: YouState;
  behaviours: Record<FriendId, Behaviour>;
  instances: Instance[];
  checkins: Checkin[];
  refusedTaps: RefusedTap[];
  freezes: Freeze[];
  reviews: Review[];
  entries: LedgerEntry[];
  settlements: Settlement[];
  obligations: Obligation[];
  events: SimEvent[];
  seq: number;
}

/**
 * Hand-written database types matching docs/CONTRACT.md.
 *
 * Shape follows `supabase gen types typescript` output so the generated file can replace
 * this one later (see README "Regenerating types"). Conventions: timestamptz and date
 * columns are ISO strings, `time` columns are 'HH:MM:SS' strings, int8/bigint columns arrive
 * as JSON numbers (all values here are cents, far below 2^53).
 */

export type InstanceStatus = 'scheduled' | 'open' | 'closed' | 'settled' | 'voided';
export type ResultStatus = 'pending' | 'success' | 'failed' | 'unverified' | 'frozen' | 'void' | 'excluded';
export type CheckinVerdict = 'in_fence' | 'out_of_fence' | 'unjudgeable' | 'rejected_simulated';
export type ReviewKind = 'appeal' | 'challenge';
export type ReviewStatus = 'open' | 'accepted' | 'rejected' | 'defaulted';
export type LedgerAccountKind = 'member' | 'pot' | 'carry';
export type EntryKind = 'stake' | 'payout' | 'rollover' | 'settlement_payment' | 'correction';
export type ObligationStatus = 'pending' | 'marked_paid' | 'confirmed' | 'superseded';
export type GroupRole = 'owner' | 'member';

// ---------- challenge kinds (20261109000100_challenge_kinds.sql; spec docs/superpowers/specs/2026-11-08-challenge-kinds-design.md) ----------

/** What success means per instance: a check-in, a distance, a count of workouts, a step total, or a self-report. */
export type PactKind = 'show_up' | 'distance' | 'workouts' | 'steps' | 'custom';
/** daily on `days_of_week`; weekly Monday 00:00 to the next Monday 00:00; once from race_start to race_end. */
export type PactPeriod = 'daily' | 'weekly' | 'once';
/** unit of `goal_value`: metres, a count of workouts or marked days, or steps */
export type GoalUnit = 'm' | 'count' | 'steps';
export type ActivitySource = 'healthkit' | 'strava' | 'manual';
export type ActivityVerdict = 'accepted' | 'rejected_manual' | 'rejected_duplicate' | 'rejected_type' | 'rejected_future';
export type ActivityType = 'running' | 'walking' | 'cycling' | 'swimming' | 'hiking' | 'rowing' | 'strength' | 'yoga' | 'other';
export const ACTIVITY_TYPES: readonly ActivityType[] = ['running', 'walking', 'cycling', 'swimming', 'hiking', 'rowing', 'strength', 'yoga', 'other'];
/** what `activities.activity_type` may hold: the nine pact types plus a daily step sample (CA-2) */
export type SampleType = ActivityType | 'steps';
/** PostgREST serializes `numeric` as a string; the app coerces with `toNumber` at the query layer. */
export type PgNumeric = number | string;

export type ProfileRow = {
  id: string;
  display_name: string;
  /** added in 20261107000500_app_support.sql; 5 to 30 of [A-Za-z0-9_-] when set */
  venmo_username: string | null;
  /** 20261108000600_account_deletion.sql: set when the account was deleted (name reads "Deleted member") */
  deleted_at?: string | null;
  created_at: string;
};

export type GroupRow = {
  id: string;
  name: string;
  invite_code: string;
  settlement_tz: string;
  created_by: string;
  created_at: string;
};

export type GroupMemberRow = {
  group_id: string;
  user_id: string;
  role: GroupRole;
  joined_at: string;
  left_at: string | null;
};

export type PactRow = {
  id: string;
  group_id: string;
  title: string;
  /** ISO weekdays, 1 = Monday .. 7 = Sunday; null (or empty) for weekly and once pacts, which have no days */
  days_of_week: number[] | null;
  window_open_local: string;
  deadline_local: string;
  stake_cents: number;
  tz: string;
  paused: boolean;
  created_by: string;
  created_at: string;
  /** 20261108000700_seasons.sql: an optional season, both set or both null (1..12 weeks from this local date) */
  season_start?: string | null;
  season_weeks?: number | null;
  /** 20261109000100_challenge_kinds.sql: 'show_up' is the original pact */
  kind: PactKind;
  period: PactPeriod;
  /** null for show_up; metres / count / steps per `goal_unit` for the rest (numeric: may arrive as a string) */
  goal_value: PgNumeric | null;
  goal_unit: GoalUnit | null;
  /** distance / workouts: the activity types that count (default {running}); null otherwise */
  activity_types: ActivityType[] | null;
  /** period 'once' only: the race runs race_start 00:00 to race_end + 1 day 00:00 in the pact zone */
  race_start: string | null;
  race_end: string | null;
  /** 20261109000300_custom_proof.sql: custom kind only; mark_done then needs a photo (23514 without one) */
  proof_required: boolean;
};

export type PactParticipantRow = {
  pact_id: string;
  user_id: string;
  /** null for goal kinds: a place is required only for show_up (join_pact's place args are nullable) */
  place_lat: number | null;
  place_lng: number | null;
  place_radius_m: number | null;
  place_label: string | null;
  joined_at: string;
  left_at: string | null;
};

/**
 * Place history (20261108000100_place_accountability.sql). A first place counts at once. A change
 * counts from `effective_from`: 24 h after it was saved, moved earlier (never before 12 h) when
 * another member confirms it (`acknowledged_*`); an objection (`objected_*`) blocks it for good.
 * The place that applies to an instance is the latest row with effective_from <= window_open_at
 * that was not objected to by then.
 */
export type PactParticipantPlaceRow = {
  id: string;
  pact_id: string;
  user_id: string;
  lat: number;
  lng: number;
  radius_m: number;
  label: string | null;
  effective_from: string;
  created_at: string;
  /** true when another member had to confirm it (a change while others are in the group) */
  requires_ack: boolean;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  objected_at: string | null;
  objected_by: string | null;
  objection_reason: string | null;
  /** when the tick posted the "now counts" feed event for an unconfirmed, unobjected change */
  effective_event_at: string | null;
};

export type PlaceState = 'effective' | 'pending' | 'objected' | 'superseded';

/** View `pact_places_visible`: every current participant's place rows, readable by the group. */
export type PactPlaceVisibleRow = {
  place_id: string;
  pact_id: string;
  group_id: string;
  user_id: string;
  user_name: string | null;
  lat: number;
  lng: number;
  radius_m: number;
  label: string | null;
  created_at: string;
  effective_from: string;
  requires_ack: boolean;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  acknowledged_by_name: string | null;
  objected_at: string | null;
  objected_by: string | null;
  objected_by_name: string | null;
  objection_reason: string | null;
  /** the row in force right now */
  is_current: boolean;
  state: PlaceState;
  /** another member may confirm it now (not the owner) */
  acknowledgeable: boolean;
  /** another member may object now (24 h after it was set, unless confirmed) */
  objectable: boolean;
};

export type PlaceEventKind = 'created' | 'acknowledged' | 'objected' | 'effective';

/** Table `place_events`: the feed rows for places (snapshots; `place_id` is null once a pending place was replaced). */
export type PlaceEventRow = {
  id: number;
  group_id: string;
  pact_id: string;
  place_id: string | null;
  /** whose place */
  user_id: string;
  /** who did it: the setter, the confirmer or the objector */
  actor_id: string;
  kind: PlaceEventKind;
  label: string | null;
  lat: number | null;
  lng: number | null;
  radius_m: number | null;
  prev_label: string | null;
  prev_lat: number | null;
  prev_lng: number | null;
  prev_radius_m: number | null;
  distance_from_prev_m: number | null;
  reason: string | null;
  created_at: string;
};

/** RPC `pact_place_distances`: metres from each place (in force or pending) to the others' places in force. */
export type PlaceDistanceRow = {
  pact_id: string;
  place_id: string;
  user_id: string;
  label: string | null;
  state: 'effective' | 'pending';
  other_user_id: string;
  other_place_id: string;
  other_label: string | null;
  distance_m: number;
};

export type PactInstanceRow = {
  id: string;
  pact_id: string;
  local_date: string;
  window_open_at: string;
  deadline_at: string;
  status: InstanceStatus;
  carry_in_cents: number | null;
  closed_at: string | null;
  deadline_soon_sent_at: string | null;
};

export type CheckinRow = {
  id: string;
  instance_id: string;
  user_id: string;
  client_captured_at: string | null;
  server_received_at: string;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  distance_m: number | null;
  is_simulated: boolean;
  verdict: CheckinVerdict;
  client_attempt_id: string | null;
};

export type FreezeRow = {
  id: string;
  pact_id: string;
  user_id: string;
  instance_id: string;
  declared_at: string;
  iso_week: string;
};

export type ResultRow = {
  instance_id: string;
  user_id: string;
  status: ResultStatus;
  first_success_at: string | null;
  decided_at: string | null;
};

export type ReviewRow = {
  id: string;
  instance_id: string;
  subject_user_id: string;
  opened_by: string;
  kind: ReviewKind;
  reason: string | null;
  photo_path: string | null;
  status: ReviewStatus;
  opened_at: string;
  resolved_at: string | null;
  /** true for the unverified-budget challenge the server opens itself (opened_by = subject) */
  system_opened: boolean;
};

/** `unverified_month_counts` view: unverified results per person, pact and calendar month (pact zone). */
export type UnverifiedMonthCountRow = {
  pact_id: string;
  user_id: string;
  /** first day of the month, 'YYYY-MM-01' */
  month: string;
  count: number;
};

/**
 * Table `activities` (evidence for goal kinds). No route or coordinates. Idempotent per
 * (user, source, external_id). Group members read each other's rows only through `pact_activities`.
 */
export type ActivityRow = {
  id: string;
  user_id: string;
  source: ActivitySource;
  external_id: string;
  activity_type: string;
  started_at: string;
  ended_at: string;
  distance_m: number | null;
  duration_s: number;
  steps: number | null;
  device: string | null;
  app_bundle: string | null;
  /** HealthKit `HKWasUserEntered`, Strava `manual`: rejected_manual */
  is_manual: boolean;
  raw_hash: string | null;
  submitted_at: string;
  verdict: ActivityVerdict;
  reject_reason: string | null;
};

/** View `pact_activities`: the activities that count toward (or were rejected for) a shared pact, as its members see them. */
export type PactActivityRow = {
  pact_id: string;
  instance_id: string;
  user_id: string;
  activity_id: string;
  source: ActivitySource;
  activity_type: string;
  started_at: string;
  ended_at: string;
  distance_m: number | null;
  duration_s: number;
  steps: number | null;
  device: string | null;
  app_bundle: string | null;
  is_manual: boolean;
  verdict: ActivityVerdict;
  reject_reason: string | null;
};

/** View `instance_progress`: accepted activity totals per participant inside the instance window (derived, never stored). */
export type InstanceProgressRow = {
  instance_id: string;
  user_id: string;
  value: PgNumeric;
  goal: PgNumeric;
  activity_count: number;
  /** `ended_at` of the activity that first crossed the goal; null while short of it */
  reached_at: string | null;
};

/** View `instance_standings`: `instance_progress` ranked by value, ties by reached_at then user_id. */
export type InstanceStandingRow = {
  instance_id: string;
  user_id: string;
  rank: number;
  value: PgNumeric;
  goal: PgNumeric;
  reached_at: string | null;
};

/** One item of `submit_activities(p_activities jsonb)`. */
export type ActivitySubmission = {
  source: ActivitySource;
  external_id: string;
  /** one of the nine types, or 'steps' for a daily step total */
  activity_type: SampleType;
  started_at: string;
  ended_at: string;
  distance_m: number | null;
  duration_s: number;
  steps: number | null;
  device: string | null;
  app_bundle: string | null;
  is_manual: boolean;
  raw_hash: string | null;
};

/** View `my_integrations` (20261109000200_strava.sql): the caller's own connections, never a token. */
export type MyIntegrationRow = {
  provider: 'strava';
  athlete_id: string;
  connected_at: string;
};

export type ReviewVoteRow = {
  review_id: string;
  voter_id: string;
  supports: boolean;
  cast_at: string;
};

export type LedgerAccountRow = {
  id: string;
  group_id: string;
  kind: LedgerAccountKind;
  user_id: string | null;
  instance_id: string | null;
  pact_id: string | null;
};

export type LedgerEntryRow = {
  id: string;
  group_id: string;
  kind: EntryKind;
  idempotency_key: string;
  instance_id: string | null;
  memo: string | null;
  created_at: string;
};

export type LedgerLineRow = {
  id: number;
  entry_id: string;
  account_id: string;
  amount_cents: number;
};

export type SettlementRow = {
  id: string;
  group_id: string;
  week_start: string;
  ran_at: string;
};

export type ObligationRow = {
  id: string;
  settlement_id: string;
  group_id: string;
  from_user: string;
  to_user: string;
  amount_cents: number;
  status: ObligationStatus;
  marked_paid_at: string | null;
  confirmed_at: string | null;
};

export type NotificationOutboxRow = {
  id: number;
  user_id: string;
  kind: string;
  payload: Json;
  created_at: string;
  sent_at: string | null;
  attempts: number;
  last_error: string | null;
  claimed_until: string | null;
};

export type PushTokenRow = {
  user_id: string;
  token: string;
  platform: string;
  updated_at: string;
};

export type AccountBalanceRow = {
  account_id: string;
  group_id: string;
  kind: LedgerAccountKind;
  user_id: string | null;
  pact_id: string | null;
  instance_id: string | null;
  balance_cents: number;
};

export type MemberBalanceRow = {
  group_id: string;
  user_id: string;
  balance_cents: number;
};

/**
 * `instance_member_nets` (20261108000800): what one instance did to each member's ledger, straight
 * from `ledger_lines`. Only members whose lines sum to a non-zero amount have a row; `pot_cents` is
 * everything paid into that instance's pot (forfeits plus carry drawn) and repeats on every row.
 */
export type InstanceMemberNetRow = {
  instance_id: string;
  group_id: string;
  user_id: string;
  net_cents: number;
  pot_cents: number;
};

/**
 * `pact_season_recaps` (20261108000700): per member, the closed/settled days whose local_date falls in
 * the pact's season window, and that member's ledger net on those days (members + carry sum to zero).
 */
export type PactSeasonRecapRow = {
  pact_id: string;
  user_id: string;
  season_start: string;
  /** the last local date of the season (inclusive) */
  season_end: string;
  days: number;
  showed_up: number;
  missed: number;
  unverified: number;
  frozen: number;
  net_cents: number;
};

/** `pact_streaks`: consecutive days showed up (frozen is neutral; missed / unverified break; voided days ignored). */
export type PactStreakRow = {
  pact_id: string;
  user_id: string;
  current_streak: number;
  best_streak: number;
};

/** `group_settlement_stats`: obligations confirmed on Venmo out of those created (superseded rows excluded). */
export type GroupSettlementStatsRow = {
  group_id: string;
  obligations_created: number;
  obligations_confirmed: number;
  /** confirmed / created to 4 places, null until an obligation exists; PostgREST may send numeric as a string */
  completion_rate: number | string | null;
  weeks_settled: number;
  /** Monday of the last settled week, 'YYYY-MM-DD' */
  last_settled_week: string | null;
};

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/** PostgREST sends `numeric` columns as strings; everything the app draws is a number. */
export function toNumber(v: PgNumeric | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

type Table<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

type View<Row> = {
  Row: Row;
  Relationships: [];
};

type Fn<Args, Returns> = { Args: Args; Returns: Returns };

export type RpcFunctions = {
  create_group: Fn<{ p_name: string; p_settlement_tz: string }, string>;
  join_group: Fn<{ p_invite_code: string }, string>;
  leave_group: Fn<{ p_group: string }, undefined>;
  create_pact: Fn<
    {
      p_group: string;
      p_title: string;
      p_days: number[];
      p_window_open: string;
      p_deadline: string;
      p_stake_cents: number;
      p_tz: string;
      /** challenge kinds (defaults keep the 7-argument show_up call working) */
      p_kind?: PactKind;
      p_period?: PactPeriod;
      p_goal_value?: number | null;
      p_goal_unit?: GoalUnit | null;
      p_activity_types?: ActivityType[] | null;
      p_race_start?: string | null;
      p_race_end?: string | null;
      /** custom kind: every mark needs a photo (20261109000300) */
      p_proof_required?: boolean;
    },
    string
  >;
  /** place args are required only for show_up; goal kinds join with nulls */
  join_pact: Fn<{ p_pact: string; p_lat: number | null; p_lng: number | null; p_radius_m: number | null; p_label: string | null }, undefined>;
  /** goal kinds: evidence from Apple Health (the Strava function uses submit_activities_for); returns the number of rows written */
  submit_activities: Fn<{ p_activities: ActivitySubmission[] }, number>;
  /** custom kind: marks the instance done before its deadline (success), optional photo path */
  mark_done: Fn<{ p_instance: string; p_photo_path: string | null }, undefined>;
  set_pact_paused: Fn<{ p_pact: string; p_paused: boolean }, undefined>;
  check_in: Fn<
    {
      p_instance: string;
      /** null lat/lng/accuracy = "no fix" attempt; contract rule makes it `unjudgeable` */
      p_lat: number | null;
      p_lng: number | null;
      p_accuracy_m: number | null;
      p_client_captured_at: string;
      p_is_simulated: boolean;
      p_client_attempt_id?: string | null;
    },
    CheckinRow
  >;
  declare_freeze: Fn<{ p_instance: string }, string>;
  open_review: Fn<
    { p_instance: string; p_subject: string; p_kind: ReviewKind; p_reason: string; p_photo_path: string | null },
    string
  >;
  cast_vote: Fn<{ p_review: string; p_supports: boolean }, undefined>;
  mark_obligation_paid: Fn<{ p_obligation: string }, undefined>;
  confirm_obligation: Fn<{ p_obligation: string }, undefined>;
  /** payee only: moves a marked_paid obligation back to pending ("I didn't receive this") */
  dispute_obligation: Fn<{ p_obligation: string }, undefined>;
  register_push_token: Fn<{ p_token: string; p_platform: string }, undefined>;
  /** another current member confirms a changed place (counts from then, never before 12 h after the change) */
  acknowledge_place: Fn<{ p_place: string }, undefined>;
  /** another current member blocks a place set in the last 24 h; the owner must set a new one */
  object_place: Fn<{ p_place: string; p_reason: string }, undefined>;
  pact_place_distances: Fn<{ p_pact: string }, PlaceDistanceRow[]>;
  /** the caller only: leaves every group (leave rules apply), anonymizes the profile, erases the auth identity */
  delete_my_account: Fn<Record<string, never>, undefined>;
  /** owner or pact creator: start a season (both set) or end it (both null); 1..12 weeks */
  set_pact_season: Fn<{ p_pact: string; p_start: string | null; p_weeks: number | null }, undefined>;
  /** forgets the caller's Strava connection (tokens deleted; activities stay); idempotent */
  disconnect_integration: Fn<{ p_provider: 'strava' }, undefined>;
};

export type RpcName = keyof RpcFunctions;
export type RpcArgs<N extends RpcName> = RpcFunctions[N]['Args'];
export type RpcReturn<N extends RpcName> = RpcFunctions[N]['Returns'];

export type Database = {
  public: {
    Tables: {
      profiles: Table<ProfileRow, Pick<ProfileRow, 'id' | 'display_name'> & Partial<ProfileRow>>;
      groups: Table<GroupRow>;
      group_members: Table<GroupMemberRow>;
      pacts: Table<PactRow>;
      pact_participants: Table<PactParticipantRow>;
      pact_participant_places: Table<PactParticipantPlaceRow>;
      place_events: Table<PlaceEventRow>;
      pact_instances: Table<PactInstanceRow>;
      checkins: Table<CheckinRow>;
      freezes: Table<FreezeRow>;
      results: Table<ResultRow>;
      activities: Table<ActivityRow>;
      reviews: Table<ReviewRow>;
      review_votes: Table<ReviewVoteRow>;
      ledger_accounts: Table<LedgerAccountRow>;
      ledger_entries: Table<LedgerEntryRow>;
      ledger_lines: Table<LedgerLineRow>;
      settlements: Table<SettlementRow>;
      obligations: Table<ObligationRow>;
      notification_outbox: Table<NotificationOutboxRow>;
      push_tokens: Table<PushTokenRow>;
    };
    Views: {
      account_balances: View<AccountBalanceRow>;
      member_balances: View<MemberBalanceRow>;
      /** what settlement bills: settled instances plus settlement payments only */
      billable_member_balances: View<MemberBalanceRow>;
      pact_places_visible: View<PactPlaceVisibleRow>;
      unverified_month_counts: View<UnverifiedMonthCountRow>;
      instance_member_nets: View<InstanceMemberNetRow>;
      pact_season_recaps: View<PactSeasonRecapRow>;
      pact_streaks: View<PactStreakRow>;
      group_settlement_stats: View<GroupSettlementStatsRow>;
      instance_progress: View<InstanceProgressRow>;
      instance_standings: View<InstanceStandingRow>;
      pact_activities: View<PactActivityRow>;
      my_integrations: View<MyIntegrationRow>;
    };
    Functions: RpcFunctions;
    Enums: {
      instance_status: InstanceStatus;
      result_status: ResultStatus;
      checkin_verdict: CheckinVerdict;
      review_kind: ReviewKind;
      review_status: ReviewStatus;
      ledger_account_kind: LedgerAccountKind;
      entry_kind: EntryKind;
      obligation_status: ObligationStatus;
      pact_kind: PactKind;
      pact_period: PactPeriod;
      activity_source: ActivitySource;
      activity_verdict: ActivityVerdict;
    };
    CompositeTypes: Record<string, never>;
  };
};

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
  /** ISO weekdays, 1 = Monday .. 7 = Sunday */
  days_of_week: number[];
  window_open_local: string;
  deadline_local: string;
  stake_cents: number;
  tz: string;
  paused: boolean;
  created_by: string;
  created_at: string;
};

export type PactParticipantRow = {
  pact_id: string;
  user_id: string;
  place_lat: number;
  place_lng: number;
  place_radius_m: number;
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

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

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
    },
    string
  >;
  join_pact: Fn<{ p_pact: string; p_lat: number; p_lng: number; p_radius_m: number; p_label: string }, undefined>;
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
    };
    CompositeTypes: Record<string, never>;
  };
};

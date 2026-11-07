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
  /**
   * NOT IN CONTRACT YET: required schema addition `profiles.venmo_username text null`.
   * Optional so the client works before the column exists.
   */
  venmo_username?: string | null;
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
  place_label: string;
  joined_at: string;
  left_at: string | null;
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
};

export type CheckinRow = {
  id: string;
  instance_id: string;
  user_id: string;
  client_captured_at: string;
  server_received_at: string;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  distance_m: number | null;
  is_simulated: boolean;
  verdict: CheckinVerdict;
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
  decided_at: string;
};

export type ReviewRow = {
  id: string;
  instance_id: string;
  subject_user_id: string;
  opened_by: string;
  kind: ReviewKind;
  reason: string;
  photo_path: string | null;
  status: ReviewStatus;
  opened_at: string;
  resolved_at: string | null;
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
  memo: string;
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
  register_push_token: Fn<{ p_token: string; p_platform: string }, undefined>;
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

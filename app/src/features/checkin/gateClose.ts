/**
 * The gate-close moment: today's result and the money, the second the server has them. Pure, so
 * every sentence is unit-tested. Money comes from `instance_member_nets` (the ledger), never from
 * client arithmetic: this module only looks up rows and words them.
 *
 * Voice (app/DESIGN.md): "Gate closed" is the one airport word here. Everything else is the plain
 * pledge / forfeit / pool register; first names, "and" joins, "you" lowercase inside a sentence.
 */
import type { InstanceMemberNetRow, InstanceStatus, ProfileRow, ResultRow } from '../../api/types';
import type { DayState } from '../../components/status';
import { formatCents } from '../../lib/money';
import type { PanelTone } from './copy';
import { VOICE } from './copy';

export interface GateCloseInput {
  userId: string;
  instanceStatus: InstanceStatus;
  /** my result row (null until the server posts the day) */
  myResult: ResultRow | null;
  /** everyone's result rows (the roster once closed) */
  results: readonly ResultRow[];
  nets: readonly InstanceMemberNetRow[];
  profiles: ReadonlyMap<string, Pick<ProfileRow, 'display_name'>>;
  stakeCents: number;
  carryInCents: number | null;
  /** I declared a freeze for this day (known before any result posts) */
  frozen: boolean;
  /** ms since the deadline (negative before it) */
  sinceDeadlineMs: number;
  /** a goal kind (distance / workouts / steps / custom): people "made it", nobody "showed up" (CI-6) */
  goal?: boolean;
  /** names the unit of time in the headline: "today", "this week", "in the race" */
  period?: 'daily' | 'weekly' | 'once';
}

export interface GateClose {
  state: 'tallying' | 'posted';
  /** the full first line, for VoiceOver and tests */
  headline: string;
  /** the headline split around its money figure, when it has one (the figure counts up) */
  amount?: { before: string; cents: number; after: string };
  subline: string;
  footnote?: string;
  tone: PanelTone;
  pill?: DayState;
  /** one haptic, on the frame the card mounts; null for outcomes that moved no pledge */
  haptic: 'success' | 'warning' | null;
  /** the group home's one-line form: "+$3.33 · Diego and Priya missed" */
  compact: string;
}

/** After this long without a posted result the card stops promising "within a minute". */
export const TALLY_PATIENCE_MS = 3 * 60_000;

export const firstName = (name: string | null | undefined): string => {
  const first = (name ?? '').trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : 'A friend';
};

/** "Maya", "Maya and Priya", "Maya, Priya and Diego". */
export function joinNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

const NO_MONEY = 'no pledge moved';

export function gateClose(i: GateCloseInput): GateClose {
  const posted = i.myResult !== null && i.myResult.status !== 'pending' && i.instanceStatus !== 'open' && i.instanceStatus !== 'scheduled';
  if (!posted && !i.frozen) return tallying(i.sinceDeadlineMs);

  const name = (id: string) => firstName(i.profiles.get(id)?.display_name);
  const made = i.goal ? 'made it' : 'showed up';
  const Made = i.goal ? 'Made it' : 'Showed up';
  const when = i.period === 'weekly' ? 'this week' : i.period === 'once' ? 'in the race' : 'today';
  const others = i.results.filter((r) => r.user_id !== i.userId);
  const byStatus = (s: ResultRow['status']) => others.filter((r) => r.user_id !== i.userId && r.status === s).map((r) => name(r.user_id));
  const showed = byStatus('success');
  const missed = byStatus('failed');
  const unverified = byStatus('unverified');
  const winners = i.results.filter((r) => r.status === 'success').length;
  const mine = i.nets.find((n) => n.user_id === i.userId);
  const pot = i.nets[0]?.pot_cents ?? 0;
  const carry = i.carryInCents ?? 0;

  const othersTally = (): string => {
    const parts: string[] = [];
    if (showed.length) parts.push(`${joinNames(showed)} ${made}`);
    if (missed.length) parts.push(`${joinNames(missed)} missed`);
    if (unverified.length) parts.push(`${joinNames(unverified)} unverified`);
    return parts.length ? parts.join(' · ') : 'Nobody else was in it';
  };
  const poolPart = (): string => {
    if (pot <= 0) return NO_MONEY;
    const carried = carry > 0 ? ` (${formatCents(carry)} carried over)` : '';
    return winners === 1 ? `the ${formatCents(pot)} pool${carried} is yours` : `pool ${formatCents(pot)}${carried} split ${winners} ways`;
  };

  const status = i.frozen && !posted ? 'frozen' : i.myResult!.status;
  switch (status) {
    case 'success': {
      const net = mine?.net_cents ?? 0;
      const who = missed.length ? `${joinNames(missed)} missed` : showed.length ? 'Everyone made it' : 'Nobody missed';
      if (net > 0) {
        const figure = formatCents(net, { signed: true });
        return {
          state: 'posted',
          headline: `You're ${figure} ${when}`,
          amount: { before: "You're ", cents: net, after: ` ${when}` },
          subline: `${who} · ${poolPart()}`,
          tone: 'success',
          pill: 'success',
          haptic: 'success',
          compact: `${figure} · ${who}`,
        };
      }
      return {
        state: 'posted',
        headline: 'You made it',
        subline: `${who} · ${pot > 0 ? poolPart() : NO_MONEY}`,
        tone: 'success',
        pill: 'success',
        haptic: null,
        compact: `${Made} · ${who}`,
      };
    }
    case 'failed': {
      const footnote = "If that's wrong, appeal it in the feed before Monday's settle-up.";
      if (!mine || mine.net_cents >= 0) {
        return {
          state: 'posted',
          headline: `You missed · ${NO_MONEY}`,
          subline: "Nobody else's day counted, so there was nobody to split your pledge with.",
          footnote,
          tone: 'forfeit',
          pill: 'failed',
          haptic: 'warning',
          compact: `Missed · ${NO_MONEY}`,
        };
      }
      const lost = -mine.net_cents;
      const figure = formatCents(lost);
      const who = winners > 0 ? `${joinNames(showed)} ${made}` : `Nobody made it · the ${formatCents(pot)} pool carries over`;
      return {
        state: 'posted',
        headline: `You forfeited ${figure}`,
        amount: { before: 'You forfeited ', cents: lost, after: '' },
        subline: who,
        footnote,
        tone: 'forfeit',
        pill: 'failed',
        haptic: 'warning',
        compact: `Forfeited ${figure} · ${who}`,
      };
    }
    case 'unverified':
      return {
        state: 'posted',
        headline: `Unverified · ${NO_MONEY}`,
        subline: othersTally(),
        footnote: "The app couldn't judge your tap. Unverified never costs a pledge and never wins one.",
        tone: 'neutral',
        pill: 'unverified',
        haptic: null,
        compact: `Unverified · ${NO_MONEY}`,
      };
    case 'frozen':
      return {
        state: 'posted',
        headline: `Frozen · ${NO_MONEY}`,
        subline: others.length ? othersTally() : `You called ${when} off in advance.`,
        tone: 'neutral',
        pill: 'frozen',
        haptic: null,
        compact: `Frozen · ${NO_MONEY}`,
      };
    case 'void':
      return {
        state: 'posted',
        headline: "Didn't count · fewer than two people were in it",
        subline: 'No pledge moved.',
        tone: 'neutral',
        pill: 'void',
        haptic: null,
        compact: "Didn't count · fewer than two people were in it",
      };
    case 'excluded':
      return {
        state: 'posted',
        headline: `Excluded · ${NO_MONEY}`,
        subline: "The group's review took you out of the day.",
        tone: 'neutral',
        pill: 'excluded',
        haptic: null,
        compact: `Excluded · ${NO_MONEY}`,
      };
    default:
      return tallying(i.sinceDeadlineMs);
  }
}

function tallying(sinceDeadlineMs: number): GateClose {
  const patient = sinceDeadlineMs <= TALLY_PATIENCE_MS;
  return {
    state: 'tallying',
    headline: patient ? `${VOICE.gateClosed} · tallying…` : VOICE.gateClosed,
    subline: patient ? 'Results post within a minute.' : 'Results post within a minute or two; pull to refresh.',
    tone: 'neutral',
    haptic: null,
    compact: patient ? `${VOICE.gateClosed} · tallying…` : `${VOICE.gateClosed} · results on their way`,
  };
}

/**
 * Pure copy and state tables for the check-in moment (docs/UX_AUDIT.md sections 6 and 7). No React,
 * no React Native, so every sentence the screen can show is unit-tested. "Never costs you" appears
 * only where CONTRACT.md guarantees it (unjudgeable, no fix, queued in-fence, late in-fence).
 */
import type { CheckinRow } from '../../api/types';
import type { DayState } from '../../components/status';
import { CHECKIN_CAP_MESSAGE, classifyRpcError, userMessage } from '../../lib/errors';
import type { WindowPlace } from '../../lib/places';
import { formatTimeInZone, type WindowState } from '../../lib/time';
import type { HapticName } from '../../theme/tokens';

export type PanelTone = 'success' | 'unverified' | 'forfeit' | 'neutral';
export type PanelAction = 'tryAgain' | 'allowLocation' | 'openSettings' | 'signIn';

export interface VerdictPanel {
  headline: string;
  body: string;
  footnote?: string;
  /** result pill shown above the headline (in_fence only) */
  pill?: DayState;
  tone: PanelTone;
  haptic: Extract<HapticName, 'success' | 'warning' | 'error'>;
  action?: PanelAction;
  /** a line under the panel inviting another tap */
  secondaryLine?: string;
}

const m = (n: number) => `${Math.round(n)} m`;
const acc = (row: Pick<CheckinRow, 'accuracy_m'>) => (row.accuracy_m === null ? null : `±${m(row.accuracy_m)}`);

/** The server's verdict for one tap, in words. Late means it reached the server after the deadline. */
export function panelForRow(
  row: CheckinRow,
  place: WindowPlace | null,
  deadlineAt: string,
  tz: string,
  fixError: string | null,
): VerdictPanel {
  const late = Date.parse(row.server_received_at) > Date.parse(deadlineAt);
  const tapAt = formatTimeInZone(row.client_captured_at ?? row.server_received_at, tz);
  switch (row.verdict) {
    case 'in_fence':
      if (late) {
        return {
          headline: 'Sent after the deadline',
          body: `Your tap was at ${tapAt}, which is what counts. Because it reached us at ${formatTimeInZone(row.server_received_at, tz)}, today is unverified: no pledge moves.`,
          footnote: 'A friend can challenge an unverified day in the feed.',
          tone: 'unverified',
          haptic: 'warning',
        };
      }
      return {
        headline: "You're in",
        body: `Counted at ${tapAt}.`,
        pill: 'success',
        tone: 'success',
        haptic: 'success',
      };
    case 'out_of_fence': {
      if (late) {
        return {
          headline: 'Not inside your circle',
          body: 'Your tap arrived after the deadline and was outside your circle, so today stands as missed.',
          footnote: 'If you were there, appeal it in the feed.',
          tone: 'neutral',
          haptic: 'warning',
        };
      }
      const where = place?.label ? ` of ${place.label}` : '';
      const circle = place ? `circle is ${m(place.radiusM)}` : 'circle size unknown';
      const gps = acc(row);
      return {
        headline: 'Not inside your circle yet',
        body: `About ${m(row.distance_m ?? 0)} from the center${where} (${circle}${gps ? `, GPS ${gps}` : ''}). Get closer and tap again.`,
        footnote: 'Only your best tap counts.',
        tone: 'unverified',
        haptic: 'warning',
        secondaryLine: "Tap again if you've moved closer",
      };
    }
    case 'unjudgeable': {
      if (fixError) {
        return {
          headline: 'No GPS fix',
          body: `Your tap at ${tapAt} was recorded without a location, so at worst today is unverified, which never costs you. Try again for a tap that counts.`,
          tone: 'unverified',
          haptic: 'warning',
          action: 'tryAgain',
        };
      }
      const gps = acc(row);
      return {
        headline: 'GPS too weak to judge',
        body: `${gps ? `Accuracy was ${gps}, more than the 200 m limit.` : 'No position came back.'} Try again near a window. If nothing better lands, today is unverified: no pledge moves.`,
        tone: 'unverified',
        haptic: 'warning',
        secondaryLine: 'Tap again when you have a clearer view of the sky',
      };
    }
    case 'rejected_simulated':
      return {
        headline: 'Location rejected',
        body: "That location looked simulated, so it wasn't counted. A simulated fix counts as a miss.",
        tone: 'forfeit',
        haptic: 'error',
      };
  }
}

/** Offline at tap: the attempt is queued with its tap time (D6, D14, D29). */
export function panelForQueued(tappedAtIso: string, deadlineAt: string, tz: string): VerdictPanel {
  return {
    headline: 'Saved, will send',
    body: `No connection. Your tap at ${formatTimeInZone(tappedAtIso, tz)} is saved with its GPS fix and sends itself when you're back online. If it lands after ${formatTimeInZone(deadlineAt, tz)} and you were inside your circle, today is unverified: no pledge moves.`,
    footnote: 'Open the app once you have signal to speed it up.',
    tone: 'unverified',
    haptic: 'warning',
  };
}

/** Nothing is sent without permission (D30), so this is the one state where money is at risk. */
export function panelForPermission(blocked: boolean): VerdictPanel {
  return blocked
    ? {
        headline: 'Location is off for Final Call',
        body: 'Turn it on in iOS Settings, then come back and tap Check in. Without location a tap can\'t be judged.',
        tone: 'neutral',
        haptic: 'error',
        action: 'openSettings',
      }
    : {
        headline: 'Location is off for Final Call',
        body: 'Without location, a tap can\'t be judged and today counts as missed. Allow "While Using the App" to check in.',
        tone: 'neutral',
        haptic: 'error',
        action: 'allowLocation',
      };
}

/**
 * iOS Approximate Location (DECISIONS.md N2-5): nothing is sent. Unlike weak GPS this is the person's
 * own setting, so the money consequence is the opposite of fail-open and the copy says so plainly.
 * Re-checked on foreground after "Open Settings", like the blocked panel.
 */
export function panelForApproximate(): VerdictPanel {
  return {
    headline: APPROXIMATE_LOCATION_HEADLINE,
    body: approximateLocationBody({ consequence: "can't be judged against your circle, so nothing was sent", next: 'tap Check in' }),
    footnote:
      'Without Precise Location today counts as missed and your pledge is forfeited, not unverified: turning it off is a choice, not a tracking failure.',
    tone: 'neutral',
    haptic: 'error',
    action: 'openSettings',
  };
}

/** Shared with the place screen: the same words wherever an Approximate-Location fix is refused. */
export const APPROXIMATE_LOCATION_HEADLINE = 'Precise Location is off';

/**
 * "Final Call only gets your approximate location (about a kilometre), which {consequence}. In Settings
 * → Final Call → Location, turn on Precise Location, then come back and {next}."
 */
export function approximateLocationBody(p: { consequence: string; next: string }): string {
  return `Final Call only gets your approximate location (about a kilometre), which ${p.consequence}. In Settings → Final Call → Location, turn on Precise Location, then come back and ${p.next}.`;
}

/**
 * The unverified budget (CONTRACT.md "Review"): the third unverified day in a pact in a calendar
 * month opens an automatic challenge the group votes on. Shown only from the first unverified day.
 */
export function budgetLine(count: number): string | null {
  if (!Number.isFinite(count) || count < 1) return null;
  const n = Math.floor(count);
  if (n === 1) return '1 unverified this month. Two more and the group votes on it.';
  if (n === 2) return '2 unverified this month. One more and the group votes on it.';
  return `${n} unverified this month. Another one goes to a group vote.`;
}

/** A server refusal or an unexpected error, mapped through lib/errors so no raw text reaches the UI. */
export function panelForError(error: unknown): VerdictPanel {
  const body = userMessage(error);
  const kind = classifyRpcError(error);
  if (kind === 'auth') {
    return { headline: 'Signed out', body, tone: 'neutral', haptic: 'error', action: 'signIn' };
  }
  if (body === CHECKIN_CAP_MESSAGE) {
    return {
      headline: "That's enough taps for today",
      body: "You've checked in 20 times for this day. Your earlier taps still count.",
      tone: 'neutral',
      haptic: 'error',
    };
  }
  if (/not counted for this day/i.test(body)) {
    return { headline: "You're not counted for this day", body, tone: 'neutral', haptic: 'error' };
  }
  return { headline: "Couldn't check in", body, tone: 'neutral', haptic: 'error' };
}

// ---------- the clock ----------

/**
 * The airport voice (app/DESIGN.md "Voice"): three words, used only at their three moments. The
 * window opening is "Boarding", the last fifteen minutes are "Final call", the deadline is "Gate
 * closed". The same words head the push and local reminders.
 */
export const VOICE = { boarding: 'Boarding', finalCall: 'Final call', gateClosed: 'Gate closed' } as const;
/** Final call starts here: the same lead as the `deadline_soon` push and the local reminder. */
export const FINAL_CALL_MS = 15 * 60_000;

export interface ClockCopy {
  /** words before the digits ("Opens in", "Boarding ·"); undefined when the digits stand alone */
  prefix?: string;
  /** digits are shown (before and open); false shows `big` instead */
  showCountdown: boolean;
  big?: string;
  footnote: string;
  /** the last minute: the footnote says to tap now */
  urgent: boolean;
  /** the final-call register: the last fifteen minutes draw the prefix and digits in the forfeit tone */
  final: boolean;
}

/** The big line and its footnote for each window phase. `remainingMs` is to the open or the deadline. */
export function clockCopy(phase: WindowState, remainingMs: number, openText: string, deadlineText: string): ClockCopy {
  if (phase === 'before') {
    return { prefix: 'Opens in', showCountdown: true, footnote: `${openText} · window until ${deadlineText}`, urgent: false, final: false };
  }
  if (phase === 'open') {
    const urgent = remainingMs > 0 && remainingMs <= 60_000;
    const final = remainingMs > 0 && remainingMs <= FINAL_CALL_MS;
    return {
      prefix: `${final ? VOICE.finalCall : VOICE.boarding} ·`,
      showCountdown: true,
      footnote: urgent ? 'Tap now. Your tap time is what counts.' : `left · by ${deadlineText}`,
      urgent,
      final,
    };
  }
  return { showCountdown: false, big: VOICE.gateClosed, footnote: `Deadline was ${deadlineText}`, urgent: false, final: false };
}

const minutesWord = (n: number) => `${n} minute${n === 1 ? '' : 's'}`;

/**
 * VoiceOver label for the clock block, changing once a minute (never a live region). In the last
 * minute it says "One minute left" rather than counting seconds.
 */
export function clockA11yLabel(phase: WindowState, remainingMs: number, openText: string, deadlineText: string): string {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  if (phase === 'before') return `Check-in opens in ${minutesWord(minutes)}, at ${openText}`;
  if (phase === 'open') {
    if (remainingMs <= 60_000) return `${VOICE.finalCall}. One minute left. Tap now; your tap time is what counts.`;
    const word = remainingMs <= FINAL_CALL_MS ? VOICE.finalCall : VOICE.boarding;
    return `${word}. ${minutesWord(minutes)} left, deadline ${deadlineText}`;
  }
  return `${VOICE.gateClosed}. Deadline was ${deadlineText}`;
}

// ---------- the button ----------

export type ButtonState = 'before' | 'idle' | 'locating' | 'sending' | 'done' | 'frozen' | 'closed';

export interface ButtonInput {
  phase: WindowState;
  /** instance status is closed / settled / voided */
  finished: boolean;
  frozen: boolean;
  /** an on-time in_fence tap exists */
  alreadyIn: boolean;
  busy: 'locating' | 'sending' | null;
}

export function buttonState(i: ButtonInput): ButtonState {
  if (i.busy) return i.busy;
  if (i.frozen) return 'frozen';
  if (i.finished || i.phase === 'closed') return 'closed';
  if (i.phase === 'before') return 'before';
  return i.alreadyIn ? 'done' : 'idle';
}

/** Only an idle or done button inside the window takes a tap; locating and sending guard double taps. */
export const buttonEnabled = (s: ButtonState): boolean => s === 'idle' || s === 'done';

export const buttonLabel: Record<ButtonState, string> = {
  before: 'Opens in',
  idle: 'Check in',
  locating: 'Finding you…',
  sending: 'Sending…',
  done: "You're in",
  frozen: 'Frozen',
  closed: 'Closed',
};

/** Footnote under the circle while a tap is in flight (D29: the tap time is what counts). */
export function busyFootnote(state: ButtonState, tappedAtIso: string | null, tz: string): string | null {
  if (!tappedAtIso) return null;
  const at = formatTimeInZone(tappedAtIso, tz);
  if (state === 'locating') return `Up to 25 seconds. Your tap at ${at} is locked in.`;
  if (state === 'sending') return `Your tap at ${at} is locked in.`;
  return null;
}

/** One line in the "Today's taps" list: time, verdict word, accuracy. */
export function tapRow(row: CheckinRow, deadlineAt: string, tz: string): { title: string; subtitle: string; state: DayState } {
  const late = row.verdict === 'in_fence' && Date.parse(row.server_received_at) > Date.parse(deadlineAt);
  const state: DayState =
    row.verdict === 'in_fence' ? (late ? 'late' : 'checked_in') : row.verdict === 'unjudgeable' ? 'unjudged' : row.verdict === 'out_of_fence' ? 'out_of_fence' : 'failed';
  const parts = [formatTimeInZone(row.client_captured_at ?? row.server_received_at, tz)];
  if (row.distance_m !== null && row.verdict !== 'in_fence') parts.push(`${m(row.distance_m)} away`);
  const gps = acc(row);
  if (gps) parts.push(`GPS ${gps}`);
  return { title: parts[0]!, subtitle: parts.slice(1).join(' · '), state };
}

/** Footnote under the Result group: the fail-open gloss, once, for the states that move no money. */
export function resultFootnote(status: string): string | undefined {
  switch (status) {
    case 'unverified':
      return 'Unverified means the app couldn\'t judge a tap (weak GPS, no fix, or a late offline send). It never costs a pledge and never wins one.';
    case 'frozen':
      return 'Frozen: you called the day off in advance. No pledge moves.';
    case 'void':
      return "Didn't count: fewer than two people were active, so nothing counts and no pledge moves.";
    case 'excluded':
      return "Excluded: the group's review took you out of the day. No pledge moves.";
    case 'failed':
      return 'Missed: your pledge is forfeited to the pool and split among everyone who showed up. If that\'s wrong, appeal it in the feed.';
    default:
      return undefined;
  }
}

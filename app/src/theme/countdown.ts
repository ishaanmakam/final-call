import { formatCountdown } from '../lib/time';

export interface CountdownParts {
  /** h:mm:ss above an hour, otherwise mm:ss; never negative */
  text: string;
  /** VoiceOver phrase, e.g. "22 minutes 14 seconds left" */
  label: string;
  /** true when 60 s or less remain (the ring and digits switch to the forfeit tone) */
  urgent: boolean;
  /** true once the deadline has passed */
  done: boolean;
}

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;

/**
 * Formats milliseconds remaining for the Countdown primitive. Text comes from lib/time so the
 * group-home line and the check-in screen agree to the second.
 */
export function countdownParts(ms: number, suffix = 'left'): CountdownParts {
  const total = ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const words: string[] = [];
  if (h > 0) words.push(plural(h, 'hour'));
  if (m > 0 || h > 0) words.push(plural(m, 'minute'));
  words.push(plural(s, 'second'));
  return {
    text: formatCountdown(ms),
    label: `${words.join(' ')} ${suffix}`.trim(),
    urgent: total > 0 && total <= 60,
    done: total === 0,
  };
}

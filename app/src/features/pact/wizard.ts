/**
 * Pure logic for the New pact wizard: the draft shape, defaults, validation copy, the day quick
 * picks and the window-open presets. The screen only renders what these return.
 */
import { MAX_STAKE_CENTS, MIN_STAKE_CENTS, formatCents, parseDollarsToCents } from '../../lib/money';
import { displayMinutes, isValidTimeZone } from '../../lib/time';

export type QuickPick = 'weekdays' | 'weekends' | 'everyday';

export const QUICK_PICKS: ReadonlyArray<{ id: QuickPick; label: string; days: readonly number[] }> = [
  { id: 'weekdays', label: 'Weekdays', days: [1, 2, 3, 4, 5] },
  { id: 'weekends', label: 'Weekends', days: [6, 7] },
  { id: 'everyday', label: 'Every day', days: [1, 2, 3, 4, 5, 6, 7] },
];

/** Mon..Sun as ISO weekdays with one-letter cells and full names for VoiceOver. */
export const DAY_CELLS: ReadonlyArray<{ iso: number; short: string; name: string }> = [
  { iso: 1, short: 'M', name: 'Monday' },
  { iso: 2, short: 'T', name: 'Tuesday' },
  { iso: 3, short: 'W', name: 'Wednesday' },
  { iso: 4, short: 'T', name: 'Thursday' },
  { iso: 5, short: 'F', name: 'Friday' },
  { iso: 6, short: 'S', name: 'Saturday' },
  { iso: 7, short: 'S', name: 'Sunday' },
];

export function toggleDay(days: readonly number[], iso: number): number[] {
  const next = days.includes(iso) ? days.filter((d) => d !== iso) : [...days, iso];
  return [...next].sort((a, b) => a - b);
}

export const applyQuickPick = (pick: QuickPick): number[] => [...QUICK_PICKS.find((q) => q.id === pick)!.days];

export function activeQuickPick(days: readonly number[]): QuickPick | null {
  const key = [...days].sort((a, b) => a - b).join(',');
  return QUICK_PICKS.find((q) => q.days.join(',') === key)?.id ?? null;
}

/** Minutes before the deadline the window opens. 60 is the product default. */
export const WINDOW_PRESETS: readonly number[] = [15, 30, 60, 120];

export const windowOpenMinutes = (deadline: number, offset: number): number => deadline - offset;

export function presetLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/** "1 hr before", for the window row's value when the open time is custom. */
export function offsetLabel(windowOpen: number, deadline: number): string {
  const diff = deadline - windowOpen;
  if (diff <= 0) return 'after the deadline';
  return `${presetLabel(diff)} before`;
}

export const describeWindow = (windowOpen: number, deadline: number): string =>
  `${displayMinutes(windowOpen)} to ${displayMinutes(deadline)}`;

/** The native time picker speaks Date; the pact speaks minutes after midnight. */
export function minutesToDate(minutes: number): Date {
  const d = new Date(2000, 0, 1, 0, 0, 0, 0);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d;
}

export const dateToMinutes = (d: Date): number => d.getHours() * 60 + d.getMinutes();

export interface WhatErrors {
  title?: string;
  days?: string;
}

export function validateWhat(d: { title: string; days: readonly number[] }): WhatErrors {
  if (d.title.trim().length < 2) return { title: 'Give the pact a title, like "9am class".' };
  if (d.days.length === 0) return { days: 'Pick at least one day.' };
  return {};
}

export interface WhenErrors {
  window?: string;
  tz?: string;
}

export function validateWhen(d: { windowOpen: number; deadline: number; tz: string }): WhenErrors {
  if (d.windowOpen < 0 || d.windowOpen >= d.deadline) {
    return { window: 'The window must open before the deadline on the same day.' };
  }
  if (!isValidTimeZone(d.tz)) return { tz: 'Pick a time zone from the list.' };
  return {};
}

export interface PledgeErrors {
  amount?: string;
}

export function validatePledge(dollars: string): PledgeErrors {
  const cents = parseDollarsToCents(dollars);
  if (cents === null) return { amount: 'Enter a dollar amount like 5 or 2.50.' };
  if (cents < MIN_STAKE_CENTS || cents > MAX_STAKE_CENTS) {
    return { amount: `Pledge must be between ${formatCents(MIN_STAKE_CENTS)} and ${formatCents(MAX_STAKE_CENTS)}.` };
  }
  return {};
}

/** Cents a quick-amount button sets; shown as $1 $2 $5 $10 $20. */
export const QUICK_AMOUNTS_CENTS: readonly number[] = [100, 200, 500, 1000, 2000];

export interface WizardDraft {
  title: string;
  days: number[];
  deadline: number;
  /** minutes before the deadline when a preset is chosen; null = custom open time */
  windowOffset: number | null;
  /** used only when windowOffset is null */
  customOpen: number;
  tz: string;
  dollars: string;
}

export const DEFAULT_DRAFT: WizardDraft = {
  title: '',
  days: [1, 2, 3, 4, 5],
  deadline: 9 * 60,
  windowOffset: 60,
  customOpen: 8 * 60,
  tz: '',
  dollars: '5.00',
};

export const draftWindowOpen = (d: WizardDraft): number =>
  d.windowOffset === null ? d.customOpen : windowOpenMinutes(d.deadline, d.windowOffset);

/** Anything the person changed from the defaults (time zone excluded: it is set from the device). */
export function isDraftDirty(d: WizardDraft): boolean {
  return (
    d.title.trim() !== DEFAULT_DRAFT.title ||
    d.days.join(',') !== DEFAULT_DRAFT.days.join(',') ||
    d.deadline !== DEFAULT_DRAFT.deadline ||
    d.windowOffset !== DEFAULT_DRAFT.windowOffset ||
    (d.windowOffset === null && d.customOpen !== DEFAULT_DRAFT.customOpen) ||
    d.dollars !== DEFAULT_DRAFT.dollars
  );
}

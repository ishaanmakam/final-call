/**
 * Pure logic for the New pact wizard: the draft shape, defaults, validation copy, the day quick
 * picks and the window-open presets. The screen only renders what these return.
 */
import type { CreatePactInput } from '../../api/rpc';
import type { ActivityType, PactKind } from '../../api/types';
import type { IconName } from '../../components/Icon';
import { MAX_STAKE_CENTS, MIN_STAKE_CENTS, formatCents, parseDollarsToCents } from '../../lib/money';
import { addDaysToLocalDate, displayMinutes, formatLocalDateShort, isValidTimeZone, isoWeekday, localDateInZone, toPgTime } from '../../lib/time';
import { unitToMeters, type DistanceUnit } from '../goal/goal';
import { DEFAULT_SEASON_WEEKS, nextMonday, type Season } from '../stats/season';

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
  /** run the pact as a 4-week season from the coming Monday (set_pact_season right after create_pact) */
  season: boolean;
  // ---- challenge kinds (CB) ----
  /** step 0: which of the seven choices */
  choice: ChallengeChoice;
  /** the goal as typed: a distance in `unit`, a workout count, or a daily step total */
  goalText: string;
  /** mi or km from the device locale; distances are stored in metres */
  unit: DistanceUnit;
  /** distance kinds: a weekly goal or a one-off race between two dates */
  goalPeriod: 'weekly' | 'once';
  raceStart: string;
  raceEnd: string;
  /** workouts: which activity types count */
  workoutTypes: ActivityType[];
  /** custom: a day or a week per instance */
  customPeriod: 'daily' | 'weekly';
  /** custom: a photo goes with the mark (not in the frozen RPC yet; see the lane B report) */
  needsPhoto: boolean;
}

export const DEFAULT_DRAFT: WizardDraft = {
  title: '',
  days: [1, 2, 3, 4, 5],
  deadline: 9 * 60,
  windowOffset: 60,
  customOpen: 8 * 60,
  tz: '',
  dollars: '5.00',
  season: false,
  choice: 'show_up',
  goalText: '',
  unit: 'km',
  goalPeriod: 'weekly',
  raceStart: '',
  raceEnd: '',
  workoutTypes: ['running', 'walking', 'cycling', 'swimming', 'hiking', 'rowing', 'strength', 'yoga', 'other'],
  customPeriod: 'daily',
  needsPhoto: false,
};

/** The season a wizard draft asks for: 4 weeks from the coming Monday in the pact's zone, or none. */
export function draftSeason(d: Pick<WizardDraft, 'season' | 'tz'>, nowMs: number): Season | null {
  if (!d.season || !isValidTimeZone(d.tz)) return null;
  return { start: nextMonday(localDateInZone(nowMs, d.tz)), weeks: DEFAULT_SEASON_WEEKS };
}

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
    d.dollars !== DEFAULT_DRAFT.dollars ||
    d.season !== DEFAULT_DRAFT.season ||
    d.choice !== DEFAULT_DRAFT.choice
  );
}

// ---------- challenge kinds (CB) ----------

export type ChallengeChoice = 'show_up' | 'run' | 'ride' | 'walk' | 'workouts' | 'steps' | 'custom';

export interface ChallengeOption {
  id: ChallengeChoice;
  title: string;
  /** one line under the title */
  gloss: string;
  icon: IconName;
  kind: PactKind;
  /** the activity types that count (distance / workouts); null for the rest */
  activityTypes: ActivityType[] | null;
}

export const ALL_WORKOUT_TYPES: readonly ActivityType[] = ['running', 'walking', 'cycling', 'swimming', 'hiking', 'rowing', 'strength', 'yoga', 'other'];

export const CHALLENGE_OPTIONS: readonly ChallengeOption[] = [
  { id: 'show_up', title: 'Show up', gloss: 'Be at your place by a time. One tap checks you in.', icon: 'location', kind: 'show_up', activityTypes: null },
  { id: 'run', title: 'Run', gloss: 'Miles a week, or a race by a date. Runs sync from Apple Health or Strava.', icon: 'figure.run', kind: 'distance', activityTypes: ['running'] },
  { id: 'ride', title: 'Ride', gloss: 'Miles on the bike each week, from Apple Health or Strava.', icon: 'bicycle', kind: 'distance', activityTypes: ['cycling'] },
  { id: 'walk', title: 'Walk', gloss: 'Miles on foot each week. Runs count too.', icon: 'figure.walk', kind: 'distance', activityTypes: ['walking', 'running'] },
  { id: 'workouts', title: 'Workouts', gloss: 'A number of sessions a week, ten minutes or more each.', icon: 'dumbbell', kind: 'workouts', activityTypes: [...ALL_WORKOUT_TYPES] },
  { id: 'steps', title: 'Steps', gloss: 'A daily step total from your phone or watch.', icon: 'shoeprints.fill', kind: 'steps', activityTypes: null },
  { id: 'custom', title: 'Custom', gloss: 'Anything you can mark done, with a photo if you like. Friends can challenge it.', icon: 'checkmark.circle', kind: 'custom', activityTypes: null },
];

export const challengeOption = (choice: ChallengeChoice): ChallengeOption => CHALLENGE_OPTIONS.find((o) => o.id === choice)!;

export type StepId = 'kind' | 'what' | 'when' | 'goal' | 'pledge';

/** Show up keeps its three steps after the kind; goal kinds answer one goal step instead. */
export const wizardSteps = (choice: ChallengeChoice): StepId[] => (choice === 'show_up' ? ['kind', 'what', 'when', 'pledge'] : ['kind', 'goal', 'pledge']);

export function stepTitle(step: StepId, choice: ChallengeChoice): string {
  switch (step) {
    case 'kind':
      return 'What kind of challenge?';
    case 'what':
      return "What's the pact?";
    case 'when':
      return 'When?';
    case 'pledge':
      return 'Pledge';
    case 'goal':
      switch (challengeOption(choice).kind) {
        case 'distance':
          return 'How far?';
        case 'workouts':
          return 'How many?';
        case 'steps':
          return 'How many steps?';
        default:
          return 'What counts?';
      }
  }
}

/** Default goals when a kind is picked: miles or kilometres a week, sessions a week, steps a day. */
const DEFAULT_GOAL: Record<Exclude<ChallengeChoice, 'show_up' | 'custom'>, { mi: string; km: string }> = {
  run: { mi: '15', km: '25' },
  ride: { mi: '50', km: '80' },
  walk: { mi: '20', km: '30' },
  workouts: { mi: '3', km: '3' },
  steps: { mi: '10000', km: '10000' },
};

/** The coming Saturday (today if it is one) and the day after: a race weekend. */
export function defaultRace(today: string): { start: string; end: string } {
  const start = addDaysToLocalDate(today, (6 - isoWeekday(today) + 7) % 7);
  return { start, end: addDaysToLocalDate(start, 1) };
}

/** Step 0 picked a kind: keep a typed goal when it is the same kind of number, else fill the default. */
export function selectChoice(d: WizardDraft, choice: ChallengeChoice, today: string): WizardDraft {
  const before = challengeOption(d.choice).kind;
  const after = challengeOption(choice).kind;
  const keep = d.goalText.trim() !== '' && before === after;
  const goalText = choice === 'show_up' || choice === 'custom' ? '' : keep ? d.goalText : DEFAULT_GOAL[choice][d.unit];
  const race = d.raceStart && d.raceEnd ? { start: d.raceStart, end: d.raceEnd } : defaultRace(today);
  return { ...d, choice, goalText, raceStart: race.start, raceEnd: race.end };
}

export const parseGoalNumber = (text: string): number | null => {
  const t = text.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const thousands = (n: number): string => n.toLocaleString('en-US');
const unitWord = (unit: DistanceUnit): string => (unit === 'mi' ? 'miles' : 'km');

/** "15 miles a week", "13.1 miles by Nov 15", "3 workouts a week", "10,000 steps a day"; empty for show up and custom. */
export function suggestedTitle(d: WizardDraft): string {
  const kind = challengeOption(d.choice).kind;
  const n = parseGoalNumber(d.goalText);
  if (n === null) return '';
  switch (kind) {
    case 'distance':
      return d.goalPeriod === 'once' ? `${d.goalText.trim()} ${unitWord(d.unit)} by ${formatLocalDateShort(d.raceEnd)}` : `${d.goalText.trim()} ${unitWord(d.unit)} a week`;
    case 'workouts':
      return `${n} workout${n === 1 ? '' : 's'} a week`;
    case 'steps':
      return `${thousands(n)} steps a day`;
    default:
      return '';
  }
}

export interface GoalErrors {
  title?: string;
  goal?: string;
  race?: string;
  types?: string;
  days?: string;
}

export function validateGoal(d: WizardDraft, today: string): GoalErrors {
  const kind = challengeOption(d.choice).kind;
  const n = parseGoalNumber(d.goalText);
  switch (kind) {
    case 'distance': {
      if (n === null) return { goal: 'Enter a distance like 15.' };
      if (n < 0.1 || n > 1000) return { goal: `Between 0.1 and 1,000 ${d.unit}.` };
      if (d.goalPeriod === 'once') {
        if (d.raceStart > d.raceEnd) return { race: 'The race has to start before it ends.' };
        if (d.raceEnd < today) return { race: 'The race has to end today or later.' };
      }
      return {};
    }
    case 'workouts':
      if (n === null || !Number.isInteger(n) || n < 1 || n > 14) return { goal: 'Between 1 and 14 workouts a week.' };
      if (d.workoutTypes.length === 0) return { types: 'Pick at least one kind of workout.' };
      return {};
    case 'steps':
      if (n === null || n < 1000 || n > 100_000) return { goal: 'Between 1,000 and 100,000 steps a day.' };
      if (d.days.length === 0) return { days: 'Pick at least one day.' };
      return {};
    case 'custom':
      if (d.title.trim().length < 2) return { title: 'Say what counts, like "Read 20 pages".' };
      if (d.customPeriod === 'daily' && d.days.length === 0) return { days: 'Pick at least one day.' };
      return {};
    default:
      return {};
  }
}

/** Weekly and all-day instances get an all-day window; the server derives the week itself (spec). */
const ALL_DAY_OPEN = '00:00:00';
const ALL_DAY_DEADLINE = '23:59:00';

/** What `create_pact` is called with. Pure, so every kind's mapping is tested. */
export function draftToCreateInput(d: WizardDraft, groupId: string): CreatePactInput {
  const option = challengeOption(d.choice);
  const title = d.title.trim() || suggestedTitle(d);
  const n = parseGoalNumber(d.goalText) ?? 0;
  const days = [...d.days].sort((a, b) => a - b);
  const base = {
    groupId,
    title,
    stakeCents: parseDollarsToCents(d.dollars) ?? 0,
    tz: d.tz,
    activityTypes: option.activityTypes,
    raceStart: null,
    raceEnd: null,
    needsPhoto: false,
  };
  switch (option.kind) {
    case 'distance': {
      const once = d.goalPeriod === 'once';
      return {
        ...base,
        days: null,
        windowOpen: ALL_DAY_OPEN,
        deadline: ALL_DAY_DEADLINE,
        kind: 'distance',
        period: once ? 'once' : 'weekly',
        goalValue: unitToMeters(n, d.unit),
        goalUnit: 'm',
        raceStart: once ? d.raceStart : null,
        raceEnd: once ? d.raceEnd : null,
      };
    }
    case 'workouts':
      return { ...base, days: null, windowOpen: ALL_DAY_OPEN, deadline: ALL_DAY_DEADLINE, kind: 'workouts', period: 'weekly', goalValue: n, goalUnit: 'count', activityTypes: [...d.workoutTypes] };
    case 'steps':
      return { ...base, days, windowOpen: ALL_DAY_OPEN, deadline: ALL_DAY_DEADLINE, kind: 'steps', period: 'daily', goalValue: n, goalUnit: 'steps', activityTypes: null };
    case 'custom':
      return {
        ...base,
        days: d.customPeriod === 'weekly' ? null : days,
        windowOpen: ALL_DAY_OPEN,
        deadline: ALL_DAY_DEADLINE,
        kind: 'custom',
        period: d.customPeriod,
        goalValue: 1,
        goalUnit: 'count',
        activityTypes: null,
        needsPhoto: d.needsPhoto,
      };
    default:
      return {
        ...base,
        days,
        windowOpen: toPgTime(Math.max(0, draftWindowOpen(d))),
        deadline: toPgTime(d.deadline),
        kind: 'show_up',
        period: 'daily',
        goalValue: null,
        goalUnit: null,
        activityTypes: null,
      };
  }
}

const SETTLE = 'Balances settle up weekly on Venmo.';
const POOL_MADE_IT = 'goes to the pool for the friends who made it.';

/** The pledge step's summary sentence, in the pact's own numbers. */
export function pledgeSentence(d: WizardDraft, stakeCents: number): string {
  const option = challengeOption(d.choice);
  const money = formatCents(stakeCents);
  const n = parseGoalNumber(d.goalText) ?? 0;
  switch (option.kind) {
    case 'distance': {
      const dist = `${n.toFixed(1)} ${d.unit}`;
      return d.goalPeriod === 'once'
        ? `Fall short of ${dist} by ${formatLocalDateShort(d.raceEnd)} and your ${money} ${POOL_MADE_IT} ${SETTLE}`
        : `Miss ${dist} in a week and your ${money} ${POOL_MADE_IT} ${SETTLE}`;
    }
    case 'workouts':
      return `Miss ${n} workout${n === 1 ? '' : 's'} in a week and your ${money} ${POOL_MADE_IT} ${SETTLE}`;
    case 'steps':
      return `Miss ${thousands(n)} steps on a day and your ${money} ${POOL_MADE_IT} ${SETTLE}`;
    case 'custom':
      return `Miss a ${d.customPeriod === 'weekly' ? 'week' : 'day'} and your ${money} goes to the pool for the friends who didn't. ${SETTLE}`;
    default:
      return `Miss a day and your pledge is forfeited to the pool, which is split among everyone who showed up. If nobody shows up, the pool carries over. ${SETTLE}`;
  }
}

/** The amount field's label: what one forfeit is for. */
export function pledgeFieldLabel(d: Pick<WizardDraft, 'choice' | 'goalPeriod' | 'customPeriod'>): string {
  const kind = challengeOption(d.choice).kind;
  if (kind === 'distance') return d.goalPeriod === 'once' ? 'If you fall short' : 'Per missed week';
  if (kind === 'workouts') return 'Per missed week';
  if (kind === 'custom' && d.customPeriod === 'weekly') return 'Per missed week';
  return 'Per missed day';
}

/** The period and what counts, in one line under the summary card's title (the title already says the goal). */
export function goalSummaryLine(d: WizardDraft): string {
  const option = challengeOption(d.choice);
  const counts = option.activityTypes ? option.activityTypes.map((t) => `${t === 'running' ? 'run' : t === 'cycling' ? 'ride' : t === 'walking' ? 'walk' : t}s`).join(' and ') : '';
  switch (option.kind) {
    case 'distance':
      return d.goalPeriod === 'once'
        ? `${formatLocalDateShort(d.raceStart)} to ${formatLocalDateShort(d.raceEnd)} · ${counts} count`
        : `Monday to Sunday night, every week · ${counts} count`;
    case 'workouts':
      return `Monday to Sunday night, every week · ${d.workoutTypes.length === ALL_WORKOUT_TYPES.length ? 'any workout of ten minutes or more' : `${d.workoutTypes.length} kinds of workout`}`;
    case 'steps':
      return `${describeDaysShort(d.days)} · counted at midnight`;
    case 'custom':
      return `Marked done each ${d.customPeriod === 'weekly' ? 'week' : 'day'}${d.needsPhoto ? ', with a photo' : ''}`;
    default:
      return '';
  }
}

const describeDaysShort = (days: readonly number[]): string => {
  const key = [...days].sort((a, b) => a - b).join(',');
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '6,7') return 'Weekends';
  if (key === '1,2,3,4,5,6,7') return 'Every day';
  return `${days.length} day${days.length === 1 ? '' : 's'} a week`;
};

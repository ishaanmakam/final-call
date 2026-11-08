import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_OPTIONS,
  DEFAULT_DRAFT,
  draftToCreateInput,
  isDraftDirty,
  pledgeFieldLabel,
  pledgeSentence,
  selectChoice,
  stepTitle,
  suggestedTitle,
  validateGoal,
  wizardSteps,
} from './wizard';

const today = '2026-11-13'; // a Friday

describe('challenge kinds (CB)', () => {
  it('offers seven choices, each mapped to a kind and its activity types', () => {
    expect(CHALLENGE_OPTIONS.map((o) => o.id)).toEqual(['show_up', 'run', 'ride', 'walk', 'workouts', 'steps', 'custom']);
    expect(CHALLENGE_OPTIONS.map((o) => o.title)).toEqual(['Show up', 'Run', 'Ride', 'Walk', 'Workouts', 'Steps', 'Custom']);
    const byId = Object.fromEntries(CHALLENGE_OPTIONS.map((o) => [o.id, o]));
    expect(byId.run).toMatchObject({ kind: 'distance', activityTypes: ['running'] });
    expect(byId.ride).toMatchObject({ kind: 'distance', activityTypes: ['cycling'] });
    expect(byId.walk).toMatchObject({ kind: 'distance', activityTypes: ['walking', 'running'] });
    expect(byId.workouts).toMatchObject({ kind: 'workouts' });
    expect(byId.steps).toMatchObject({ kind: 'steps', activityTypes: null });
    expect(byId.custom).toMatchObject({ kind: 'custom', activityTypes: null });
    expect(byId.show_up).toMatchObject({ kind: 'show_up', activityTypes: null });
    for (const o of CHALLENGE_OPTIONS) expect(o.gloss.length).toBeGreaterThan(10);
  });

  it('show up keeps its three steps; goal kinds get a goal step instead of what + when', () => {
    expect(wizardSteps('show_up')).toEqual(['kind', 'what', 'when', 'pledge']);
    expect(wizardSteps('run')).toEqual(['kind', 'goal', 'pledge']);
    expect(wizardSteps('custom')).toEqual(['kind', 'goal', 'pledge']);
    expect(stepTitle('kind', 'run')).toBe('What kind of challenge?');
    expect(stepTitle('goal', 'run')).toBe('How far?');
    expect(stepTitle('goal', 'workouts')).toBe('How many?');
    expect(stepTitle('goal', 'steps')).toBe('How many steps?');
    expect(stepTitle('goal', 'custom')).toBe('What counts?');
    expect(stepTitle('pledge', 'run')).toBe('Pledge');
  });

  it('picking a kind fills a sensible default goal in the device unit and a suggested title', () => {
    const mi = { ...DEFAULT_DRAFT, unit: 'mi' as const };
    expect(selectChoice(mi, 'run', today).goalText).toBe('15');
    expect(selectChoice({ ...mi, unit: 'km' }, 'run', today).goalText).toBe('25');
    expect(selectChoice(mi, 'ride', today).goalText).toBe('50');
    expect(selectChoice(mi, 'walk', today).goalText).toBe('20');
    expect(selectChoice(mi, 'workouts', today).goalText).toBe('3');
    expect(selectChoice(mi, 'steps', today).goalText).toBe('10000');
    expect(selectChoice(mi, 'custom', today).goalText).toBe('');
    // a goal the person typed survives switching between distance kinds
    expect(selectChoice({ ...mi, choice: 'run', goalText: '12' }, 'walk', today).goalText).toBe('12');
    expect(selectChoice({ ...mi, choice: 'run', goalText: '12' }, 'workouts', today).goalText).toBe('3');
    // the race defaults to the coming Saturday and Sunday
    const run = selectChoice(mi, 'run', today);
    expect(run.raceStart).toBe('2026-11-14');
    expect(run.raceEnd).toBe('2026-11-15');
    expect(suggestedTitle(run)).toBe('15 miles a week');
    expect(suggestedTitle(selectChoice({ ...mi, unit: 'km' }, 'run', today))).toBe('25 km a week');
    expect(suggestedTitle({ ...run, goalPeriod: 'once', goalText: '13.1' })).toBe('13.1 miles by Nov 15');
    expect(suggestedTitle(selectChoice(mi, 'workouts', today))).toBe('3 workouts a week');
    expect(suggestedTitle(selectChoice(mi, 'steps', today))).toBe('10,000 steps a day');
    expect(suggestedTitle(selectChoice(mi, 'custom', today))).toBe('');
  });

  it('validates the goal step per kind', () => {
    const run = selectChoice({ ...DEFAULT_DRAFT, unit: 'mi' }, 'run', today);
    expect(validateGoal(run, today)).toEqual({});
    expect(validateGoal({ ...run, goalText: '' }, today)).toEqual({ goal: 'Enter a distance like 15.' });
    expect(validateGoal({ ...run, goalText: '0' }, today)).toEqual({ goal: 'Between 0.1 and 1,000 mi.' });
    expect(validateGoal({ ...run, goalText: '1001' }, today)).toEqual({ goal: 'Between 0.1 and 1,000 mi.' });
    expect(validateGoal({ ...run, goalPeriod: 'once', raceStart: '2026-11-20', raceEnd: '2026-11-19' }, today)).toEqual({ race: 'The race has to start before it ends.' });
    expect(validateGoal({ ...run, goalPeriod: 'once', raceStart: '2026-11-10', raceEnd: '2026-11-12' }, today)).toEqual({ race: 'The race has to end today or later.' });
    expect(validateGoal({ ...run, goalPeriod: 'once' }, today)).toEqual({});
    const workouts = selectChoice(DEFAULT_DRAFT, 'workouts', today);
    expect(validateGoal(workouts, today)).toEqual({});
    expect(validateGoal({ ...workouts, goalText: '15' }, today)).toEqual({ goal: 'Between 1 and 14 workouts a week.' });
    expect(validateGoal({ ...workouts, goalText: '2.5' }, today)).toEqual({ goal: 'Between 1 and 14 workouts a week.' });
    expect(validateGoal({ ...workouts, workoutTypes: [] }, today)).toEqual({ types: 'Pick at least one kind of workout.' });
    const steps = selectChoice(DEFAULT_DRAFT, 'steps', today);
    expect(validateGoal(steps, today)).toEqual({});
    expect(validateGoal({ ...steps, goalText: '500' }, today)).toEqual({ goal: 'Between 1,000 and 100,000 steps a day.' });
    expect(validateGoal({ ...steps, days: [] }, today)).toEqual({ days: 'Pick at least one day.' });
    const custom = selectChoice(DEFAULT_DRAFT, 'custom', today);
    expect(validateGoal(custom, today)).toEqual({ title: 'Say what counts, like "Read 20 pages".' });
    expect(validateGoal({ ...custom, title: 'Read 20 pages' }, today)).toEqual({});
    expect(validateGoal({ ...custom, title: 'Read 20 pages', days: [] }, today)).toEqual({ days: 'Pick at least one day.' });
    expect(validateGoal({ ...custom, title: 'Read 20 pages', customPeriod: 'weekly', days: [] }, today)).toEqual({});
  });

  it('builds the create_pact input: metres, count or steps; weekly sends no days and an all-day window', () => {
    const run = selectChoice({ ...DEFAULT_DRAFT, unit: 'mi', tz: 'America/Los_Angeles' }, 'run', today);
    expect(draftToCreateInput(run, 'g1')).toEqual({
      groupId: 'g1',
      title: '15 miles a week',
      days: null,
      windowOpen: '00:00:00',
      deadline: '23:59:00',
      stakeCents: 500,
      tz: 'America/Los_Angeles',
      kind: 'distance',
      period: 'weekly',
      goalValue: 24140,
      goalUnit: 'm',
      activityTypes: ['running'],
      raceStart: null,
      raceEnd: null,
      needsPhoto: false,
    });
    expect(draftToCreateInput({ ...run, title: 'Sunday long runs', goalPeriod: 'once' }, 'g1')).toMatchObject({
      title: 'Sunday long runs',
      period: 'once',
      raceStart: '2026-11-14',
      raceEnd: '2026-11-15',
    });
    expect(draftToCreateInput({ ...selectChoice(DEFAULT_DRAFT, 'workouts', today), workoutTypes: ['strength', 'yoga'] }, 'g1')).toMatchObject({
      kind: 'workouts',
      period: 'weekly',
      goalValue: 3,
      goalUnit: 'count',
      activityTypes: ['strength', 'yoga'],
      days: null,
    });
    expect(draftToCreateInput(selectChoice({ ...DEFAULT_DRAFT, days: [1, 3, 5] }, 'steps', today), 'g1')).toMatchObject({
      kind: 'steps',
      period: 'daily',
      goalValue: 10000,
      goalUnit: 'steps',
      activityTypes: null,
      days: [1, 3, 5],
      windowOpen: '00:00:00',
      deadline: '23:59:00',
    });
    expect(draftToCreateInput({ ...selectChoice(DEFAULT_DRAFT, 'custom', today), title: 'Read 20 pages', needsPhoto: true }, 'g1')).toMatchObject({
      kind: 'custom',
      period: 'daily',
      goalValue: 1,
      goalUnit: 'count',
      days: [1, 2, 3, 4, 5],
      needsPhoto: true,
    });
    // show up is untouched: the seven original fields plus the defaults
    expect(draftToCreateInput({ ...DEFAULT_DRAFT, title: '9am class', tz: 'America/Los_Angeles' }, 'g1')).toMatchObject({
      kind: 'show_up',
      period: 'daily',
      days: [1, 2, 3, 4, 5],
      windowOpen: '08:00:00',
      deadline: '09:00:00',
      goalValue: null,
      activityTypes: null,
    });
  });

  it('pledge copy adapts to the kind and the period', () => {
    const run = selectChoice({ ...DEFAULT_DRAFT, unit: 'mi' }, 'run', today);
    expect(pledgeSentence(run, 500)).toBe('Miss 15.0 mi in a week and your $5.00 goes to the pool for the friends who made it. Balances settle up weekly on Venmo.');
    expect(pledgeSentence({ ...run, goalPeriod: 'once', goalText: '13.1' }, 500)).toBe(
      'Fall short of 13.1 mi by Nov 15 and your $5.00 goes to the pool for the friends who made it. Balances settle up weekly on Venmo.',
    );
    expect(pledgeSentence(selectChoice(DEFAULT_DRAFT, 'workouts', today), 250)).toBe(
      'Miss 3 workouts in a week and your $2.50 goes to the pool for the friends who made it. Balances settle up weekly on Venmo.',
    );
    expect(pledgeSentence(selectChoice(DEFAULT_DRAFT, 'steps', today), 100)).toBe(
      'Miss 10,000 steps on a day and your $1.00 goes to the pool for the friends who made it. Balances settle up weekly on Venmo.',
    );
    expect(pledgeSentence(selectChoice(DEFAULT_DRAFT, 'custom', today), 100)).toBe(
      "Miss a day and your $1.00 goes to the pool for the friends who didn't. Balances settle up weekly on Venmo.",
    );
    expect(pledgeSentence(DEFAULT_DRAFT, 500)).toMatch(/^Miss a day and your pledge is forfeited to the pool/);
    expect(pledgeFieldLabel(DEFAULT_DRAFT)).toBe('Per missed day');
    expect(pledgeFieldLabel(run)).toBe('Per missed week');
    expect(pledgeFieldLabel({ ...run, goalPeriod: 'once' })).toBe('If you fall short');
    expect(pledgeFieldLabel(selectChoice(DEFAULT_DRAFT, 'steps', today))).toBe('Per missed day');
  });

  it('kind changes make the draft dirty', () => {
    expect(isDraftDirty(selectChoice(DEFAULT_DRAFT, 'run', today))).toBe(true);
    expect(isDraftDirty(selectChoice(DEFAULT_DRAFT, 'show_up', today))).toBe(false);
  });
});

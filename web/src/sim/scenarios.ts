import {
  castVote,
  checkIn,
  createWorld,
  instanceById,
  openReview,
  setBehaviour,
  setGps,
  setLocationMode,
  setOnline,
  transition,
} from './engine';
import type { Behaviour, FriendId, MemberId, World } from './types';

export type ScenarioName = 'typical_week' | 'carry' | 'gps_trouble' | 'drama_week';

export interface ScenarioStep {
  label: string;
  apply: (w: World) => World;
}

export interface Scenario {
  name: ScenarioName;
  title: string;
  summary: string;
  steps: ScenarioStep[];
}

const friends = (b: Partial<Record<FriendId, Behaviour>>) => (w: World) => {
  let out = w;
  for (const [id, beh] of Object.entries(b) as [FriendId, Behaviour][]) out = setBehaviour(out, id, beh);
  return out;
};
const gps = (dx: number, dy: number, accuracyM: number) => (w: World) => setGps(w, { dx, dy, accuracyM });
const tap = (w: World) => checkIn(w).world;
const go = (t: Parameters<typeof transition>[1]) => (w: World) => transition(w, t);
const inst = (date: string) => `inst-${date}`;
const vote = (date: string, subject: MemberId, voter: MemberId, supports: boolean) => (w: World) => {
  const review = w.reviews.find((r) => r.instanceId === inst(date) && r.subject === subject && r.status === 'open');
  return review ? castVote(w, review.id, voter, supports) : w;
};
const review = (date: string, subject: MemberId, kind: 'appeal' | 'challenge', openedBy: MemberId, reason: string) => (w: World) =>
  openReview(w, inst(date), subject, kind, openedBy, reason);

const pipe =
  (...fns: ((w: World) => World)[]) =>
  (w: World) =>
    fns.reduce((acc, f) => f(acc), w);

export const SCENARIOS: Record<ScenarioName, Scenario> = {
  typical_week: {
    name: 'typical_week',
    title: 'Typical week',
    summary: 'Five days of mostly showing up: one no-show, one weak-GPS day, one out-of-fence tap you fix, then Monday noon.',
    steps: [
      { label: 'Mon: everyone on time', apply: pipe(friends({ maya: 'on_time', diego: 'on_time', priya: 'on_time' }), go('next_window'), gps(0, 0, 12), tap, go('gate_closed')) },
      { label: 'Tue: Diego sleeps in', apply: pipe(friends({ diego: 'no_show' }), go('next_window'), tap, go('gate_closed')) },
      { label: 'Wed: Priya has no GPS', apply: pipe(friends({ diego: 'on_time', priya: 'no_gps' }), go('next_window'), tap, go('gate_closed')) },
      {
        label: 'Thu: you tap outside, then inside; Diego stays outside',
        apply: pipe(friends({ priya: 'on_time', diego: 'out_of_fence' }), go('next_window'), gps(140, 0, 12), tap, gps(10, -5, 12), tap, go('gate_closed')),
      },
      { label: 'Fri: everyone on time', apply: pipe(friends({ diego: 'on_time' }), go('next_window'), tap, go('gate_closed')) },
      { label: 'Mon: you show up again; noon: settle up', apply: pipe(go('next_window'), tap, go('monday_noon')) },
    ],
  },
  carry: {
    name: 'carry',
    title: 'Everyone sleeps in → carry',
    summary: 'Tuesday nobody shows up, so four pledges roll into the carry; Wednesday two people show up and split it.',
    steps: [
      { label: 'Mon: everyone on time', apply: pipe(friends({ maya: 'on_time', diego: 'on_time', priya: 'on_time' }), go('next_window'), gps(0, 0, 12), tap, go('gate_closed')) },
      {
        label: 'Tue: nobody shows up (your location is off)',
        apply: pipe(friends({ maya: 'no_show', diego: 'no_show', priya: 'no_show' }), setLocationModeStep('denied'), go('next_window'), tap, go('gate_closed')),
      },
      {
        label: 'Wed: you and Maya show up and split the carry',
        apply: pipe(setLocationModeStep('precise'), friends({ maya: 'on_time' }), go('next_window'), tap, go('gate_closed')),
      },
      { label: 'Thu: everyone on time', apply: pipe(friends({ diego: 'on_time', priya: 'on_time' }), go('next_window'), tap, go('gate_closed')) },
      { label: 'Fri: everyone on time', apply: pipe(go('next_window'), tap, go('gate_closed')) },
      { label: 'Mon: you show up again; noon: settle up', apply: pipe(go('next_window'), tap, go('monday_noon')) },
    ],
  },
  gps_trouble: {
    name: 'gps_trouble',
    title: 'GPS trouble',
    summary: 'Three unverified days in a row for you; the third opens an automatic challenge the group votes on.',
    steps: [
      { label: 'Mon: your GPS is ±350 m', apply: pipe(friends({ maya: 'on_time', diego: 'on_time', priya: 'on_time' }), go('next_window'), gps(0, 0, 350), tap, go('gate_closed')) },
      { label: 'Tue: still ±350 m', apply: pipe(go('next_window'), tap, go('gate_closed')) },
      { label: 'Wed: third unverified day → automatic challenge', apply: pipe(go('next_window'), tap, go('gate_closed')) },
      { label: 'Maya and Diego vote', apply: pipe(vote('2026-11-11', 'you', 'maya', true), vote('2026-11-11', 'you', 'diego', false)) },
      { label: "Thu: clear sky, you're in", apply: pipe(go('next_window'), gps(0, 0, 12), tap, go('gate_closed')) },
      { label: 'Priya breaks the tie: challenge upheld, correction posted', apply: vote('2026-11-11', 'you', 'priya', true) },
      { label: 'Fri: everyone on time', apply: pipe(go('next_window'), tap, go('gate_closed')) },
      { label: 'Mon: you show up again; noon: settle up', apply: pipe(go('next_window'), tap, go('monday_noon')) },
    ],
  },
  drama_week: {
    name: 'drama_week',
    title: 'Drama week',
    summary: 'An appeal that wins, a challenge that ties, an offline tap that lands late, and the corrections each one posts.',
    steps: [
      {
        label: 'Mon: Diego taps outside his circle and appeals',
        apply: pipe(
          friends({ maya: 'on_time', diego: 'out_of_fence', priya: 'on_time' }),
          go('next_window'),
          gps(0, 0, 12),
          tap,
          go('gate_closed'),
          review('2026-11-09', 'diego', 'appeal', 'diego', 'I was in the back row of the HUB; GPS put me across the street. Photo attached.'),
        ),
      },
      { label: 'You and Maya vote: he showed up → appeal upheld, correction', apply: pipe(vote('2026-11-09', 'diego', 'you', true), vote('2026-11-09', 'diego', 'maya', true)) },
      {
        label: 'Tue: Priya is unverified; Maya challenges',
        apply: pipe(
          friends({ diego: 'on_time', priya: 'no_gps' }),
          go('next_window'),
          tap,
          go('gate_closed'),
          review('2026-11-10', 'priya', 'challenge', 'maya', 'Priya was in Portland on Tuesday, she told me herself.'),
        ),
      },
      { label: 'You and Diego split the vote (tie: waits for Monday)', apply: pipe(vote('2026-11-10', 'priya', 'you', true), vote('2026-11-10', 'priya', 'diego', false)) },
      {
        label: 'Wed: you tap offline; it lands after the gate closes',
        apply: pipe(friends({ priya: 'on_time' }), go('next_window'), (w) => setOnline(w, false), tap, go('gate_closed'), (w) => setOnline(w, true)),
      },
      {
        label: 'Thu: Diego sleeps in; Maya taps offline and lands late',
        apply: pipe(friends({ maya: 'late_offline', diego: 'no_show' }), go('next_window'), tap, go('gate_closed')),
      },
      { label: 'Fri: everyone on time (Maya\'s late tap has landed)', apply: pipe(friends({ maya: 'on_time', diego: 'on_time' }), go('next_window'), tap, go('gate_closed')) },
      { label: 'Mon: you show up again; noon: the tie defaults, settle up', apply: pipe(go('next_window'), tap, go('monday_noon')) },
    ],
  },
};

function setLocationModeStep(mode: 'precise' | 'approximate' | 'denied') {
  return (w: World) => setLocationMode(w, mode);
}

export const SCENARIO_ORDER: ScenarioName[] = ['typical_week', 'carry', 'gps_trouble', 'drama_week'];

/** Run a whole scenario from a fresh world, yielding the world after each step. */
export function runScenario(name: ScenarioName, from: World = createWorld()): World[] {
  const out: World[] = [];
  let w = from;
  for (const step of SCENARIOS[name].steps) {
    w = step.apply(w);
    out.push(w);
  }
  return out;
}

export { instanceById };

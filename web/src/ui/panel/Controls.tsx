import { DateTime } from 'luxon';
import {
  FRIEND_IDS,
  SCENARIOS,
  SCENARIO_ORDER,
  TRANSITION_LABEL,
  fmtClock,
  fmtCountdown,
  focusInstance,
  memberById,
  phaseOf,
  transitionTarget,
  type Behaviour,
  type LocationMode,
  type Transition,
} from '../../sim';
import { actions, useStore, useWorld } from '../store';

const BEHAVIOURS: { value: Behaviour; label: string }[] = [
  { value: 'on_time', label: 'On time' },
  { value: 'out_of_fence', label: 'Taps outside the circle' },
  { value: 'no_show', label: 'No show' },
  { value: 'no_gps', label: 'Weak GPS (±350 m)' },
  { value: 'late_offline', label: 'Offline tap, lands late' },
  { value: 'frozen', label: 'Frozen (declared before)' },
];

const MODES: { value: LocationMode; label: string }[] = [
  { value: 'precise', label: 'Precise' },
  { value: 'approximate', label: 'Approximate' },
  { value: 'denied', label: 'Denied' },
];

const TRANSITIONS: Transition[] = ['next_window', 'final_call', 'gate_closed', 'next_day', 'monday_noon'];

export function YouControls() {
  const w = useWorld();
  return (
    <section className="panel" aria-labelledby="you-h">
      <h2 id="you-h">
        You <span className="hint">how your phone is set up</span>
      </h2>
      <div className="switch-row">
        <div className="labels">
          <span>Online</span>
          <span className="t-footnote c-secondary">{w.you.online ? 'Taps reach the server at once' : 'Taps are saved and sent when you go back online'}</span>
        </div>
        <button type="button" role="switch" aria-checked={w.you.online} aria-label="Online" className="switch" onClick={() => actions.setOnline(!w.you.online)} />
      </div>
      <div className="field">
        <span id="loc-mode-label">Location</span>
        <div className="segmented" role="radiogroup" aria-labelledby="loc-mode-label">
          {MODES.map((m) => (
            <button key={m.value} type="button" role="radio" aria-checked={w.you.locationMode === m.value} onClick={() => actions.setLocationMode(m.value)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <p className="t-footnote c-secondary">
        {w.you.locationMode === 'precise'
          ? 'Precise Location on: the fix above is what gets judged.'
          : w.you.locationMode === 'approximate'
            ? 'Approximate Location (about a kilometre): the app refuses to send it, so a tap counts as nothing. Not a tracking failure, so Missed, not Unverified.'
            : 'Location denied: nothing can be sent; the day is Missed unless you freeze it first.'}
      </p>
    </section>
  );
}

export function FriendControls() {
  const w = useWorld();
  return (
    <section className="panel" aria-labelledby="friends-h">
      <h2 id="friends-h">
        Friends <span className="hint">takes effect at the next Boarding</span>
      </h2>
      {FRIEND_IDS.map((id) => {
        const m = memberById(w, id);
        return (
          <div className="field" key={id}>
            <label htmlFor={`beh-${id}`}>
              {m.name} <span className="t-footnote c-secondary">· {m.place.label}, {m.place.radiusM} m</span>
            </label>
            <select id={`beh-${id}`} className="select" value={w.behaviours[id]} onChange={(e) => actions.setBehaviour(id, e.target.value as Behaviour)}>
              {BEHAVIOURS.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </section>
  );
}

export function ClockControls() {
  const w = useWorld();
  const inst = focusInstance(w);
  const phase = inst ? phaseOf(w, inst) : null;
  const tz = w.pact.tz;
  const phaseWord = !inst ? '' : phase === 'before' ? `Boarding in ${fmtCountdown(inst.windowOpenAt - w.now)}` : phase === 'boarding' ? `Boarding · ${fmtCountdown(inst.deadlineAt - w.now)} left` : phase === 'final_call' ? `Final call · ${fmtCountdown(inst.deadlineAt - w.now)} left` : 'Gate closed';
  return (
    <section className="panel" aria-labelledby="clock-h">
      <h2 id="clock-h">
        Clock <span className="hint">jumps the whole group forward</span>
      </h2>
      <div className="row between">
        <span className="t-headline tabular">{fmtClock(w.now, tz)}</span>
        <span className="t-subheadline c-tint semibold">{phaseWord}</span>
      </div>
      <div className="transitions">
        {TRANSITIONS.map((t) => {
          const target = transitionTarget(w, t);
          const isNext = nextMoment(w, inst, phase) === t;
          return (
            <button key={t} type="button" className={`btn ${isNext ? 'primary' : ''}`} disabled={target === null} onClick={() => actions.transition(t)} aria-label={`${TRANSITION_LABEL[t]}${target ? `, ${DateTime.fromMillis(target, { zone: tz }).toFormat('cccc LLLL d, h:mm a')}` : ''}`}>
              {TRANSITION_LABEL[t]}
              <small>{target ? DateTime.fromMillis(target, { zone: tz }).toFormat('ccc d · h:mm a') : '—'}</small>
            </button>
          );
        })}
      </div>
      <p className="t-footnote c-secondary">Boarding opens the window; Final call is 15 minutes out; Gate closed judges everyone and moves the pool; Monday noon settles the week.</p>
    </section>
  );
}

function nextMoment(w: ReturnType<typeof useWorld>, inst: ReturnType<typeof focusInstance>, phase: ReturnType<typeof phaseOf> | null): Transition {
  if (!inst) return 'monday_noon';
  if (phase === 'before') return 'next_window';
  if (phase === 'boarding') return 'final_call';
  if (phase === 'final_call') return 'gate_closed';
  const dow = DateTime.fromMillis(w.now, { zone: w.pact.tz }).weekday;
  return dow === 5 ? 'monday_noon' : 'next_window';
}

export function ScenarioControls() {
  const sc = useStore((s) => s.scenario);
  const active = sc ? SCENARIOS[sc.name] : null;
  return (
    <section className="panel" aria-labelledby="scen-h">
      <h2 id="scen-h">
        Scenarios <span className="hint">preset weeks, one step at a time</span>
      </h2>
      <div className="scenario-list">
        {SCENARIO_ORDER.map((name) => {
          const s = SCENARIOS[name];
          return (
            <button key={name} type="button" className="scenario" aria-pressed={sc?.name === name} onClick={() => actions.startScenario(name)} title={s.summary}>
              <span className="title">{s.title}</span>
            </button>
          );
        })}
      </div>
      {active && sc ? (
        <>
          <p className="t-footnote c-secondary">{active.summary}</p>
          <ol className="steps" aria-label={`${active.title} steps`}>
            {active.steps.map((st, i) => (
              <li key={st.label} className={i < sc.step ? 'done' : i === sc.step ? 'next' : ''} aria-current={i === sc.step ? 'step' : undefined}>
                <span className="n">{i + 1}.</span>
                <span>{st.label}</span>
              </li>
            ))}
          </ol>
          <div className="row">
            <button type="button" className="btn primary small" disabled={sc.step >= active.steps.length} onClick={() => actions.nextScenarioStep()}>
              Next step
            </button>
            <button type="button" className="btn small" disabled={sc.step >= active.steps.length} onClick={() => actions.runScenarioToEnd()}>
              Run to the end
            </button>
            <button type="button" className="btn tertiary small" onClick={() => actions.reset()}>
              Reset world
            </button>
          </div>
        </>
      ) : (
        <div className="row between">
          <span className="t-footnote c-secondary">Pick a week to play it step by step, or drive the clock yourself.</span>
          <button type="button" className="btn tertiary xsmall" onClick={() => actions.reset()}>
            Reset world
          </button>
        </div>
      )}
    </section>
  );
}

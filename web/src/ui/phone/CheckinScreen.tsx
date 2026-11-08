import { AnimatePresence, motion } from 'motion/react';
import {
  APPROXIMATE_ACCURACY_M,
  fmtCountdown,
  fmtDayShort,
  fmtTime,
  focusInstance,
  hasFreeze,
  memberById,
  phaseOf,
  queuedCheckins,
  visibleCheckins,
  type Checkin,
  type Instance,
  type RefusedTap,
  type World,
} from '../../sim';
import { useEnter, useReducedMotion } from '../motion';
import { actions, useStore, useWorld } from '../store';
import { Card, Icon, PButton, Pill, ProgressRing, ResultPill, type PillTone } from './primitives';

type ButtonState = 'before' | 'idle' | 'locating' | 'success' | 'unverified' | 'forfeit' | 'closed' | 'frozen' | 'neutral';

interface Panel {
  headline: string;
  body: string;
  footnote?: string;
  pill?: { label: string; tone: PillTone };
  ghost?: { label: string; body: string; pill: { label: string; tone: PillTone } };
}

export function CheckinScreen() {
  const w = useWorld();
  const locating = useStore((s) => s.locating);
  const inst = focusInstance(w);
  if (!inst) return <div className="screen">No pact day.</div>;
  const phase = phaseOf(w, inst);
  const place = memberById(w, 'you').place;
  const mine = visibleCheckins(w, inst.id, 'you');
  const last = mine.at(-1) ?? null;
  const queued = queuedCheckins(w, inst.id);
  const refused = w.refusedTaps.filter((t) => t.instanceId === inst.id).at(-1) ?? null;
  const frozen = hasFreeze(w, inst.id, 'you');
  const inFence = mine.some((c) => c.verdict === 'in_fence' && c.serverReceivedAt! <= inst.deadlineAt);
  const closed = phase === 'closed';
  const lastEvent = latestAttempt(last, queued.at(-1) ?? null, refused);

  const state: ButtonState = closed
    ? 'closed'
    : frozen
      ? 'frozen'
      : locating
        ? 'locating'
        : phase === 'before'
          ? 'before'
          : inFence
            ? 'success'
            : 'idle';

  const ringColor =
    state === 'success'
      ? 'var(--success)'
      : lastEvent?.kind === 'checkin' && (lastEvent.c.verdict === 'out_of_fence' || lastEvent.c.verdict === 'unjudgeable')
        ? 'var(--unverified)'
        : lastEvent?.kind === 'queued'
          ? 'var(--unverified)'
          : state === 'closed'
            ? 'var(--fill-strong)'
            : phase === 'final_call'
              ? 'var(--forfeit)'
              : 'var(--tint)';
  const windowLen = inst.deadlineAt - inst.windowOpenAt;
  const progress = state === 'success' ? 1 : phase === 'before' || closed ? 0 : (inst.deadlineAt - w.now) / windowLen;
  const countdownMs = phase === 'before' ? inst.windowOpenAt - w.now : inst.deadlineAt - w.now;
  const panel = panelFor(w, inst, lastEvent, closed, frozen, place.label, place.radiusM);

  const label =
    state === 'before'
      ? `Opens in ${fmtCountdown(countdownMs)}`
      : state === 'locating'
        ? 'Finding you…'
        : state === 'success'
          ? "You're in"
          : state === 'closed'
            ? 'Closed'
            : state === 'frozen'
              ? 'Frozen'
              : 'Check in';

  return (
    <div className="screen">
      <div className="nav">
        <h1 style={{ fontSize: 22, lineHeight: '28px', letterSpacing: 0.35 }}>{w.pact.title}</h1>
      </div>
      <div className="content">
        <div className="checkin-hero">
          <span className="t-subheadline c-secondary">
            {fmtDayShort(inst.deadlineAt, w.pact.tz)} · {place.label} · {place.radiusM} m
          </span>
          <span className={`countdown ${phase === 'before' ? 'before' : ''} ${!closed && phase !== 'before' && countdownMs <= 60_000 ? 'last-minute' : ''}`} aria-label={closed ? 'Closed' : `${fmtCountdown(countdownMs)} ${phase === 'before' ? 'until it opens' : 'left'}`}>
            {closed ? '—' : fmtCountdown(countdownMs)}
          </span>
          <span className="t-subheadline c-secondary">{closed ? `Closed ${fmtTime(inst.deadlineAt, w.pact.tz)}` : phase === 'before' ? `until it opens · by ${fmtTime(inst.deadlineAt, w.pact.tz)}` : `left · by ${fmtTime(inst.deadlineAt, w.pact.tz)}`}</span>

          <div className="big-ring">
            <ProgressRing size={240} strokeWidth={6} progress={progress} color={ringColor} indeterminate={state === 'locating'} dashed={lastEvent?.kind === 'queued' && state !== 'success'} animate={state === 'success' ? 'spring' : 'step'} />
            <BigButton state={state} label={label} onTap={() => void actions.checkIn()} />
          </div>
          {!closed && state !== 'success' ? <p className="target-line t-subheadline">Your location is read once, when you tap.</p> : null}
        </div>

        <AnimatePresence mode="wait">
          {panel ? <VerdictPanelView key={panel.headline + (lastEvent?.id ?? '')} panel={panel} /> : null}
        </AnimatePresence>

        {closed && inst.results.you ? (
          <div>
            <h2 className="section-header">Today's result</h2>
            <Card>
              <div className="p-row" style={{ minHeight: 0 }}>
                <div className="main">
                  <span className="t-headline">{resultHeadline(inst)}</span>
                </div>
                <ResultPill status={inst.results.you.status} />
              </div>
            </Card>
          </div>
        ) : null}

        {mine.length + queued.length + w.refusedTaps.filter((t) => t.instanceId === inst.id).length > 0 ? (
          <div>
            <h2 className="section-header">Today's taps</h2>
            <Card className="list">
              {[...mine.map((c) => ({ at: c.serverReceivedAt!, c })), ...queued.map((c) => ({ at: c.clientCapturedAt, c }))]
                .sort((a, b) => a.at - b.at)
                .map(({ c }) => (
                  <div className="p-row" key={c.id}>
                    <div className="main">
                      <span className="t-body tabular">{fmtTime(c.clientCapturedAt, w.pact.tz)}</span>
                      <span className="t-subheadline c-secondary">GPS ±{c.accuracyM} m{c.serverReceivedAt === null ? ' · waiting for signal' : c.serverReceivedAt > inst.deadlineAt ? ` · reached us at ${fmtTime(c.serverReceivedAt, w.pact.tz)}` : ''}</span>
                    </div>
                    <TapPill c={c} inst={inst} />
                  </div>
                ))}
              {w.refusedTaps
                .filter((t) => t.instanceId === inst.id)
                .map((t) => (
                  <div className="p-row" key={t.id}>
                    <div className="main">
                      <span className="t-body tabular">{fmtTime(t.at, w.pact.tz)}</span>
                      <span className="t-subheadline c-secondary">{t.mode === 'approximate' ? 'Precise Location off · nothing sent' : 'Location off · nothing sent'}</span>
                    </div>
                    <Pill tone="pending">Not sent</Pill>
                  </div>
                ))}
            </Card>
          </div>
        ) : null}

        <div>
          <h2 className="section-header">Your place</h2>
          <Card className="list">
            <div className="p-row">
              <span className="c-tertiary">
                <Icon name="location" />
              </span>
              <div className="main">
                <span className="t-body">{place.label}</span>
                <span className="t-subheadline c-secondary">
                  {place.radiusM} m circle · by {fmtTime(inst.deadlineAt, w.pact.tz)}
                </span>
              </div>
            </div>
          </Card>
          <p className="section-footer" style={{ marginTop: 8 }}>
            Judged against the place in force when the window opened.
          </p>
        </div>
        {phase === 'before' && !frozen ? (
          <PButton variant="tertiary" onClick={() => actions.freezeToday()}>
            Freeze today
          </PButton>
        ) : null}
      </div>
    </div>
  );
}

function BigButton({ state, label, onTap }: { state: ButtonState; label: string; onTap: () => void }) {
  const reduced = useReducedMotion();
  const disabled = state !== 'idle' && state !== 'neutral';
  const cls = state === 'idle' ? '' : state;
  return (
    <button type="button" className={`big-button ${cls}`} disabled={disabled} aria-disabled={disabled} onClick={onTap} aria-live="polite">
      <span className="label-swap">
        {/* the label crossfades in (180 ms, the app's `state` duration); the old one leaves at once */}
        <motion.span key={label} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? 0 : 0.18 }}>
          {state === 'success' ? <Icon name="check" size={26} /> : null}
          {label}
        </motion.span>
      </span>
    </button>
  );
}

function VerdictPanelView({ panel }: { panel: Panel }) {
  const enter = useEnter('reveal');
  return (
    <motion.div {...enter}>
      <Card>
        {panel.pill ? <Pill tone={panel.pill.tone}>{panel.pill.label}</Pill> : null}
        <div aria-live="polite" aria-atomic="true">
          <div className="panel-headline" role="heading" aria-level={2}>
            {panel.headline}
          </div>
          <p className="t-callout" style={{ margin: '4px 0 0' }}>
            {panel.body}
          </p>
        </div>
        {panel.footnote ? <p className="t-footnote c-secondary" style={{ margin: 0 }}>{panel.footnote}</p> : null}
        {panel.ghost ? (
          <div className="ghost" style={{ borderTop: '1px solid var(--separator)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="t-footnote c-secondary">{panel.ghost.label}</span>
            <div className="p-row" style={{ minHeight: 0 }}>
              <span className="t-footnote" style={{ flex: 1 }}>
                {panel.ghost.body}
              </span>
              <Pill tone={panel.ghost.pill.tone} compact>
                {panel.ghost.pill.label}
              </Pill>
            </div>
          </div>
        ) : null}
      </Card>
    </motion.div>
  );
}

function TapPill({ c, inst }: { c: Checkin; inst: Instance }) {
  if (c.serverReceivedAt === null) return <Pill tone="unverified">Saved offline</Pill>;
  const late = c.serverReceivedAt > inst.deadlineAt;
  if (c.verdict === 'in_fence') return <Pill tone={late ? 'pending' : 'success'}>{late ? 'Late' : 'Checked in'}</Pill>;
  if (c.verdict === 'out_of_fence') return <Pill tone="unverified">Not there yet</Pill>;
  if (c.verdict === 'unjudgeable') return <Pill tone="unverified">Weak GPS</Pill>;
  return <Pill tone="forfeit">Rejected</Pill>;
}

type Attempt = { kind: 'checkin'; c: Checkin; id: string; at: number } | { kind: 'queued'; c: Checkin; id: string; at: number } | { kind: 'refused'; t: RefusedTap; id: string; at: number };

function latestAttempt(last: Checkin | null, queued: Checkin | null, refused: RefusedTap | null): Attempt | null {
  const list: Attempt[] = [];
  if (last) list.push({ kind: 'checkin', c: last, id: last.id, at: last.clientCapturedAt });
  if (queued) list.push({ kind: 'queued', c: queued, id: queued.id, at: queued.clientCapturedAt });
  if (refused) list.push({ kind: 'refused', t: refused, id: refused.id, at: refused.at });
  list.sort((a, b) => a.at - b.at);
  return list.at(-1) ?? null;
}

/** The app's `features/checkin/copy.ts`, for the sim's attempts. */
function panelFor(w: World, inst: Instance, a: Attempt | null, closed: boolean, frozen: boolean, placeLabel: string, radiusM: number): Panel | null {
  const tz = w.pact.tz;
  if (frozen && !closed) {
    return { headline: 'Frozen today', body: "You froze this day before it opened. It won't count for or against you, and there's nothing to tap.", pill: { label: 'Frozen', tone: 'frozen' } };
  }
  if (!a) return null;
  if (a.kind === 'refused') {
    const t = a.t;
    if (t.mode === 'approximate') {
      return {
        headline: 'Precise Location is off',
        body: `Final Call only gets your approximate location (about a kilometre), which can't be judged against your circle, so nothing was sent. In Settings → Final Call → Location, turn on Precise Location, then come back and tap Check in.`,
        footnote: 'This is a setting, not a tracking failure: without a tap that counts, today is missed.',
        ghost: {
          label: 'If the app had sent the fix anyway',
          body: `±${APPROXIMATE_ACCURACY_M} m is past the 200 m limit: unjudgeable, so the rules would say Unverified and no money would move.`,
          pill: { label: 'Unverified', tone: 'pending' },
        },
      };
    }
    return {
      headline: 'Location is off for Final Call',
      body: 'Without location, a tap can\'t be judged and today counts as missed. Allow "While Using the App" to check in.',
      ghost: { label: 'What reaches the server', body: 'Nothing. No check-in row exists for this tap.', pill: { label: 'Missed', tone: 'forfeit' } },
    };
  }
  const c = a.c;
  const tapAt = fmtTime(c.clientCapturedAt, tz);
  if (a.kind === 'queued') {
    return {
      headline: 'Saved, will send',
      body: `No connection. Your tap at ${tapAt} is saved with its GPS fix and sends itself when you're back online. If it lands after ${fmtTime(inst.deadlineAt, tz)} and you were inside your circle, today is unverified: no pledge moves.`,
      footnote: 'Open the app once you have signal to speed it up.',
    };
  }
  const late = c.serverReceivedAt! > inst.deadlineAt;
  switch (c.verdict) {
    case 'in_fence':
      if (late) {
        return {
          headline: 'Sent after the deadline',
          body: `Your tap was at ${tapAt}, which is what counts. Because it reached us at ${fmtTime(c.serverReceivedAt!, tz)}, today is unverified: no pledge moves.`,
          footnote: 'A friend can challenge an unverified day in the feed.',
        };
      }
      return { headline: "You're in", body: `Counted at ${tapAt}.`, pill: { label: 'Showed up', tone: 'success' } };
    case 'out_of_fence':
      if (late) return { headline: 'Not inside your circle', body: 'Your tap arrived after the deadline and was outside your circle, so today stands as missed.', footnote: 'If you were there, appeal it in the feed.' };
      return {
        headline: 'Not inside your circle yet',
        body: `About ${Math.round(c.distanceM)} m from the center of ${placeLabel} (circle is ${radiusM} m, GPS ±${c.accuracyM} m). Get closer and tap again.`,
        footnote: closed ? undefined : 'Only your best tap counts.',
      } as Panel;
    case 'unjudgeable':
      return {
        headline: 'GPS too weak to judge',
        body: `Accuracy was ±${c.accuracyM} m, more than the 200 m limit. Try again near a window. If nothing better lands, today is unverified: no pledge moves.`,
        footnote: closed ? undefined : 'Tap again when you have a clearer view of the sky',
      } as Panel;
    case 'rejected_simulated':
      return { headline: 'Location rejected', body: "That location looked simulated, so it wasn't counted. A simulated fix counts as a miss." };
  }
}

function resultHeadline(inst: Instance): string {
  const s = inst.results.you?.status;
  switch (s) {
    case 'success':
      return 'You showed up.';
    case 'failed':
      return 'Missed: your pledge went to the pool.';
    case 'unverified':
      return 'Unverified: no money moved.';
    case 'frozen':
      return 'Frozen: no money moved.';
    case 'void':
      return "Didn't count: fewer than two people were in it.";
    default:
      return 'Waiting';
  }
}

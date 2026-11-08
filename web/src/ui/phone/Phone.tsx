import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DateTime } from 'luxon';
import { fmtCents, listNames, memberDeltaFor, firstName, instanceById, type SimEvent, type World } from '../../sim';
import { spring, useReducedMotion } from '../motion';
import { actions, useStore, useWorld } from '../store';
import { CheckinScreen } from './CheckinScreen';
import { FeedScreen } from './FeedScreen';
import { HomeScreen } from './HomeScreen';
import { Avatar, Icon, PButton, ResultPill } from './primitives';
import { SettleScreen } from './SettleScreen';
import './phone.css';

/** Scales the 393×852 frame down to the space it is given, never up. */
export function Phone() {
  const wrap = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = wrap.current?.parentElement;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      // what is left under the screen picker, minus the bezel's 12 px and a little breathing room
      const top = wrap.current!.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      const avail = el.clientHeight - top - 16;
      setScale(Math.max(0.4, Math.min(1, avail / (852 + 24))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={wrap} className="phone-scale" style={{ transform: `scale(${scale})`, height: (852 + 24) * scale, marginTop: 12 }}>
      <PhoneFrame />
    </div>
  );
}

function PhoneFrame() {
  const screen = useStore((s) => s.screen);
  const w = useWorld();
  return (
    <div className="phone" data-screen={screen}>
      <div className="island" aria-hidden="true" />
      <StatusBar w={w} />
      {screen === 'home' ? <HomeScreen /> : screen === 'checkin' ? <CheckinScreen /> : screen === 'feed' ? <FeedScreen /> : <SettleScreen />}
      <Toast />
      <Reveal />
      <div className="home-indicator" aria-hidden="true" />
    </div>
  );
}

function StatusBar({ w }: { w: World }) {
  const time = DateTime.fromMillis(w.now, { zone: w.pact.tz }).toFormat('h:mm');
  return (
    <div className="statusbar" aria-hidden="true">
      <span>{time}</span>
      <span className="right">
        {w.you.online ? (
          <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor">
            <rect x="0" y="8" width="3" height="4" rx="0.8" />
            <rect x="5" y="5.5" width="3" height="6.5" rx="0.8" />
            <rect x="10" y="3" width="3" height="9" rx="0.8" />
            <rect x="15" y="0" width="3" height="12" rx="0.8" />
          </svg>
        ) : (
          <svg width="16" height="12" viewBox="0 0 16 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M2 2l12 8M14 2L2 10" />
          </svg>
        )}
        <svg width="27" height="13" viewBox="0 0 27 13" fill="none" stroke="currentColor">
          <rect x="0.5" y="0.5" width="22" height="12" rx="3.5" opacity="0.4" />
          <rect x="2" y="2" width="17" height="9" rx="2" fill="currentColor" stroke="none" />
          <path d="M24.5 4.5v4" strokeWidth="1.5" opacity="0.4" />
        </svg>
      </span>
    </div>
  );
}

/** The three moments and the ones with money: Boarding, Final call, Gate closed, corrections, settle-up. */
const TOAST_KINDS = new Set<SimEvent['kind']>(['boarding', 'final_call', 'gate_closed', 'correction', 'settlement', 'review_opened']);

function Toast() {
  const w = useWorld();
  const dismissed = useStore((s) => s.toastDismissed);
  const reduced = useReducedMotion();
  const latest = [...w.events].reverse().find((e) => TOAST_KINDS.has(e.kind)) ?? null;
  const show = latest && latest.id !== dismissed && !isAfter(dismissed, latest.id) && latest.kind !== 'gate_closed';
  const ev = show ? latest : null;
  // auto-dismiss after a while; a new event restarts the timer
  useEffect(() => {
    if (!ev) return;
    const id = setTimeout(() => actions.dismissToast(ev.id), 6000);
    return () => clearTimeout(id);
  }, [ev]);
  const [title, text] = ev ? splitToast(ev) : ['', ''];
  return (
    <AnimatePresence>
      {ev ? (
        <motion.div
          key={ev.id}
          className="toast"
          role="status"
          aria-live="polite"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: -24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -24, transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
          transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
        >
          <span className="t-icon">
            <Icon name={ev.kind === 'review_opened' ? 'review' : ev.kind === 'settlement' ? 'share' : 'location'} size={16} />
          </span>
          <span className="t-body">
            <span className="t-title">{title}</span>
            {text ? <span className="t-text">{text}</span> : null}
          </span>
          <button type="button" className="close" aria-label="Dismiss" onClick={() => actions.dismissToast(ev.id)}>
            <Icon name="x" size={16} />
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** Event ids are `ev<n>`; "seen" means every event up to that id. */
function isAfter(seenId: string | null, id: string): boolean {
  if (!seenId) return false;
  const n = (s: string) => Number(s.replace(/\D/g, ''));
  return n(id) <= n(seenId);
}

function splitToast(ev: SimEvent): [string, string] {
  const i = ev.text.indexOf(' · ');
  if (i > 0) return [ev.text.slice(0, i), ev.text.slice(i + 3)];
  if (ev.kind === 'correction') return ['Correction', ev.text];
  if (ev.kind === 'settlement') return ['Settle-up', ev.text];
  if (ev.kind === 'review_opened') return ['Review opened', ev.text];
  return [ev.text, ''];
}

/**
 * Gate closed: the one loud moment after the check-in itself. A sheet rises on the reveal spring,
 * the figure counts up, the live region reads the whole sentence once.
 */
function Reveal() {
  const w = useWorld();
  const dismissed = useStore((s) => s.revealDismissed);
  const reduced = useReducedMotion();
  const ev = [...w.events].reverse().find((e) => e.kind === 'gate_closed') ?? null;
  const show = ev && !isAfter(dismissed, ev.id);
  const inst = ev?.instanceId ? instanceById(w, ev.instanceId) : null;
  return (
    <AnimatePresence>
      {show && ev && inst ? (
        <motion.div
          key={ev.id}
          className="reveal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.2 } }}
          transition={{ duration: 0.2 }}
          onClick={() => actions.dismissReveal(ev.id)}
        >
          <motion.section
            className="reveal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reveal-title"
            onClick={(e) => e.stopPropagation()}
            initial={reduced ? { opacity: 0 } : { y: '100%' }}
            animate={reduced ? { opacity: 1 } : { y: 0 }}
            exit={reduced ? { opacity: 0, transition: { duration: 0.18 } } : { y: '100%', transition: { type: 'spring', duration: 0.3, bounce: 0 } }}
            transition={spring('reveal')}
          >
            <div className="grabber" aria-hidden="true" />
            <div className="t-footnote c-secondary">Gate closed · {w.pact.title}</div>
            <RevealFigure w={w} instanceId={inst.id} youDelta={ev.youDeltaCents ?? 0} />
            <div className="people">
              {inst.roster.map((id) => {
                const r = inst.results[id];
                const d = memberDeltaFor(w, inst.id, id);
                return (
                  <div className="person" key={id}>
                    <span className="l">
                      <Avatar member={w.members.find((m) => m.id === id)!} size={28} you={id === 'you'} />
                      <span>{id === 'you' ? 'You' : firstName(w, id)}</span>
                    </span>
                    <span className="l">
                      <span className="money">{d === 0 ? '' : d > 0 ? `+${fmtCents(d)}` : fmtCents(d)}</span>
                      {r ? <ResultPill status={r.status} compact /> : null}
                    </span>
                  </div>
                );
              })}
            </div>
            <PButton variant="secondary" onClick={() => actions.dismissReveal(ev.id)}>
              Done
            </PButton>
          </motion.section>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function RevealFigure({ w, instanceId, youDelta }: { w: World; instanceId: string; youDelta: number }) {
  const inst = instanceById(w, instanceId);
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced ? Math.abs(youDelta) : 0);
  useEffect(() => {
    if (reduced || youDelta === 0) {
      setShown(Math.abs(youDelta));
      return;
    }
    // count up over the reveal spring's settle time, exponential ease-out, ending on the exact cents
    const target = Math.abs(youDelta);
    const start = performance.now();
    const dur = 700;
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [youDelta, reduced]);
  const missed = inst.roster.filter((id) => id !== 'you' && inst.results[id]?.status === 'failed').map((id) => firstName(w, id));
  const mine = inst.results.you?.status;
  const headline =
    inst.status === 'voided'
      ? "Didn't count today"
      : youDelta > 0
        ? `You're +${fmtCents(shown)} today`
        : youDelta < 0
          ? `You forfeited ${fmtCents(shown)} today`
          : mine === 'unverified'
            ? 'Unverified today'
            : mine === 'frozen'
              ? 'Frozen today'
              : 'Everyone showed up';
  const sub =
    inst.status === 'voided'
      ? 'Fewer than two people were in it. No money moved.'
      : missed.length === 0
        ? mine === 'unverified'
          ? 'No money moved. Unverified never costs you.'
          : 'Nothing to split today.'
        : `${listNames(missed)} missed${youDelta > 0 ? ' and forfeited to the pool' : ''}.`;
  return (
    <div aria-live="polite" aria-atomic="true">
      <h2 id="reveal-title" className={`figure ${youDelta > 0 ? 'pos' : youDelta < 0 ? 'neg' : ''}`} style={{ margin: 0 }}>
        {headline}
      </h2>
      <p className="sub" style={{ margin: '4px 0 0' }}>
        {sub}
      </p>
    </div>
  );
}

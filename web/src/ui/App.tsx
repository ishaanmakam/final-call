import { MotionConfig, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { fmtClock } from '../sim';
import { Phone } from './phone/Phone';
import { ClockControls, FriendControls, ScenarioControls, YouControls } from './panel/Controls';
import { FencePlayground } from './panel/FencePlayground';
import { EventLog, LedgerPanel, SettlementPanel } from './panel/Ledger';
import { actions, useStore, useWorld, type Screen, type ThemeChoice } from './store';
import { cssVars, dark, light } from './tokens';

const SCREENS: { value: Screen; label: string }[] = [
  { value: 'home', label: 'Home' },
  { value: 'checkin', label: 'Check in' },
  { value: 'feed', label: 'Feed' },
  { value: 'settle', label: 'Settle up' },
];

function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false));
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return dark;
}

/** Palette variables on <html>, from the person's choice or the system. */
function useTheme() {
  const choice = useStore((s) => s.theme);
  const systemDark = useSystemDark();
  const resolved = choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    root.setAttribute('style', cssVars(resolved === 'dark' ? dark : light));
  }, [resolved]);
  return resolved;
}

export function App() {
  const resolved = useTheme();
  const theme = useStore((s) => s.theme);
  const w = useWorld();
  return (
    <MotionConfig reducedMotion="user">
      <div className="app">
        <header className="topbar">
          <h1>
            Final Call <span>simulator</span>
          </h1>
          <div className="clock t-subheadline">
            <span className="c-secondary">Sim clock</span>
            <span className="tabular semibold">{fmtClock(w.now, w.pact.tz)}</span>
          </div>
          <div className="spacer" />
          <span className="t-footnote c-secondary">Every money number comes from packages/rules.</span>
          <div className="segmented" role="radiogroup" aria-label="Appearance">
            {(['system', 'light', 'dark'] as ThemeChoice[]).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={theme === t} onClick={() => actions.setTheme(t)}>
                {t === 'system' ? `Auto (${resolved})` : t === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </header>
        <main className="layout">
          <div className="column phone-column">
            <ScreenPicker />
            <Phone />
          </div>
          <div className="column">
            <section className="panel" aria-labelledby="fence-h">
              <h2 id="fence-h">
                Fence playground <span className="hint">drag the dot and the ring; arrows nudge</span>
              </h2>
              <FencePlayground />
            </section>
            <YouControls />
            <FriendControls />
          </div>
          <div className="column">
            <ClockControls />
            <ScenarioControls />
            <LedgerPanel />
            <SettlementPanel />
            <EventLog />
          </div>
        </main>
      </div>
    </MotionConfig>
  );
}

/** The segmented control that picks the phone screen; the indicator pill slides on the move curve. */
function ScreenPicker() {
  const screen = useStore((s) => s.screen);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [pos, setPos] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = refs.current[screen];
    if (!el) return;
    setPos({ x: el.offsetLeft, w: el.offsetWidth });
  }, [screen]);
  return (
    <div className="segmented" role="tablist" aria-label="Phone screen" style={{ width: '100%', maxWidth: 393 }}>
      {pos ? <motion.span className="indicator" aria-hidden="true" initial={false} animate={{ x: pos.x, width: pos.w }} transition={{ duration: 0.25, ease: [0.77, 0, 0.175, 1] }} style={{ left: 0 }} /> : null}
      {SCREENS.map((s) => (
        <button
          key={s.value}
          ref={(el) => {
            refs.current[s.value] = el;
          }}
          type="button"
          role="tab"
          aria-selected={screen === s.value}
          onClick={() => actions.setScreen(s.value)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

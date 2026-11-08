import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { windowState, type WindowState } from '../../lib/time';
import { nowMs } from '../../lib/useNow';

const MAX_TIMEOUT = 0x7fffffff;

/**
 * before / open / closed for a window, re-rendering only when the phase changes (a timer set to the
 * next boundary, re-checked when the app returns to the foreground). The per-second clock lives in
 * the components that draw digits; everything else on a screen keys off this.
 */
export function useWindowPhase(windowOpenAt: string, deadlineAt: string): WindowState {
  const [phase, setPhase] = useState<WindowState>(() => windowState(nowMs(), windowOpenAt, deadlineAt));

  useEffect(() => {
    const tick = () => setPhase(windowState(nowMs(), windowOpenAt, deadlineAt));
    tick();
    const boundary = phase === 'before' ? Date.parse(windowOpenAt) : phase === 'open' ? Date.parse(deadlineAt) + 1 : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (boundary !== null) timer = setTimeout(tick, Math.min(Math.max(0, boundary - nowMs()), MAX_TIMEOUT));
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') tick();
    });
    return () => {
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, [phase, windowOpenAt, deadlineAt]);

  return phase;
}

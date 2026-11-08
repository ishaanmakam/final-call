import { useEffect, useState } from 'react';
import { DEMO, getDemoSettings, subscribeDemoSettings } from '../api/demo/settings';

/**
 * Re-renders every `intervalMs` with the current time (for countdowns). In demo mode with
 * `?freeze=1` the clock stops at the fixture anchor so screenshots are deterministic.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  const [frozen, setFrozen] = useState(() => DEMO && getDemoSettings().freeze);

  useEffect(() => {
    if (!DEMO) return;
    return subscribeDemoSettings((s) => setFrozen(s.freeze));
  }, []);

  useEffect(() => {
    if (frozen) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, frozen]);

  if (frozen) return demoAnchor();
  return now;
}

let anchor: number | null = null;
/** First frozen read wins, so every countdown on screen agrees. */
function demoAnchor(): number {
  if (anchor === null) anchor = Date.now();
  return anchor;
}

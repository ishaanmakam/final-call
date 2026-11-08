/**
 * Demo mode (`EXPO_PUBLIC_DEMO=1`): every query and RPC resolves against in-memory fixtures, auth
 * is a fake session, location is a fake fix. Used for the web screenshot harness and for showing
 * the app without a backend. Route params steer what the fixtures show:
 *
 *   ?verdict=in_fence|out_of_fence|unjudgeable|rejected_simulated   what a demo check-in returns
 *   ?empty=1        a group with nothing in it yet (empty states)
 *   ?state=offline  every query fails like a dead network; check-ins get queued
 *   ?state=error    every query fails with a generic server error
 *   ?state=queued   queries work, but the check-in request fails like a dead network
 *   ?perm=denied|blocked   location permission outcome on the check-in tap
 *   ?signedOut=1    no session (shows the sign-in screen)
 *   ?freeze=1       the clock stops at the fixture anchor (deterministic countdowns)
 *   ?settle=owe|owed   settle-up variants: only obligations you pay / only ones paid to you
 *   ?fix=none       the GPS fix times out on the check-in tap (fail-open: sent without coordinates)
 */
import type { CheckinVerdict } from '../types';

export const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';
export const DEMO_USER_ID = 'demo-user';

export type DemoNetworkState = 'ok' | 'offline' | 'error' | 'queued';
export type DemoPermission = 'granted' | 'denied' | 'blocked';
export type DemoSettleVariant = 'mixed' | 'owe' | 'owed';
export type DemoFix = 'ok' | 'none';

export interface DemoSettings {
  verdict: CheckinVerdict;
  empty: boolean;
  state: DemoNetworkState;
  perm: DemoPermission;
  signedOut: boolean;
  freeze: boolean;
  settle: DemoSettleVariant;
  fix: DemoFix;
}

export const DEFAULT_DEMO_SETTINGS: DemoSettings = {
  verdict: 'in_fence',
  empty: false,
  state: 'ok',
  perm: 'granted',
  signedOut: false,
  freeze: false,
  settle: 'mixed',
  fix: 'ok',
};

const VERDICTS: readonly CheckinVerdict[] = ['in_fence', 'out_of_fence', 'unjudgeable', 'rejected_simulated'];
const STATES: readonly DemoNetworkState[] = ['ok', 'offline', 'error', 'queued'];
const PERMS: readonly DemoPermission[] = ['granted', 'denied', 'blocked'];
const SETTLES: readonly DemoSettleVariant[] = ['mixed', 'owe', 'owed'];
const FIXES: readonly DemoFix[] = ['ok', 'none'];

type Params = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const flag = (v: string | string[] | undefined): boolean => {
  const s = one(v);
  return s === '1' || s === 'true';
};
const pick = <T extends string>(v: string | string[] | undefined, allowed: readonly T[], fallback: T): T => {
  const s = one(v);
  return s !== undefined && (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
};

export function demoSettingsFromParams(params: Params): DemoSettings {
  return {
    verdict: pick(params.verdict, VERDICTS, DEFAULT_DEMO_SETTINGS.verdict),
    empty: flag(params.empty),
    state: pick(params.state, STATES, DEFAULT_DEMO_SETTINGS.state),
    perm: pick(params.perm, PERMS, DEFAULT_DEMO_SETTINGS.perm),
    signedOut: flag(params.signedOut),
    freeze: flag(params.freeze),
    settle: pick(params.settle, SETTLES, DEFAULT_DEMO_SETTINGS.settle),
    fix: pick(params.fix, FIXES, DEFAULT_DEMO_SETTINGS.fix),
  };
}

/** Process-wide copy for code that is not a hook (RPCs, the location adapter). */
let current: DemoSettings = DEFAULT_DEMO_SETTINGS;
const listeners = new Set<(s: DemoSettings) => void>();

export const getDemoSettings = (): DemoSettings => current;

export function setDemoSettings(next: DemoSettings): void {
  if (
    next.verdict === current.verdict &&
    next.empty === current.empty &&
    next.state === current.state &&
    next.perm === current.perm &&
    next.signedOut === current.signedOut &&
    next.freeze === current.freeze &&
    next.settle === current.settle &&
    next.fix === current.fix
  ) {
    return;
  }
  current = next;
  listeners.forEach((l) => l(next));
}

export function subscribeDemoSettings(listener: (s: DemoSettings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable cache-key fragment so TanStack Query refetches when the demo scenario changes. */
export const demoKey = (s: DemoSettings): string => `${s.empty ? 'empty' : 'full'}:${s.state}:${s.settle}`;

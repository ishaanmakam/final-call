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
 *   ?precise=0      iOS Approximate Location: the check-in tap refuses to send and points to Settings
 *   ?budget=N       N unverified days this month in this pact (0-9; the check-in screen's budget line)
 *   ?skew=S         the phone's clock is S seconds off the server (negative = ahead); the check-in screen's
 *                   clock-skew notice shows past 120 s
 *   ?state=gate-closed   the open instance is a minute past its deadline and the server has not closed it yet
 *                   (the check-in screen's "Gate closed · tallying…" card); queries otherwise work
 *   ?outcome=win|forfeit|unverified|frozen|void   what today's closed instance (i-closed) did to you: results
 *                   and ledger nets are rewritten so the gate-close card shows that outcome
 *   ?week=closed    the weekly pact's current week (w-current) closed a minute ago with results posted: you fell
 *                   short at 11.2 / 15 mi and forfeited, Maya made it (the weekly gate-close money line)
 */
import type { CheckinVerdict } from '../types';

export const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';
export const DEMO_USER_ID = 'demo-user';

export type DemoNetworkState = 'ok' | 'offline' | 'error' | 'queued' | 'gate-closed';
export type DemoPermission = 'granted' | 'denied' | 'blocked';
export type DemoSettleVariant = 'mixed' | 'owe' | 'owed';
export type DemoFix = 'ok' | 'none';
/** the gate-close card's outcome on today's closed instance; 'fixture' keeps the fixture results */
export type DemoOutcome = 'fixture' | 'win' | 'forfeit' | 'unverified' | 'frozen' | 'void';
/** the weekly pact's current week: open as the fixtures have it, or closed a minute ago with results */
export type DemoWeek = 'open' | 'closed';

export interface DemoSettings {
  verdict: CheckinVerdict;
  empty: boolean;
  state: DemoNetworkState;
  perm: DemoPermission;
  signedOut: boolean;
  freeze: boolean;
  settle: DemoSettleVariant;
  fix: DemoFix;
  /** false = iOS Approximate Location (reduced accuracy authorization) */
  precise: boolean;
  /** unverified days this month in the open instance's pact (the check-in screen's budget line) */
  budget: number;
  /** seconds the server is ahead of the phone (negative = phone ahead); the clock-skew notice */
  skew: number;
  /** what today's closed instance did to you (the gate-close card and the group home's compact line) */
  outcome: DemoOutcome;
  /** the weekly distance pact's current week (challenge kinds, CB) */
  week: DemoWeek;
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
  precise: true,
  budget: 0,
  skew: 0,
  outcome: 'fixture',
  week: 'open',
};

const VERDICTS: readonly CheckinVerdict[] = ['in_fence', 'out_of_fence', 'unjudgeable', 'rejected_simulated'];
const STATES: readonly DemoNetworkState[] = ['ok', 'offline', 'error', 'queued', 'gate-closed'];
const PERMS: readonly DemoPermission[] = ['granted', 'denied', 'blocked'];
const SETTLES: readonly DemoSettleVariant[] = ['mixed', 'owe', 'owed'];
const FIXES: readonly DemoFix[] = ['ok', 'none'];
const OUTCOMES: readonly DemoOutcome[] = ['fixture', 'win', 'forfeit', 'unverified', 'frozen', 'void'];
const WEEKS: readonly DemoWeek[] = ['open', 'closed'];

type Params = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const flag = (v: string | string[] | undefined): boolean => {
  const s = one(v);
  return s === '1' || s === 'true';
};
const digit = (v: string | string[] | undefined, fallback: number): number => {
  const s = one(v);
  return s !== undefined && /^[0-9]$/.test(s) ? Number(s) : fallback;
};
const seconds = (v: string | string[] | undefined, fallback: number): number => {
  const s = one(v);
  return s !== undefined && /^-?[0-9]{1,6}$/.test(s) ? Number(s) : fallback;
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
    precise: one(params.precise) !== '0' && one(params.precise) !== 'false',
    budget: digit(params.budget, DEFAULT_DEMO_SETTINGS.budget),
    skew: seconds(params.skew, DEFAULT_DEMO_SETTINGS.skew),
    outcome: pick(params.outcome, OUTCOMES, DEFAULT_DEMO_SETTINGS.outcome),
    week: pick(params.week, WEEKS, DEFAULT_DEMO_SETTINGS.week),
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
    next.fix === current.fix &&
    next.precise === current.precise &&
    next.budget === current.budget &&
    next.skew === current.skew &&
    next.outcome === current.outcome &&
    next.week === current.week
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
export const demoKey = (s: DemoSettings): string => `${s.empty ? 'empty' : 'full'}:${s.state}:${s.settle}:${s.outcome}:${s.week}`;

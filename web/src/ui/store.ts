/**
 * The one store: the engine's World plus UI-only state (which phone screen, theme, what has been
 * seen). Components subscribe with useSyncExternalStore; every action goes through `apply`, which
 * replaces the World reference the engine returned.
 */
import { useSyncExternalStore } from 'react';
import {
  SCENARIOS,
  castVote,
  checkIn,
  confirmObligation,
  createWorld,
  disputeObligation,
  freezeToday,
  markObligationPaid,
  openReview,
  setBehaviour,
  setGps,
  setLocationMode,
  setOnline,
  transition,
  type Behaviour,
  type CheckInOutcome,
  type FriendId,
  type LocationMode,
  type MemberId,
  type ReviewKind,
  type ScenarioName,
  type Transition,
  type World,
} from '../sim';

export type Screen = 'home' | 'checkin' | 'feed' | 'settle';
export type ThemeChoice = 'system' | 'light' | 'dark';

export interface UIState {
  world: World;
  screen: Screen;
  theme: ThemeChoice;
  /** the id of the last gate-closed event the person dismissed */
  revealDismissed: string | null;
  /** the last event id shown as a toast and dismissed */
  toastDismissed: string | null;
  /** "Finding you…" between the tap and the verdict */
  locating: boolean;
  lastOutcome: CheckInOutcome | null;
  scenario: { name: ScenarioName; step: number } | null;
  /** a one-line note from the panel (e.g. "Venmo would open") */
  note: string | null;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let state: UIState = {
  world: createWorld(),
  screen: 'home',
  theme: 'system',
  revealDismissed: null,
  toastDismissed: null,
  locating: false,
  lastOutcome: null,
  scenario: null,
  note: null,
};

function set(patch: Partial<UIState> | ((s: UIState) => Partial<UIState>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

export function getState(): UIState {
  return state;
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(selector: (s: UIState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

export const useWorld = () => useStore((s) => s.world);

/** Apply an engine function to the current world. */
function apply(fn: (w: World) => World, extra: Partial<UIState> = {}) {
  const world = fn(state.world);
  set({ world, ...extra, scenario: extra.scenario === undefined ? state.scenario : extra.scenario });
}

/** How long the phone shows "Finding you…" before the verdict lands (one GPS fix, shortened). */
export let LOCATING_MS = 900;
export function setLocatingMs(ms: number) {
  LOCATING_MS = ms;
}

export const actions = {
  setScreen: (screen: Screen) => set({ screen }),
  setTheme: (theme: ThemeChoice) => set({ theme }),
  reset: () => set({ world: createWorld(), revealDismissed: null, toastDismissed: null, locating: false, lastOutcome: null, scenario: null, note: null }),
  setGps: (patch: Parameters<typeof setGps>[1]) => apply((w) => setGps(w, patch)),
  setLocationMode: (mode: LocationMode) => apply((w) => setLocationMode(w, mode)),
  setOnline: (online: boolean) => apply((w) => setOnline(w, online)),
  setBehaviour: (id: FriendId, b: Behaviour) => apply((w) => setBehaviour(w, id, b)),
  transition: (t: Transition) => apply((w) => transition(w, t), { scenario: null }),
  freezeToday: () => apply(freezeToday),
  /** The Check In tap: a short "Finding you…" then the engine's verdict. */
  checkIn: (): Promise<CheckInOutcome> =>
    new Promise((resolve) => {
      if (state.locating) return resolve({ kind: 'not_open' });
      const mode = state.world.you.locationMode;
      const delay = mode === 'precise' ? LOCATING_MS : 0;
      set({ locating: delay > 0 });
      const finish = () => {
        const { world, outcome } = checkIn(state.world);
        set({ world, locating: false, lastOutcome: outcome });
        resolve(outcome);
      };
      if (delay === 0) finish();
      else setTimeout(finish, delay);
    }),
  checkInNow: (): CheckInOutcome => {
    const { world, outcome } = checkIn(state.world);
    set({ world, locating: false, lastOutcome: outcome });
    return outcome;
  },
  openReview: (instanceId: string, subject: MemberId, kind: ReviewKind, openedBy: MemberId, reason: string) =>
    apply((w) => openReview(w, instanceId, subject, kind, openedBy, reason)),
  castVote: (reviewId: string, voter: MemberId, supports: boolean) => apply((w) => castVote(w, reviewId, voter, supports)),
  markPaid: (id: string) => apply((w) => markObligationPaid(w, id)),
  confirm: (id: string) => apply((w) => confirmObligation(w, id)),
  dispute: (id: string) => apply((w) => disputeObligation(w, id)),
  payOnVenmo: (id: string) => {
    const o = state.world.obligations.find((x) => x.id === id);
    if (!o) return;
    set({ note: `Venmo would open here, prefilled: pay ${o.to === 'you' ? 'you' : o.to} ${(o.amountCents / 100).toFixed(2)} for "Final Call · week settle-up". Then tap Mark paid.` });
  },
  clearNote: () => set({ note: null }),
  dismissReveal: (id: string) => set({ revealDismissed: id }),
  dismissToast: (id: string) => set({ toastDismissed: id }),
  /** Start a preset from a fresh world and run its first step. */
  startScenario: (name: ScenarioName) => {
    const fresh = createWorld();
    const world = SCENARIOS[name].steps[0]!.apply(fresh);
    set({ world, scenario: { name, step: 1 }, revealDismissed: null, toastDismissed: null, lastOutcome: null, locating: false });
  },
  /** Run the next step of the active preset. */
  nextScenarioStep: () => {
    const sc = state.scenario;
    if (!sc) return;
    const steps = SCENARIOS[sc.name].steps;
    if (sc.step >= steps.length) return;
    const world = steps[sc.step]!.apply(state.world);
    set({ world, scenario: { name: sc.name, step: sc.step + 1 } });
  },
  /** Run the active preset to the end. */
  runScenarioToEnd: (name?: ScenarioName) => {
    const target = name ?? state.scenario?.name;
    if (!target) return;
    let world = name ? createWorld() : state.world;
    const from = name ? 0 : (state.scenario?.step ?? 0);
    const steps = SCENARIOS[target].steps;
    for (let i = from; i < steps.length; i++) world = steps[i]!.apply(world);
    set({ world, scenario: { name: target, step: steps.length }, revealDismissed: null, toastDismissed: null, locating: false });
  },
  /** Marks everything shown so far as seen (used by the screenshot script between scenes). */
  markAllSeen: () => {
    const last = state.world.events.at(-1)?.id ?? null;
    set({ revealDismissed: last, toastDismissed: last });
  },
};

export type Actions = typeof actions;

declare global {
  interface Window {
    __finalCallSim?: { getState: typeof getState; actions: Actions; setLocatingMs: typeof setLocatingMs };
  }
}

if (typeof window !== 'undefined') {
  window.__finalCallSim = { getState, actions, setLocatingMs };
}

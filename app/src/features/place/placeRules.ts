/**
 * What the Save button may do right now, decided before the tap instead of discovered from the
 * server's refusal: a first join is immediate; a change is refused while one of this pact's
 * windows is open (you are being judged against the old place), and otherwise applies to windows
 * opening 12+ hours out.
 */
import type { PactInstanceRow } from '../../api/types';
import { nextWindow } from '../../lib/places';
import { windowState } from '../../lib/time';

export interface PlaceSaveState {
  mode: 'join' | 'change';
  /** true while a window is open and the person already has a place */
  locked: boolean;
  /** deadline of the open window, when locked */
  lockedUntil: string | null;
  nextWindow: PactInstanceRow | null;
}

export function placeSaveState(input: { hasPlace: boolean; upcoming: readonly PactInstanceRow[]; nowMs: number }): PlaceSaveState {
  const open = input.upcoming.find(
    (i) => i.status !== 'voided' && windowState(input.nowMs, i.window_open_at, i.deadline_at) === 'open',
  );
  const locked = input.hasPlace && open !== undefined;
  return {
    mode: input.hasPlace ? 'change' : 'join',
    locked,
    lockedUntil: locked && open ? open.deadline_at : null,
    nextWindow: nextWindow(input.upcoming, input.nowMs),
  };
}

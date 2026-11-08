/**
 * Autosave rules for the Settings profile rows: what to send when a field ends editing, and the
 * inline copy when it cannot be saved.
 */
import { normalizeVenmoUsername } from '../../lib/venmo';

export const NAME_EMPTY = 'Display name cannot be empty.';
export const NAME_TOO_LONG = 'Display name must be 1 to 50 characters.';
export const VENMO_INVALID = 'Venmo usernames are 5 to 30 letters, numbers, - or _.';

export interface ProfileDraft {
  name: string;
  venmo: string;
}

export interface ProfileSaved {
  display_name: string;
  venmo_username: string | null;
}

export type ProfilePatch = Partial<ProfileSaved>;

export function nameError(name: string): string | null {
  const n = name.trim();
  if (n.length === 0) return NAME_EMPTY;
  if (n.length > 50) return NAME_TOO_LONG;
  return null;
}

export function venmoError(venmo: string): string | null {
  if (venmo.trim() === '') return null;
  return normalizeVenmoUsername(venmo) === null ? VENMO_INVALID : null;
}

/**
 * The patch to send when editing ends, or null when nothing changed. Invalid input yields an
 * `error` and no patch, so the server is never asked to reject what the client already knows.
 */
export function profilePatch(draft: ProfileDraft, saved: ProfileSaved): { patch: ProfilePatch | null; error: string | null } {
  const nErr = nameError(draft.name);
  const vErr = venmoError(draft.venmo);
  if (nErr || vErr) return { patch: null, error: nErr ?? vErr };
  const patch: ProfilePatch = {};
  const name = draft.name.trim();
  if (name !== saved.display_name) patch.display_name = name;
  const venmo = draft.venmo.trim() === '' ? null : normalizeVenmoUsername(draft.venmo);
  if (venmo !== saved.venmo_username) patch.venmo_username = venmo;
  return { patch: Object.keys(patch).length === 0 ? null : patch, error: null };
}

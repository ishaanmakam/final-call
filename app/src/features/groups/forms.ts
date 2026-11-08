/**
 * Validation for the create / join group forms. Returns the copy to show inline; the server rules
 * (name 1 to 80 chars, 8 members max, unknown code) are still mapped in `lib/errors.ts` for safety.
 */
import { inviteCodeFromUrl } from '../../lib/links';

export const NAME_MIN = 2;
export const NAME_MAX = 60;

export const NAME_REQUIRED = 'Give the group a name.';
export const CODE_REQUIRED = 'Paste the invite link or type the code.';

export function groupNameError(name: string): string | null {
  const n = name.trim();
  if (n.length < NAME_MIN) return NAME_REQUIRED;
  if (n.length > NAME_MAX) return `Keep the name under ${NAME_MAX} characters.`;
  return null;
}

export const canCreate = (name: string): boolean => groupNameError(name) === null;

/** The code the server wants, or null with the reason. */
export function parseInviteInput(input: string): { code: string } | { error: string } {
  const code = inviteCodeFromUrl(input);
  return code ? { code: code.toUpperCase() } : { error: CODE_REQUIRED };
}

export const canJoin = (input: string): boolean => 'code' in parseInviteInput(input);

/** Codes are shown upper-case; links keep their spelling. */
export function normalizeInviteInput(raw: string): string {
  return /^finalcall:\/\//i.test(raw.trim()) ? raw : raw.toUpperCase();
}

/**
 * Pure logic for the sign-in and auth-callback screens: where to go after sign-in, what counts
 * as an email worth sending a link to, and the copy for the ways a magic link can fail.
 */

/** Only an in-app path is a safe redirect target; anything else lands on the groups list. */
export function safeNext(next: string | string[] | undefined): string {
  const value = Array.isArray(next) ? next[0] : next;
  if (!value) return '/groups';
  if (!value.startsWith('/') || value.startsWith('//')) return '/groups';
  if (value.startsWith('/sign-in') || value.startsWith('/auth-callback')) return '/groups';
  return value;
}

export const EMAIL_INVALID = 'Enter a valid email address.';

export function isValidEmail(input: string): boolean {
  const s = input.trim();
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

export const LINK_MISSING_CODE = 'This sign-in link is missing its code. Request a new one.';
export const LINK_EXPIRED = 'This link has expired. Links work once, for an hour.';

export interface CallbackParams {
  code?: string | string[];
  error?: string | string[];
  error_code?: string | string[];
  error_description?: string | string[];
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * What the callback URL already tells us before any network call: `null` means "go exchange the
 * code", a string is the message to show instead.
 */
export function callbackErrorFromParams(params: CallbackParams): string | null {
  const errorCode = one(params.error_code);
  const description = one(params.error_description);
  if (errorCode === 'otp_expired' || /expired/i.test(description ?? '')) return LINK_EXPIRED;
  if (description) return description.replace(/\+/g, ' ');
  if (one(params.error)) return 'The sign-in link was refused. Request a new one.';
  if (!one(params.code)) return LINK_MISSING_CODE;
  return null;
}

/** Copy for an error thrown while exchanging the code for a session. */
export function exchangeErrorMessage(error: unknown): string {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { code?: string; message?: string; status?: number };
  const message = typeof e.message === 'string' ? e.message : String(error);
  if (e.code === 'otp_expired' || /expired|invalid.*(code|token)|flow state/i.test(message)) return LINK_EXPIRED;
  if (/pkce|code verifier|different browser|another device/i.test(message)) {
    return 'Open the link on the phone you requested it from.';
  }
  return message.length > 0 ? message : 'Something went wrong.';
}

export const APP_SCHEME = 'finalcall';

export function inviteLink(code: string): string {
  return `${APP_SCHEME}://join/${encodeURIComponent(code.trim())}`;
}

/** Accepts a full invite link or a bare code typed by hand. */
export function inviteCodeFromUrl(input: string): string | null {
  const trimmed = input.trim();
  const m = /^finalcall:\/\/join\/([^/?#]+)/i.exec(trimmed);
  if (m?.[1]) return decodeURIComponent(m[1]);
  if (/^[A-Za-z0-9_-]{3,64}$/.test(trimmed)) return trimmed;
  return null;
}

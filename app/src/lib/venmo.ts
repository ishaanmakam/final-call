import { centsToDecimalString } from './money';

const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,30}$/;

export function normalizeVenmoUsername(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const stripped = raw.trim().replace(/^@/, '');
  return USERNAME_PATTERN.test(stripped) ? stripped : null;
}

export interface VenmoPayRequest {
  recipient: string;
  amountCents: number;
  note: string;
}

export interface VenmoPayLinks {
  app: string;
  web: string;
}

export function buildVenmoPayLinks({ recipient, amountCents, note }: VenmoPayRequest): VenmoPayLinks {
  const username = normalizeVenmoUsername(recipient);
  if (!username) throw new Error(`Invalid Venmo username: ${recipient}`);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new RangeError(`Venmo amount must be a positive integer number of cents, got ${amountCents}`);
  }
  const user = encodeURIComponent(username);
  const amount = centsToDecimalString(amountCents);
  const encodedNote = encodeURIComponent(note);
  return {
    app: `venmo://paycharge?txn=pay&recipients=${user}&amount=${amount}&note=${encodedNote}`,
    web: `https://venmo.com/${user}?txn=pay&amount=${amount}&note=${encodedNote}`,
  };
}

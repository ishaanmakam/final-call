function assertCents(cents: number): void {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`Expected an integer number of cents, got ${cents}`);
  }
}

function splitCents(cents: number): { negative: boolean; dollars: string; fraction: string } {
  assertCents(cents);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = String(Math.floor(abs / 100));
  const fraction = String(abs % 100).padStart(2, '0');
  return { negative, dollars, fraction };
}

export function centsToDecimalString(cents: number): string {
  const { negative, dollars, fraction } = splitCents(cents);
  return `${negative ? '-' : ''}${dollars}.${fraction}`;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatCents(cents: number, options: { signed?: boolean } = {}): string {
  const { negative, dollars, fraction } = splitCents(cents);
  const sign = negative ? '-' : options.signed && cents > 0 ? '+' : '';
  return `${sign}$${groupThousands(dollars)}.${fraction}`;
}

const DOLLARS_PATTERN = /^(\d*)(?:\.(\d{0,2}))?$/;

export function parseDollarsToCents(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/, '').replace(/,/g, '');
  const match = DOLLARS_PATTERN.exec(cleaned);
  if (!match) return null;
  const whole = match[1] ?? '';
  const frac = match[2] ?? '';
  if (whole.length === 0 && frac.length === 0) return null;
  if (whole.length > 13) return null;
  const cents = Number(whole || '0') * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

export const MIN_STAKE_CENTS = 1;
export const MAX_STAKE_CENTS = 10_000;

/** Dollars appear only in UI formatting. Cents stay integers everywhere else. */
export function fmtCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`non-integer cents: ${cents}`);
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${cents < 0 ? '−' : ''}$${dollars}.${rest}`;
}

/** "+$3.33" / "−$5.00" / "$0.00" */
export function fmtSigned(cents: number): string {
  return cents > 0 ? `+${fmtCents(cents)}` : fmtCents(cents);
}

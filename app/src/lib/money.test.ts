import { describe, expect, it } from 'vitest';
import { centsToDecimalString, formatCents, parseDollarsToCents } from './money';

describe('centsToDecimalString', () => {
  it.each([
    [0, '0.00'],
    [1, '0.01'],
    [10, '0.10'],
    [99, '0.99'],
    [100, '1.00'],
    [1234, '12.34'],
    [1005, '10.05'],
    [10000, '100.00'],
    [-305, '-3.05'],
    [-1, '-0.01'],
  ])('%i cents -> %s', (cents, expected) => {
    expect(centsToDecimalString(cents)).toBe(expected);
  });

  it('is exact for values where float math drifts', () => {
    // 0.1 + 0.2 style drift: 29 cents, 57 cents, 1.15 and 4.35 dollars
    expect(centsToDecimalString(29)).toBe('0.29');
    expect(centsToDecimalString(57)).toBe('0.57');
    expect(centsToDecimalString(115)).toBe('1.15');
    expect(centsToDecimalString(435)).toBe('4.35');
    expect(centsToDecimalString(900719925474099)).toBe('9007199254740.99');
  });

  it('rejects non-integer cents', () => {
    expect(() => centsToDecimalString(1.5)).toThrow();
    expect(() => centsToDecimalString(Number.NaN)).toThrow();
    expect(() => centsToDecimalString(Number.MAX_SAFE_INTEGER + 2)).toThrow();
  });
});

describe('formatCents', () => {
  it('formats with a dollar sign and thousands separators', () => {
    expect(formatCents(500)).toBe('$5.00');
    expect(formatCents(123456)).toBe('$1,234.56');
    expect(formatCents(-250)).toBe('-$2.50');
  });

  it('can force a sign for balances', () => {
    expect(formatCents(250, { signed: true })).toBe('+$2.50');
    expect(formatCents(-250, { signed: true })).toBe('-$2.50');
    expect(formatCents(0, { signed: true })).toBe('$0.00');
  });
});

describe('parseDollarsToCents', () => {
  it.each([
    ['5', 500],
    ['5.', 500],
    ['5.5', 550],
    ['5.05', 505],
    ['0.29', 29],
    ['1.15', 115],
    ['4.35', 435],
    ['$12.34', 1234],
    [' 1,234.50 ', 123450],
    ['.75', 75],
  ])('%s -> %i', (input, cents) => {
    expect(parseDollarsToCents(input)).toBe(cents);
  });

  it.each(['', ' ', 'abc', '1.234', '-1', '1e3', '1.2.3', '$', '.'])('rejects %j', (input) => {
    expect(parseDollarsToCents(input)).toBeNull();
  });
});

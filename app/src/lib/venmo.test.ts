import { describe, expect, it } from 'vitest';
import { buildVenmoPayLinks, normalizeVenmoUsername } from './venmo';

describe('normalizeVenmoUsername', () => {
  it('strips @ and whitespace', () => {
    expect(normalizeVenmoUsername('  @Ishaan-Makam ')).toBe('Ishaan-Makam');
    expect(normalizeVenmoUsername('jane_doe')).toBe('jane_doe');
  });

  it('rejects empty or invalid usernames', () => {
    expect(normalizeVenmoUsername('')).toBeNull();
    expect(normalizeVenmoUsername('@')).toBeNull();
    expect(normalizeVenmoUsername('has space')).toBeNull();
    expect(normalizeVenmoUsername('a&b=c')).toBeNull();
    // the database only stores 5 to 30 characters
    expect(normalizeVenmoUsername('abcd')).toBeNull();
    expect(normalizeVenmoUsername('a'.repeat(31))).toBeNull();
    expect(normalizeVenmoUsername('abcde')).toBe('abcde');
    expect(normalizeVenmoUsername(null)).toBeNull();
    expect(normalizeVenmoUsername(undefined)).toBeNull();
  });
});

describe('buildVenmoPayLinks', () => {
  it('builds app and web links with exact decimal amount', () => {
    const links = buildVenmoPayLinks({ recipient: '@jane_doe', amountCents: 1234, note: 'Show Up' });
    expect(links.app).toBe('venmo://paycharge?txn=pay&recipients=jane_doe&amount=12.34&note=Show%20Up');
    expect(links.web).toBe('https://venmo.com/jane_doe?txn=pay&amount=12.34&note=Show%20Up');
  });

  it('formats amounts without float error', () => {
    expect(buildVenmoPayLinks({ recipient: 'x_user', amountCents: 29, note: 'n' }).app).toContain('amount=0.29&');
    expect(buildVenmoPayLinks({ recipient: 'x_user', amountCents: 1005, note: 'n' }).app).toContain('amount=10.05&');
    expect(buildVenmoPayLinks({ recipient: 'x_user', amountCents: 100, note: 'n' }).web).toContain('amount=1.00&');
  });

  it('URL-encodes the note including reserved and unicode characters', () => {
    const { app, web } = buildVenmoPayLinks({
      recipient: 'jane_doe',
      amountCents: 500,
      note: 'Pool & pledges = week of Nov 2 · #1?',
    });
    const encoded = 'Pool%20%26%20pledges%20%3D%20week%20of%20Nov%202%20%C2%B7%20%231%3F';
    expect(app.endsWith(`&note=${encoded}`)).toBe(true);
    expect(web.endsWith(`&note=${encoded}`)).toBe(true);
    expect(new URL(web).searchParams.get('note')).toBe('Pool & pledges = week of Nov 2 · #1?');
  });

  it('rejects bad amounts and recipients', () => {
    expect(() => buildVenmoPayLinks({ recipient: 'jane_doe', amountCents: 0, note: '' })).toThrow();
    expect(() => buildVenmoPayLinks({ recipient: 'jane_doe', amountCents: -5, note: '' })).toThrow();
    expect(() => buildVenmoPayLinks({ recipient: 'jane_doe', amountCents: 12.5, note: '' })).toThrow();
    expect(() => buildVenmoPayLinks({ recipient: 'bad name', amountCents: 100, note: '' })).toThrow();
  });
});

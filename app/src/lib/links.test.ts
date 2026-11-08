import { describe, expect, it } from 'vitest';
import { inviteCodeFromUrl, inviteLink } from './links';

describe('invite links', () => {
  it('builds finalcall://join/<code>', () => {
    expect(inviteLink('AB12CD')).toBe('finalcall://join/AB12CD');
    expect(inviteLink(' a b ')).toBe('finalcall://join/a%20b');
  });

  it('extracts the code back out', () => {
    expect(inviteCodeFromUrl('finalcall://join/AB12CD')).toBe('AB12CD');
    expect(inviteCodeFromUrl('finalcall://join/a%20b')).toBe('a b');
    expect(inviteCodeFromUrl('AB12CD')).toBe('AB12CD');
    expect(inviteCodeFromUrl('https://example.com/x')).toBeNull();
  });
});

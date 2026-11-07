import { describe, expect, it } from 'vitest';
import { inviteCodeFromUrl, inviteLink } from './links';

describe('invite links', () => {
  it('builds showup://join/<code>', () => {
    expect(inviteLink('AB12CD')).toBe('showup://join/AB12CD');
    expect(inviteLink(' a b ')).toBe('showup://join/a%20b');
  });

  it('extracts the code back out', () => {
    expect(inviteCodeFromUrl('showup://join/AB12CD')).toBe('AB12CD');
    expect(inviteCodeFromUrl('showup://join/a%20b')).toBe('a b');
    expect(inviteCodeFromUrl('AB12CD')).toBe('AB12CD');
    expect(inviteCodeFromUrl('https://example.com/x')).toBeNull();
  });
});

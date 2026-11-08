import { describe, expect, it } from 'vitest';
import { CODE_REQUIRED, NAME_REQUIRED, canCreate, canJoin, groupNameError, normalizeInviteInput, parseInviteInput } from './forms';

describe('groupNameError', () => {
  it('needs two characters after trimming', () => {
    expect(groupNameError('')).toBe(NAME_REQUIRED);
    expect(groupNameError(' a ')).toBe(NAME_REQUIRED);
    expect(groupNameError('ab')).toBeNull();
    expect(canCreate('Morning crew')).toBe(true);
  });
  it('caps the length', () => {
    expect(groupNameError('x'.repeat(61))).toMatch(/under 60/);
  });
});

describe('parseInviteInput', () => {
  it('accepts a bare code or a link and upper-cases the code', () => {
    expect(parseInviteInput('kane9am')).toEqual({ code: 'KANE9AM' });
    expect(parseInviteInput('showup://join/kane9am')).toEqual({ code: 'KANE9AM' });
    expect(canJoin(' KANE9AM ')).toBe(true);
  });
  it('refuses empty and malformed input', () => {
    expect(parseInviteInput('')).toEqual({ error: CODE_REQUIRED });
    expect(parseInviteInput('https://x.y/z')).toEqual({ error: CODE_REQUIRED });
    expect(canJoin('a')).toBe(false);
  });
});

describe('normalizeInviteInput', () => {
  it('upper-cases typed codes but leaves links alone', () => {
    expect(normalizeInviteInput('kane9am')).toBe('KANE9AM');
    expect(normalizeInviteInput('showup://join/Kane9am')).toBe('showup://join/Kane9am');
  });
});

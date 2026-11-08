import { describe, expect, it } from 'vitest';
import { NAME_EMPTY, VENMO_INVALID, nameError, profilePatch, venmoError } from './profileForm';

const saved = { display_name: 'Sam Okafor', venmo_username: 'sam-okafor' };

describe('validation copy', () => {
  it('names the problem', () => {
    expect(nameError('  ')).toBe(NAME_EMPTY);
    expect(nameError('x'.repeat(51))).toMatch(/1 to 50/);
    expect(nameError('Sam')).toBeNull();
    expect(venmoError('')).toBeNull();
    expect(venmoError('@sam')).toBe(VENMO_INVALID);
    expect(venmoError('@sam-okafor')).toBeNull();
  });
});

describe('profilePatch', () => {
  it('sends nothing when nothing changed, ignoring whitespace and the @', () => {
    expect(profilePatch({ name: ' Sam Okafor ', venmo: '@sam-okafor' }, saved)).toEqual({ patch: null, error: null });
  });
  it('sends only the changed field', () => {
    expect(profilePatch({ name: 'Sam O.', venmo: 'sam-okafor' }, saved)).toEqual({ patch: { display_name: 'Sam O.' }, error: null });
    expect(profilePatch({ name: 'Sam Okafor', venmo: '' }, saved)).toEqual({ patch: { venmo_username: null }, error: null });
    expect(profilePatch({ name: 'Sam Okafor', venmo: '@maya_chen' }, saved)).toEqual({ patch: { venmo_username: 'maya_chen' }, error: null });
  });
  it('refuses invalid input with inline copy and no patch', () => {
    expect(profilePatch({ name: '', venmo: 'sam-okafor' }, saved)).toEqual({ patch: null, error: NAME_EMPTY });
    expect(profilePatch({ name: 'Sam', venmo: 'no' }, saved)).toEqual({ patch: null, error: VENMO_INVALID });
  });
});

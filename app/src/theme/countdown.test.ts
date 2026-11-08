import { describe, expect, it } from 'vitest';
import { countdownParts } from './countdown';

describe('countdownParts', () => {
  it('formats mm:ss under an hour and h:mm:ss above', () => {
    expect(countdownParts(22 * 60_000 + 14_000).text).toBe('22:14');
    expect(countdownParts(5_000).text).toBe('0:05');
    expect(countdownParts(3_600_000).text).toBe('1:00:00');
    expect(countdownParts(2 * 3_600_000 + 3 * 60_000 + 9_000).text).toBe('2:03:09');
  });
  it('never goes negative and reports done at zero', () => {
    expect(countdownParts(-5_000)).toMatchObject({ text: '0:00', done: true, urgent: false });
    expect(countdownParts(0).done).toBe(true);
    expect(countdownParts(999).text).toBe('0:00');
  });
  it('builds a VoiceOver label in words', () => {
    expect(countdownParts(22 * 60_000 + 14_000).label).toBe('22 minutes 14 seconds left');
    expect(countdownParts(61_000).label).toBe('1 minute 1 second left');
    expect(countdownParts(3_600_000 + 1_000).label).toBe('1 hour 0 minutes 1 second left');
    expect(countdownParts(30_000, 'until it opens').label).toBe('30 seconds until it opens');
  });
  it('flags the last minute as urgent', () => {
    expect(countdownParts(60_000).urgent).toBe(true);
    expect(countdownParts(61_000).urgent).toBe(false);
    expect(countdownParts(1_000).urgent).toBe(true);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import {
  SKEW_NOTICE_THRESHOLD_MS,
  clockSkewCopy,
  recordServerDate,
  serverDeadlineLine,
  resetServerTimeForTests,
  serverNow,
  serverOffsetMs,
  subscribeServerOffset,
} from './serverTime';

const T = Date.UTC(2026, 10, 7, 17, 0, 0); // 2026-11-07T17:00:00Z
const httpDate = (ms: number) => new Date(ms).toUTCString();

describe('serverTime: offset estimate from Date headers', () => {
  beforeEach(() => resetServerTimeForTests());

  it('starts with no offset: serverNow is the device clock', () => {
    expect(serverOffsetMs()).toBe(0);
    expect(serverNow(T)).toBe(T);
  });

  it('a Date header equal to the device clock gives a sub-second offset (header has 1 s resolution)', () => {
    recordServerDate(httpDate(T), T);
    expect(Math.abs(serverOffsetMs())).toBeLessThan(1000);
  });

  it('a server 4 minutes ahead gives a positive offset and serverNow moves forward', () => {
    recordServerDate(httpDate(T + 4 * 60_000), T);
    expect(serverOffsetMs()).toBeGreaterThan(3.9 * 60_000);
    expect(serverOffsetMs()).toBeLessThan(4.1 * 60_000);
    expect(serverNow(T)).toBeGreaterThan(T + 3.9 * 60_000);
  });

  it('a server behind the device gives a negative offset', () => {
    recordServerDate(httpDate(T - 10 * 60_000), T);
    expect(serverOffsetMs()).toBeLessThan(-9.9 * 60_000);
  });

  it('ignores unparsable or missing headers', () => {
    recordServerDate(null, T);
    recordServerDate('', T);
    recordServerDate('not a date', T);
    expect(serverOffsetMs()).toBe(0);
  });

  it('uses the median of recent samples so one slow response cannot fake a skew', () => {
    for (let i = 0; i < 4; i += 1) recordServerDate(httpDate(T + i * 1000), T + i * 1000);
    recordServerDate(httpDate(T + 5000 + 9 * 60_000), T + 5000); // one wild sample
    expect(Math.abs(serverOffsetMs())).toBeLessThan(1000);
  });

  it('forgets old samples: five consistent new readings replace the old estimate', () => {
    recordServerDate(httpDate(T + 5 * 60_000), T);
    expect(serverOffsetMs()).toBeGreaterThan(4 * 60_000);
    for (let i = 1; i <= 5; i += 1) recordServerDate(httpDate(T + i * 1000), T + i * 1000);
    expect(Math.abs(serverOffsetMs())).toBeLessThan(1000);
  });

  it('notifies subscribers when the estimate changes, and stops after unsubscribe', () => {
    const seen: number[] = [];
    const off = subscribeServerOffset((ms) => seen.push(ms));
    recordServerDate(httpDate(T + 3 * 60_000), T);
    expect(seen).toHaveLength(1);
    off();
    recordServerDate(httpDate(T + 6 * 60_000), T);
    expect(seen).toHaveLength(1);
  });
});

describe('serverTime: the clock-skew notice', () => {
  it('threshold is two minutes', () => {
    expect(SKEW_NOTICE_THRESHOLD_MS).toBe(2 * 60_000);
  });

  it('is silent under the threshold, either direction', () => {
    expect(clockSkewCopy(0)).toBeNull();
    expect(clockSkewCopy(119_000)).toBeNull();
    expect(clockSkewCopy(-119_000)).toBeNull();
  });

  it('a positive offset (server ahead) means the phone is behind', () => {
    expect(clockSkewCopy(4 * 60_000)).toBe("Your phone's clock is 4 min behind the server. Deadlines use server time.");
  });

  it('a negative offset means the phone is ahead', () => {
    expect(clockSkewCopy(-3 * 60_000)).toBe("Your phone's clock is 3 min ahead of the server. Deadlines use server time.");
  });

  it('rounds to whole minutes and uses hours past sixty', () => {
    expect(clockSkewCopy(2 * 60_000 + 29_000)).toMatch(/^Your phone's clock is 2 min behind/);
    expect(clockSkewCopy(2 * 60_000 + 31_000)).toMatch(/^Your phone's clock is 3 min behind/);
    expect(clockSkewCopy(65 * 60_000)).toMatch(/^Your phone's clock is 1 h 5 min behind/);
    expect(clockSkewCopy(-120 * 60_000)).toMatch(/^Your phone's clock is 2 h ahead/);
  });
});

describe('serverTime: the deadline by the server clock', () => {
  it('says how far the deadline is by the server clock', () => {
    expect(serverDeadlineLine('9:00 AM', 11 * 60_000 + 20_000)).toBe("By the server's clock, 9:00 AM is in 11 min.");
    expect(serverDeadlineLine('9:00 AM', 75 * 60_000)).toBe("By the server's clock, 9:00 AM is in 1 h 15 min.");
  });

  it('handles the last minute and a passed deadline', () => {
    expect(serverDeadlineLine('9:00 AM', 40_000)).toBe("By the server's clock, 9:00 AM is less than a minute away.");
    expect(serverDeadlineLine('9:00 AM', 0)).toBe("By the server's clock, 9:00 AM has passed.");
    expect(serverDeadlineLine('9:00 AM', -5 * 60_000)).toBe("By the server's clock, 9:00 AM has passed.");
  });
});

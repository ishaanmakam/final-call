import { describe, expect, it } from 'vitest';
import { GATE_CLOSE_POLL_FOR_MS, GATE_CLOSE_POLL_MS, gateClosePollInterval, type GatePollInput } from './gatePoll';

const DEADLINE = Date.parse('2026-11-07T17:00:00Z');
const d = (over: Partial<GatePollInput> = {}): GatePollInput => ({
  instance: { deadline_at: '2026-11-07T17:00:00Z', status: 'open' },
  myPlace: {},
  myResult: null,
  ...over,
});

describe('gateClosePollInterval', () => {
  it('does not poll before the deadline or without data', () => {
    expect(gateClosePollInterval(undefined, DEADLINE + 1000)).toBe(false);
    expect(gateClosePollInterval(d(), DEADLINE - 1)).toBe(false);
  });

  it('polls every 10 s from the deadline while the server has not closed the day', () => {
    expect(gateClosePollInterval(d(), DEADLINE)).toBe(GATE_CLOSE_POLL_MS);
    expect(gateClosePollInterval(d(), DEADLINE + 2 * 60_000)).toBe(GATE_CLOSE_POLL_MS);
    expect(gateClosePollInterval(d({ instance: { deadline_at: '2026-11-07T17:00:00Z', status: 'scheduled' } }), DEADLINE + 5000)).toBe(GATE_CLOSE_POLL_MS);
  });

  it('keeps polling after close until my result is readable', () => {
    const closed = { deadline_at: '2026-11-07T17:00:00Z', status: 'closed' as const };
    expect(gateClosePollInterval(d({ instance: closed }), DEADLINE + 5000)).toBe(GATE_CLOSE_POLL_MS);
    expect(gateClosePollInterval(d({ instance: closed, myResult: { status: 'pending' } }), DEADLINE + 5000)).toBe(GATE_CLOSE_POLL_MS);
    expect(gateClosePollInterval(d({ instance: closed, myResult: { status: 'success' } }), DEADLINE + 5000)).toBe(false);
    expect(gateClosePollInterval(d({ instance: closed, myResult: { status: 'failed' } }), DEADLINE + 5000)).toBe(false);
  });

  it('a non-participant has nothing to wait for once the day is closed', () => {
    const closed = { deadline_at: '2026-11-07T17:00:00Z', status: 'closed' as const };
    expect(gateClosePollInterval(d({ instance: closed, myPlace: null }), DEADLINE + 5000)).toBe(false);
  });

  it('gives up after three minutes', () => {
    expect(gateClosePollInterval(d(), DEADLINE + GATE_CLOSE_POLL_FOR_MS)).toBe(GATE_CLOSE_POLL_MS);
    expect(gateClosePollInterval(d(), DEADLINE + GATE_CLOSE_POLL_FOR_MS + 1)).toBe(false);
  });
});

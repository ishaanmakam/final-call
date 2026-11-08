import { describe, expect, it } from 'vitest';
import type { InstanceMemberNetRow, ResultRow } from '../../api/types';
import { TALLY_PATIENCE_MS, firstName, gateClose, joinNames, type GateCloseInput } from './gateClose';

const ME = 'me';
const profiles = new Map([
  [ME, { display_name: 'Sam Lee' }],
  ['u-dev', { display_name: 'Dev Patel' }],
  ['u-jordan', { display_name: 'Jordan' }],
  ['u-maya', { display_name: 'Maya Chen' }],
  ['u-priya', { display_name: 'Priya' }],
]);

const result = (user_id: string, status: ResultRow['status']): ResultRow => ({
  instance_id: 'i1',
  user_id,
  status,
  first_success_at: status === 'success' ? '2026-11-07T16:40:00Z' : null,
  decided_at: '2026-11-07T17:00:30Z',
});
const net = (user_id: string, net_cents: number, pot_cents: number): InstanceMemberNetRow => ({ instance_id: 'i1', group_id: 'g1', user_id, net_cents, pot_cents });

function input(over: Partial<GateCloseInput> = {}): GateCloseInput {
  return {
    userId: ME,
    instanceStatus: 'closed',
    myResult: null,
    results: [],
    nets: [],
    profiles,
    stakeCents: 500,
    carryInCents: 0,
    frozen: false,
    sinceDeadlineMs: 20_000,
    ...over,
  };
}

describe('names', () => {
  it('first names, "and" joins', () => {
    expect(firstName('Dev Patel')).toBe('Dev');
    expect(firstName('  Jordan ')).toBe('Jordan');
    expect(firstName(null)).toBe('A friend');
    expect(joinNames([])).toBe('');
    expect(joinNames(['Maya'])).toBe('Maya');
    expect(joinNames(['Dev', 'Jordan'])).toBe('Dev and Jordan');
    expect(joinNames(['Maya', 'Priya', 'Dev'])).toBe('Maya, Priya and Dev');
  });
});

describe('tallying', () => {
  it('right after the deadline, while the server has not closed the day', () => {
    const g = gateClose(input({ instanceStatus: 'open' }));
    expect(g).toMatchObject({ state: 'tallying', headline: 'Gate closed · tallying…', subline: 'Results post within a minute.', tone: 'neutral', haptic: null });
    expect(g.pill).toBeUndefined();
    expect(g.amount).toBeUndefined();
  });

  it('closed by the server but my result not yet readable: still tallying', () => {
    expect(gateClose(input({ instanceStatus: 'closed', myResult: null })).state).toBe('tallying');
    expect(gateClose(input({ myResult: result(ME, 'pending') })).state).toBe('tallying');
  });

  it('after three minutes it stops promising and asks for a pull to refresh', () => {
    const g = gateClose(input({ instanceStatus: 'open', sinceDeadlineMs: TALLY_PATIENCE_MS + 1 }));
    expect(g.headline).toBe('Gate closed');
    expect(g.subline).toBe('Results post within a minute or two; pull to refresh.');
    expect(g.compact).toBe('Gate closed · results on their way');
  });

  it('a result row only counts once the instance has left the window', () => {
    // the server never writes results before closing, but the client must not trust a stale cache
    expect(gateClose(input({ instanceStatus: 'open', myResult: result(ME, 'success') })).state).toBe('tallying');
  });
});

describe('posted: you showed up', () => {
  it('headline carries the winnings, subline who missed and how the pool split', () => {
    const results = [result(ME, 'success'), result('u-maya', 'success'), result('u-priya', 'success'), result('u-dev', 'failed'), result('u-jordan', 'failed')];
    const nets = [net(ME, 334, 1000), net('u-maya', 333, 1000), net('u-priya', 333, 1000), net('u-dev', -500, 1000), net('u-jordan', -500, 1000)];
    const g = gateClose(input({ myResult: results[0]!, results, nets }));
    expect(g.state).toBe('posted');
    expect(g.headline).toBe("You're +$3.34 today");
    expect(g.amount).toEqual({ before: "You're ", cents: 334, after: ' today' });
    expect(g.subline).toBe('Dev and Jordan missed · pool $10.00 split 3 ways');
    expect(g.tone).toBe('success');
    expect(g.pill).toBe('success');
    expect(g.haptic).toBe('success');
    expect(g.compact).toBe('+$3.34 · Dev and Jordan missed');
  });

  it('one winner: the pool is yours; carry-over is named', () => {
    const results = [result(ME, 'success'), result('u-dev', 'failed'), result('u-maya', 'frozen')];
    const nets = [net(ME, 900, 900), net('u-dev', -500, 900)];
    const g = gateClose(input({ myResult: results[0]!, results, nets, carryInCents: 400 }));
    expect(g.headline).toBe("You're +$9.00 today");
    expect(g.subline).toBe('Dev missed · the $9.00 pool ($4.00 carried over) is yours');
  });

  it('nobody missed: no money moves, no haptic', () => {
    const results = [result(ME, 'success'), result('u-maya', 'success'), result('u-priya', 'unverified')];
    const g = gateClose(input({ myResult: results[0]!, results, nets: [] }));
    expect(g.headline).toBe('You made it');
    expect(g.amount).toBeUndefined();
    expect(g.subline).toBe('Everyone made it · no pledge moved');
    expect(g.haptic).toBeNull();
    expect(g.compact).toBe('Showed up · Everyone made it');
  });

  it('only carry-over paid out: nobody missed but the pool was there', () => {
    const results = [result(ME, 'success'), result('u-maya', 'success')];
    const nets = [net(ME, 200, 400), net('u-maya', 200, 400)];
    const g = gateClose(input({ myResult: results[0]!, results, nets, carryInCents: 400 }));
    expect(g.headline).toBe("You're +$2.00 today");
    expect(g.subline).toBe('Everyone made it · pool $4.00 ($4.00 carried over) split 2 ways');
  });
});

describe('posted: you missed', () => {
  it('forfeit headline with the amount, who showed up, appeal footnote, warning haptic', () => {
    const results = [result(ME, 'failed'), result('u-maya', 'success'), result('u-priya', 'success'), result('u-dev', 'success')];
    const nets = [net(ME, -500, 500), net('u-maya', 167, 500), net('u-priya', 167, 500), net('u-dev', 166, 500)];
    const g = gateClose(input({ myResult: results[0]!, results, nets }));
    expect(g.headline).toBe('You forfeited $5.00');
    expect(g.amount).toEqual({ before: 'You forfeited ', cents: 500, after: '' });
    expect(g.subline).toBe('Maya, Priya and Dev showed up');
    expect(g.footnote).toMatch(/appeal it in the feed/);
    expect(g.tone).toBe('forfeit');
    expect(g.pill).toBe('failed');
    expect(g.haptic).toBe('warning');
    expect(g.compact).toBe('Forfeited $5.00 · Maya, Priya and Dev showed up');
  });

  it('everyone missed: the pool carries over', () => {
    const results = [result(ME, 'failed'), result('u-maya', 'failed')];
    const nets = [net(ME, -500, 1000), net('u-maya', -500, 1000)];
    const g = gateClose(input({ myResult: results[0]!, results, nets }));
    expect(g.headline).toBe('You forfeited $5.00');
    expect(g.subline).toBe('Nobody made it · the $10.00 pool carries over');
  });

  it('missed with nobody to split with: no money moved, said plainly', () => {
    const results = [result(ME, 'failed'), result('u-maya', 'unverified')];
    const g = gateClose(input({ myResult: results[0]!, results, nets: [] }));
    expect(g.headline).toBe('You missed · no pledge moved');
    expect(g.amount).toBeUndefined();
    expect(g.haptic).toBe('warning');
  });
});

describe('posted: outcomes that move no pledge', () => {
  it('unverified', () => {
    const results = [result(ME, 'unverified'), result('u-maya', 'success'), result('u-dev', 'failed')];
    const g = gateClose(input({ myResult: results[0]!, results, nets: [net('u-maya', 500, 500), net('u-dev', -500, 500)] }));
    expect(g.headline).toBe('Unverified · no pledge moved');
    expect(g.subline).toBe('Maya showed up · Dev missed');
    expect(g.footnote).toMatch(/never costs a pledge/);
    expect(g.tone).toBe('neutral');
    expect(g.pill).toBe('unverified');
    expect(g.haptic).toBeNull();
    expect(g.compact).toBe('Unverified · no pledge moved');
  });

  it('frozen, including before the server posts anything (a freeze is known in advance)', () => {
    const early = gateClose(input({ instanceStatus: 'open', frozen: true }));
    expect(early.state).toBe('posted');
    expect(early.headline).toBe('Frozen · no pledge moved');
    expect(early.subline).toBe('You called today off in advance.');
    const results = [result(ME, 'frozen'), result('u-maya', 'success'), result('u-priya', 'unverified')];
    const later = gateClose(input({ myResult: results[0]!, results, frozen: true }));
    expect(later.subline).toBe('Maya showed up · Priya unverified');
    expect(later.pill).toBe('frozen');
  });

  it('void and excluded', () => {
    const v = gateClose(input({ instanceStatus: 'voided', myResult: result(ME, 'void'), results: [result(ME, 'void'), result('u-maya', 'void')] }));
    expect(v.headline).toBe("Didn't count · fewer than two people were in it");
    expect(v.subline).toBe('No pledge moved.');
    expect(v.pill).toBe('void');
    const e = gateClose(input({ myResult: result(ME, 'excluded'), results: [result(ME, 'excluded')] }));
    expect(e.headline).toBe('Excluded · no pledge moved');
    expect(e.pill).toBe('excluded');
  });

  it('never uses code words', () => {
    const cases: GateCloseInput[] = [
      input({ instanceStatus: 'open' }),
      input({ myResult: result(ME, 'success'), results: [result(ME, 'success'), result('u-dev', 'failed')], nets: [net(ME, 500, 500), net('u-dev', -500, 500)] }),
      input({ myResult: result(ME, 'failed'), results: [result(ME, 'failed'), result('u-dev', 'success')], nets: [net(ME, -500, 500), net('u-dev', 500, 500)] }),
      input({ myResult: result(ME, 'unverified'), results: [result(ME, 'unverified')] }),
      input({ myResult: result(ME, 'void'), results: [result(ME, 'void')] }),
    ];
    for (const c of cases) {
      const g = gateClose(c);
      expect(`${g.headline} ${g.subline} ${g.footnote ?? ''} ${g.compact}`).not.toMatch(/\b(stake|pot|bet|wager|rake|ledger)\b/i);
    }
  });
});

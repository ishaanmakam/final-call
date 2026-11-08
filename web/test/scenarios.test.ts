import { simplifyDebts } from '@final-call/rules';
import { describe, expect, it } from 'vitest';
import {
  SCENARIOS,
  SCENARIO_ORDER,
  billableBalances,
  carryBalance,
  conservation,
  createWorld,
  instanceById,
  memberBalances,
  obligationsMatchOracle,
  retick,
  runScenario,
  type World,
} from '../src/sim';

function checkStep(w: World, label: string) {
  const c = conservation(w);
  expect(c.ok, `${label}: ${JSON.stringify(c)}`).toBe(true);
  expect(c.membersTotal + c.carry, label).toBe(0);
  // re-running the jobs at the same clock is a no-op
  expect(retick(w), `${label}: tick not idempotent`).toEqual(w);
  // the live obligations are exactly the oracle's
  expect(obligationsMatchOracle(w), `${label}: obligations differ from simplifyDebts`).toBe(true);
}

describe('preset scenarios', () => {
  for (const name of SCENARIO_ORDER) {
    it(`${SCENARIOS[name].title}: conservation, idempotency and oracle obligations hold after every step`, () => {
      let w = createWorld();
      for (const step of SCENARIOS[name].steps) {
        w = step.apply(w);
        checkStep(w, `${name} / ${step.label}`);
      }
      expect(w.settlements).toHaveLength(1);
    });
  }

  it('typical week ends with the expected balances', () => {
    const w = runScenario('typical_week').at(-1)!;
    // Tue: Diego's 500 split 167/167/166 (you 8:00, Maya 8:12, Priya 8:40); Thu: Diego's 500 split 167/167/166
    expect(memberBalances(w)).toEqual({ you: 334, maya: 334, priya: 332, diego: -1000 });
    expect(w.obligations.map((o) => `${o.from}->${o.to}:${o.amountCents}`)).toEqual(['diego->maya:334', 'diego->you:334', 'diego->priya:332']);
    expect(instanceById(w, 'inst-2026-11-11').results.priya?.status).toBe('unverified');
  });

  it('carry: an all-fail Tuesday rolls 2000 into the carry and Wednesday pays it out', () => {
    const steps = runScenario('carry');
    const afterTue = steps[1]!;
    expect(carryBalance(afterTue)).toBe(2000);
    expect(afterTue.refusedTaps).toHaveLength(1);
    const afterWed = steps[2]!;
    expect(carryBalance(afterWed)).toBe(0);
    expect(instanceById(afterWed, 'inst-2026-11-11').carryInCents).toBe(2000);
    expect(memberBalances(afterWed)).toEqual({ you: 1000, maya: 1000, diego: -1000, priya: -1000 });
  });

  it('GPS trouble: the third unverified day opens an automatic challenge; upheld, it costs the pledge', () => {
    const steps = runScenario('gps_trouble');
    const afterWed = steps[2]!;
    expect(afterWed.reviews).toHaveLength(1);
    expect(afterWed.reviews[0]).toMatchObject({ systemOpened: true, subject: 'you', status: 'open' });
    const afterTie = steps[3]!;
    expect(afterTie.reviews[0]?.status).toBe('open');
    const afterPriya = steps[5]!;
    expect(afterPriya.reviews[0]?.status).toBe('accepted');
    expect(instanceById(afterPriya, 'inst-2026-11-11').results.you?.status).toBe('failed');
    expect(afterPriya.entries.some((e) => e.kind === 'correction')).toBe(false); // nothing was posted on Wed before, so stake+payout post fresh
    expect(memberBalances(afterPriya).you).toBe(-500);
  });

  it('drama week: an upheld appeal, a tie that defaults, two late taps, and corrections for each', () => {
    const steps = runScenario('drama_week');
    const afterAppeal = steps[1]!;
    expect(afterAppeal.reviews[0]?.status).toBe('accepted');
    expect(instanceById(afterAppeal, 'inst-2026-11-09').results.diego?.status).toBe('success');
    expect(afterAppeal.entries.filter((e) => e.kind === 'correction')).toHaveLength(1);
    const afterTie = steps[3]!;
    expect(afterTie.reviews[1]?.status).toBe('open');
    const afterWed = steps[4]!;
    expect(instanceById(afterWed, 'inst-2026-11-11').results.you?.status).toBe('unverified');
    expect(afterWed.entries.filter((e) => e.kind === 'correction')).toHaveLength(2);
    const afterThu = steps[5]!;
    expect(instanceById(afterThu, 'inst-2026-11-12').results.maya?.status).toBe('failed'); // her tap lands 4 min after close
    expect(memberBalances(afterThu)).toEqual({ you: 500, priya: 500, diego: -500, maya: -500 }); // two pledges split between you and Priya
    const afterFri = steps[6]!;
    expect(instanceById(afterFri, 'inst-2026-11-12').results.maya?.status).toBe('unverified');
    expect(afterFri.entries.filter((e) => e.kind === 'correction')).toHaveLength(3);
    expect(memberBalances(afterFri)).toEqual({ you: 250, priya: 250, diego: -500, maya: 0 });
    const final = steps.at(-1)!;
    expect(final.obligations.map((o) => `${o.from}->${o.to}:${o.amountCents}`)).toEqual(['diego->priya:250', 'diego->you:250']);
    expect(final.reviews[1]?.status).toBe('rejected');
    expect(instanceById(final, 'inst-2026-11-10').results.priya?.status).toBe('unverified');
    const expected = simplifyDebts(billableBalances(final)).obligations;
    expect(expected.length).toBeGreaterThan(0);
    expect(final.obligations.filter((o) => o.status !== 'superseded').map((o) => ({ from: o.from, to: o.to, amountCents: o.amountCents }))).toEqual(expected);
  });
});

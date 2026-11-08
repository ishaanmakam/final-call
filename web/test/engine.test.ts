import { checkinVerdict, computeInstancePayout, simplifyDebts } from '@final-call/rules';
import { describe, expect, it } from 'vitest';
import {
  MINUTE,
  advanceTo,
  billableBalances,
  canOpenReview,
  castVote,
  checkIn,
  confirmObligation,
  conservation,
  createWorld,
  disputeObligation,
  eligibleVoters,
  freezeToday,
  instanceById,
  markObligationPaid,
  memberBalances,
  memberDeltaFor,
  carryBalance,
  obligationsMatchOracle,
  openInstance,
  openReview,
  phaseOf,
  previewVerdict,
  retick,
  setBehaviour,
  setGps,
  setLocationMode,
  setOnline,
  transition,
  transitionTarget,
  youDeltaFor,
  youFix,
  memberById,
  type World,
} from '../src/sim';

const MON = 'inst-2026-11-09';
const TUE = 'inst-2026-11-10';
const WED = 'inst-2026-11-11';

const allOnTime = (w: World) => ['maya', 'diego', 'priya'].reduce((acc, id) => setBehaviour(acc, id as 'maya', 'on_time'), w);

function expectConserved(w: World) {
  const c = conservation(w);
  expect(c, JSON.stringify(c)).toMatchObject({ ok: true, total: 0, nonEmptyPots: [] });
  expect(c.membersTotal + c.carry).toBe(0);
}

/** Re-running the jobs at the same clock must change nothing (idempotent tick). */
function expectIdempotent(w: World) {
  const again = retick(w);
  expect(again).toEqual(w);
}

describe('world', () => {
  it('starts Monday Nov 9 2026 at 7:00 Pacific with five scheduled weekdays ahead', () => {
    const w = createWorld();
    expect(new Date(w.now).toISOString()).toBe('2026-11-09T15:00:00.000Z');
    expect(w.instances.slice(0, 5).map((i) => i.localDate)).toEqual(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']);
    expect(w.instances.every((i) => i.status === 'scheduled')).toBe(true);
    const mon = instanceById(w, MON);
    expect(new Date(mon.windowOpenAt).toISOString()).toBe('2026-11-09T16:00:00.000Z');
    expect(new Date(mon.deadlineAt).toISOString()).toBe('2026-11-09T17:00:00.000Z');
    expectConserved(w);
    expectIdempotent(w);
  });

  it('never moves the clock backwards', () => {
    const w = createWorld();
    expect(advanceTo(w, w.now - MINUTE)).toBe(w);
  });
});

describe('fence playground', () => {
  it('reads the verdict from the oracle for the dot as positioned', () => {
    let w = createWorld();
    expect(previewVerdict(w).verdict).toBe('in_fence');
    w = setGps(w, { dx: 100, dy: 0, accuracyM: 12 });
    const v = previewVerdict(w);
    expect(v.verdict).toBe('out_of_fence');
    expect(v.distanceM).toBeGreaterThan(99);
    expect(v.distanceM).toBeLessThan(101);
    // the uncertainty circle touching the fence counts (100 - 30 <= 75)
    expect(previewVerdict(setGps(w, { accuracyM: 30 })).verdict).toBe('in_fence');
    expect(previewVerdict(setGps(w, { accuracyM: 201 })).verdict).toBe('unjudgeable');
    // same answer as calling the oracle directly
    const place = memberById(w, 'you').place;
    expect(previewVerdict(w)).toEqual(checkinVerdict(youFix(w), place));
  });
});

describe('a single day', () => {
  it('Boarding opens the window, Final call is 15 minutes before, Gate closed judges everyone', () => {
    let w = allOnTime(createWorld());
    w = transition(w, 'next_window');
    const open = openInstance(w)!;
    expect(open.id).toBe(MON);
    expect(phaseOf(w, open)).toBe('boarding');
    expect(w.events.some((e) => e.kind === 'boarding')).toBe(true);
    w = transition(w, 'final_call');
    expect(phaseOf(w, openInstance(w)!)).toBe('final_call');
    expect(w.events.some((e) => e.kind === 'final_call')).toBe(true);
    const r = checkIn(w);
    expect(r.outcome.kind).toBe('sent');
    w = r.world;
    w = transition(w, 'gate_closed');
    const mon = instanceById(w, MON);
    expect(mon.status).toBe('closed');
    expect(Object.values(mon.results).every((x) => x.status === 'success')).toBe(true);
    expect(w.entries).toHaveLength(0);
    expect(w.events.at(-1)?.kind).toBe('gate_closed');
    expectConserved(w);
    expectIdempotent(w);
  });

  it('pays the pool to the people who showed up, leftover cents to the earliest taps (oracle)', () => {
    let w = allOnTime(createWorld());
    w = setBehaviour(w, 'diego', 'no_show');
    w = transition(w, 'next_window');
    w = checkIn(w).world; // 8:00, earliest
    w = transition(w, 'gate_closed');
    const mon = instanceById(w, MON);
    const expected = computeInstancePayout({ stakeCents: 500, carryInCents: 0, results: mon.roster.map((id) => mon.results[id]!) });
    const balances = memberBalances(w);
    for (const [id, v] of Object.entries(expected.memberDeltas)) expect(balances[id as 'you']).toBe(v);
    expect(balances).toEqual({ you: 167, maya: 167, priya: 166, diego: -500 });
    expect(w.entries.map((e) => e.kind)).toEqual(['stake', 'payout']);
    expectConserved(w);
    expectIdempotent(w);
  });

  it('an out-of-fence tap followed by an in-fence tap is a success; a tap outside only is a miss', () => {
    let w = allOnTime(createWorld());
    w = transition(w, 'next_window');
    w = setGps(w, { dx: 150, dy: 0, accuracyM: 12 });
    const first = checkIn(w);
    expect(first.outcome.kind === 'sent' && first.outcome.checkin.verdict).toBe('out_of_fence');
    w = transition(first.world, 'gate_closed');
    expect(instanceById(w, MON).results.you?.status).toBe('failed');
    expect(youDeltaFor(w, MON)).toBe(-500);

    let w2 = allOnTime(createWorld());
    w2 = transition(w2, 'next_window');
    w2 = setGps(w2, { dx: 150, dy: 0, accuracyM: 12 });
    w2 = checkIn(w2).world;
    w2 = setGps(w2, { dx: 10, dy: 0, accuracyM: 12 });
    w2 = checkIn(w2).world;
    w2 = transition(w2, 'gate_closed');
    expect(instanceById(w2, MON).results.you?.status).toBe('success');
    expectConserved(w);
    expectConserved(w2);
  });

  it('weak GPS is unverified and never costs money', () => {
    let w = allOnTime(createWorld());
    w = setBehaviour(w, 'diego', 'no_show');
    w = transition(w, 'next_window');
    w = setGps(w, { accuracyM: 350 });
    w = checkIn(w).world;
    w = transition(w, 'gate_closed');
    const mon = instanceById(w, MON);
    expect(mon.results.you?.status).toBe('unverified');
    expect(youDeltaFor(w, MON)).toBe(0);
    expect(memberBalances(w).diego).toBe(-500);
    expectConserved(w);
  });

  it('a friend who is frozen or unverified is left out of the pool; fewer than two active voids the day', () => {
    let w = createWorld();
    w = setBehaviour(w, 'maya', 'frozen');
    w = setBehaviour(w, 'diego', 'no_gps');
    w = setBehaviour(w, 'priya', 'late_offline');
    w = transition(w, 'next_window');
    w = checkIn(w).world;
    w = transition(w, 'gate_closed');
    let mon = instanceById(w, MON);
    // at the deadline Priya's offline tap has not arrived: she is failed, so two are active and you win her pledge
    expect(mon.status).toBe('closed');
    expect(mon.results.you?.status).toBe('success');
    expect(mon.results.maya?.status).toBe('frozen');
    expect(mon.results.diego?.status).toBe('unverified');
    expect(mon.results.priya?.status).toBe('failed');
    expect(memberBalances(w)).toEqual({ you: 500, maya: 0, diego: 0, priya: -500 });
    expectConserved(w);
    // four minutes later her tap lands: late in-fence → unverified, only one active left → the day is void
    // and a correction reverses the pool (RT-2: the unverified and frozen results stay on record)
    w = advanceTo(w, mon.deadlineAt + 5 * MINUTE);
    mon = instanceById(w, MON);
    expect(mon.status).toBe('voided');
    expect(mon.results.priya?.status).toBe('unverified');
    expect(mon.results.you?.status).toBe('void');
    expect(mon.results.maya?.status).toBe('frozen');
    expect(w.entries.map((e) => e.kind)).toEqual(['stake', 'payout', 'correction']);
    expect(memberBalances(w)).toEqual({ you: 0, maya: 0, diego: 0, priya: 0 });
    expectConserved(w);
    expectIdempotent(w);
  });

  it('refuses to check in with Approximate Location and shows what the rules would have said', () => {
    let w = allOnTime(createWorld());
    w = transition(w, 'next_window');
    w = setLocationMode(w, 'approximate');
    const r = checkIn(w);
    expect(r.outcome).toEqual({ kind: 'refused', mode: 'approximate' });
    expect(r.world.checkins.filter((c) => c.userId === 'you')).toHaveLength(0);
    expect(r.world.refusedTaps[0]?.wouldHave).toMatchObject({ verdict: 'unjudgeable', status: 'unverified' });
    w = transition(r.world, 'gate_closed');
    expect(instanceById(w, MON).results.you?.status).toBe('failed');
    expect(youDeltaFor(w, MON)).toBe(-500);
    expectConserved(w);
  });

  it('with location denied nothing is sent and the day is missed', () => {
    let w = allOnTime(createWorld());
    w = transition(w, 'next_window');
    w = setLocationMode(w, 'denied');
    const r = checkIn(w);
    expect(r.outcome).toEqual({ kind: 'refused', mode: 'denied' });
    expect(r.world.refusedTaps[0]?.wouldHave).toMatchObject({ verdict: null, status: 'failed' });
    w = transition(r.world, 'gate_closed');
    expect(instanceById(w, MON).results.you?.status).toBe('failed');
  });

  it('an offline tap is queued; sent after the deadline it turns a miss into unverified with a correction', () => {
    let w = allOnTime(createWorld());
    w = transition(w, 'next_window');
    w = setOnline(w, false);
    const r = checkIn(w);
    expect(r.outcome.kind).toBe('queued');
    w = transition(r.world, 'gate_closed');
    expect(instanceById(w, MON).results.you?.status).toBe('failed');
    expect(youDeltaFor(w, MON)).toBe(-500);
    expectConserved(w);
    w = setOnline(w, true);
    const mon = instanceById(w, MON);
    expect(mon.results.you?.status).toBe('unverified');
    expect(youDeltaFor(w, MON)).toBe(0);
    expect(w.entries.map((e) => e.kind)).toEqual(['stake', 'payout', 'correction']);
    expect(w.entries[2]?.idempotencyKey).toBe(`correction:${MON}:1`);
    expectConserved(w);
    expectIdempotent(w);
  });

  it('an offline tap sent before the deadline simply counts', () => {
    let w = allOnTime(createWorld());
    w = transition(w, 'next_window');
    w = setOnline(w, false);
    w = checkIn(w).world;
    w = setOnline(w, true);
    w = transition(w, 'gate_closed');
    expect(instanceById(w, MON).results.you?.status).toBe('success');
  });

  it('you can freeze the next day before its window opens, once a week', () => {
    let w = allOnTime(createWorld());
    w = freezeToday(w);
    expect(w.freezes).toHaveLength(1);
    w = transition(w, 'next_window');
    expect(checkIn(w).outcome.kind).toBe('frozen');
    w = transition(w, 'gate_closed');
    expect(instanceById(w, MON).results.you?.status).toBe('frozen');
    const again = freezeToday(w);
    expect(again.freezes).toHaveLength(1);
  });
});

describe('carry', () => {
  it('rolls every pledge into the carry when nobody shows up, then pays it out with the next pool', () => {
    let w = createWorld();
    for (const id of ['maya', 'diego', 'priya'] as const) w = setBehaviour(w, id, 'no_show');
    w = transition(w, 'next_window');
    w = transition(w, 'gate_closed');
    expect(carryBalance(w)).toBe(2000);
    expect(memberBalances(w)).toEqual({ you: -500, maya: -500, diego: -500, priya: -500 });
    expect(w.entries.map((e) => e.kind)).toEqual(['stake', 'rollover']);
    expectConserved(w);
    w = setBehaviour(w, 'maya', 'on_time');
    w = transition(w, 'next_window');
    w = checkIn(w).world;
    w = transition(w, 'gate_closed');
    const tue = instanceById(w, TUE);
    expect(tue.carryInCents).toBe(2000);
    expect(carryBalance(w)).toBe(0);
    // pool = 2 × 500 + 2000 = 3000, split between you and Maya
    expect(memberBalances(w)).toEqual({ you: 1000, maya: 1000, diego: -1000, priya: -1000 });
    expectConserved(w);
    expectIdempotent(w);
  });
});

describe('reviews', () => {
  function mondayDiegoOutside(): World {
    let w = allOnTime(createWorld());
    w = setBehaviour(w, 'diego', 'out_of_fence');
    w = transition(w, 'next_window');
    w = checkIn(w).world;
    return transition(w, 'gate_closed');
  }

  it('an appeal upheld by a majority of eligible voters turns the miss into a success at the deadline and posts a correction', () => {
    let w = mondayDiegoOutside();
    expect(memberBalances(w).diego).toBe(-500);
    expect(canOpenReview(w, MON, 'diego', 'appeal', 'diego')).toBe(true);
    expect(canOpenReview(w, MON, 'diego', 'appeal', 'you')).toBe(false);
    w = openReview(w, MON, 'diego', 'appeal', 'diego', 'I was there');
    const review = w.reviews[0]!;
    expect(eligibleVoters(w, review)).toEqual(['you', 'maya', 'priya']);
    w = castVote(w, review.id, 'you', true);
    expect(w.reviews[0]?.status).toBe('open');
    w = castVote(w, review.id, 'maya', true);
    expect(w.reviews[0]?.status).toBe('accepted');
    const mon = instanceById(w, MON);
    expect(mon.results.diego).toEqual({ userId: 'diego', status: 'success', firstSuccessAt: new Date(mon.deadlineAt).toISOString() });
    expect(memberBalances(w)).toEqual({ you: 0, maya: 0, diego: 0, priya: 0 });
    expect(w.entries.map((e) => e.kind)).toEqual(['stake', 'payout', 'correction']);
    expectConserved(w);
    expectIdempotent(w);
  });

  it('a rejected appeal changes nothing; the subject and the challenge opener never vote', () => {
    let w = mondayDiegoOutside();
    w = openReview(w, MON, 'diego', 'appeal', 'diego', 'I was there');
    const review = w.reviews[0]!;
    expect(castVote(w, review.id, 'diego', true)).toBe(w);
    w = castVote(w, review.id, 'you', false);
    w = castVote(w, review.id, 'priya', false);
    expect(w.reviews[0]?.status).toBe('rejected');
    expect(memberBalances(w).diego).toBe(-500);
    expect(w.entries).toHaveLength(2);
    // a challenge's opener is not a voter (RT-1)
    w = openReview(w, MON, 'you', 'challenge', 'maya', 'not there');
    const ch = w.reviews[1]!;
    expect(eligibleVoters(w, ch)).toEqual(['diego', 'priya']);
    expect(castVote(w, ch.id, 'maya', true)).toBe(w);
  });

  it('a challenge upheld makes a success a failure and moves the pledge', () => {
    let w = mondayDiegoOutside();
    w = openReview(w, MON, 'you', 'challenge', 'maya', 'You were not there');
    const ch = w.reviews[0]!;
    w = castVote(w, ch.id, 'diego', true);
    w = castVote(w, ch.id, 'priya', true);
    expect(w.reviews[0]?.status).toBe('accepted');
    expect(instanceById(w, MON).results.you?.status).toBe('failed');
    expect(memberBalances(w)).toEqual({ you: -500, maya: 500, diego: -500, priya: 500 });
    expectConserved(w);
    expectIdempotent(w);
  });

  it('reviews still open at Monday noon resolve by the votes cast: tie → turned down, none → default, result stands', () => {
    let w = mondayDiegoOutside();
    w = openReview(w, MON, 'diego', 'appeal', 'diego', 'I was there');
    const review = w.reviews[0]!;
    w = castVote(w, review.id, 'you', true);
    w = castVote(w, review.id, 'maya', false);
    w = transition(w, 'monday_noon');
    expect(w.reviews[0]?.status).toBe('rejected');
    expect(instanceById(w, MON).results.diego?.status).toBe('failed');
    expect(instanceById(w, MON).status).toBe('settled');
    expect(memberDeltaFor(w, MON, 'diego')).toBe(-500);

    let w2 = mondayDiegoOutside();
    w2 = openReview(w2, MON, 'diego', 'appeal', 'diego', 'I was there');
    w2 = transition(w2, 'monday_noon');
    expect(w2.reviews[0]?.status).toBe('defaulted');
    expect(instanceById(w2, MON).results.diego?.status).toBe('failed');
    expect(memberDeltaFor(w2, MON, 'diego')).toBe(-500);
    expect(w2.entries.some((e) => e.kind === 'correction')).toBe(false);
    expectConserved(w2);
  });

  it('a challenge upheld on a voided day revives it with carry 0 (RT-2)', () => {
    let w = createWorld();
    w = setBehaviour(w, 'maya', 'no_gps');
    w = setBehaviour(w, 'diego', 'frozen');
    w = setBehaviour(w, 'priya', 'frozen');
    w = transition(w, 'next_window');
    w = checkIn(w).world;
    w = transition(w, 'gate_closed');
    expect(instanceById(w, MON).status).toBe('voided');
    expect(canOpenReview(w, MON, 'maya', 'challenge', 'you')).toBe(true);
    w = openReview(w, MON, 'maya', 'challenge', 'you', 'She was not there');
    const ch = w.reviews[0]!;
    expect(eligibleVoters(w, ch)).toEqual(['diego', 'priya']);
    w = castVote(w, ch.id, 'diego', true);
    w = castVote(w, ch.id, 'priya', true);
    const mon = instanceById(w, MON);
    expect(mon.status).toBe('closed');
    expect(mon.carryInCents).toBe(0);
    expect(mon.results.you?.status).toBe('success');
    expect(mon.results.maya?.status).toBe('failed');
    expect(memberBalances(w)).toEqual({ you: 500, maya: -500, diego: 0, priya: 0 });
    expectConserved(w);
    expectIdempotent(w);
  });

  it('opens an automatic challenge on the third unverified day in a month', () => {
    let w = allOnTime(createWorld());
    w = setGps(w, { accuracyM: 350 });
    for (let i = 0; i < 3; i++) {
      w = transition(w, 'next_window');
      w = checkIn(w).world;
      w = transition(w, 'gate_closed');
    }
    expect(w.reviews).toHaveLength(1);
    expect(w.reviews[0]).toMatchObject({ instanceId: WED, subject: 'you', openedBy: 'you', kind: 'challenge', systemOpened: true });
    expect(eligibleVoters(w, w.reviews[0]!)).toEqual(['maya', 'diego', 'priya']);
    // a fourth unverified day opens another one; the earlier days stay as they are
    w = transition(w, 'next_window');
    w = checkIn(w).world;
    w = transition(w, 'gate_closed');
    expect(w.reviews).toHaveLength(2);
    expectConserved(w);
    expectIdempotent(w);
  });
});

describe('settlement and settle-up', () => {
  /** Mon: Diego sleeps in; Tue: Priya taps outside; Wed–Fri everyone on time; you tap every day. */
  function weekWithDebts(): World {
    let w = allOnTime(createWorld());
    w = setBehaviour(w, 'diego', 'no_show');
    w = transition(w, 'next_window');
    w = checkIn(w).world;
    w = transition(w, 'gate_closed');
    w = setBehaviour(w, 'diego', 'on_time');
    w = setBehaviour(w, 'priya', 'out_of_fence');
    w = transition(w, 'next_window');
    w = checkIn(w).world;
    w = transition(w, 'gate_closed');
    w = setBehaviour(w, 'priya', 'on_time');
    for (let i = 0; i < 3; i++) {
      w = transition(w, 'next_window');
      w = checkIn(w).world;
      w = transition(w, 'gate_closed');
    }
    return w;
  }

  it("Monday noon settles the week into the oracle's simplified obligations and marks the days settled", () => {
    let w = weekWithDebts();
    expect(memberBalances(w)).toEqual({ you: 334, maya: 334, diego: -334, priya: -334 });
    expect(transitionTarget(w, 'monday_noon')).toBe(Date.parse('2026-11-16T20:00:00Z'));
    // Monday's own window happens on the way; you show up for it
    w = transition(w, 'next_window');
    w = checkIn(w).world;
    w = transition(w, 'monday_noon');
    expect(w.settlements).toHaveLength(1);
    expect(w.settlements[0]?.weekStart).toBe('2026-11-09');
    expect(w.instances.filter((i) => i.status === 'settled').map((i) => i.id)).toEqual([MON, TUE, WED, 'inst-2026-11-12', 'inst-2026-11-13']);
    expect(instanceById(w, 'inst-2026-11-16').status).toBe('closed');
    const expected = simplifyDebts(billableBalances(w)).obligations;
    expect(expected).toEqual([
      { from: 'diego', to: 'maya', amountCents: 334 },
      { from: 'priya', to: 'you', amountCents: 334 },
    ]);
    expect(w.obligations.map((o) => ({ from: o.from, to: o.to, amountCents: o.amountCents }))).toEqual(expected);
    expect(obligationsMatchOracle(w)).toBe(true);
    expectConserved(w);
    expectIdempotent(w);
    // the second Monday has nothing new and bills the same unpaid amounts again, superseding the old rows
    const w2 = transition(w, 'monday_noon');
    expect(w2.settlements).toHaveLength(2);
    expect(w2.obligations.filter((o) => o.status === 'superseded')).toHaveLength(expected.length);
    expect(obligationsMatchOracle(w2)).toBe(true);
  });

  /** The week above, Monday's window played, settled at noon. */
  function settledWeek(): World {
    let w = transition(weekWithDebts(), 'next_window');
    w = checkIn(w).world;
    return transition(w, 'monday_noon');
  }

  it('mark paid → confirm posts the one settlement_payment entry; dispute sends it back to unpaid', () => {
    let w = settledWeek();
    const o = w.obligations.find((x) => x.to === 'you')!;
    w = markObligationPaid(w, o.id);
    expect(w.obligations.find((x) => x.id === o.id)?.status).toBe('marked_paid');
    expect(markObligationPaid(w, o.id)).toBe(w);
    w = disputeObligation(w, o.id);
    expect(w.obligations.find((x) => x.id === o.id)?.status).toBe('pending');
    w = markObligationPaid(w, o.id);
    w = confirmObligation(w, o.id);
    const after = w.obligations.find((x) => x.id === o.id)!;
    expect(after.status).toBe('confirmed');
    expect(confirmObligation(w, o.id)).toBe(w);
    const payment = w.entries.find((e) => e.kind === 'settlement_payment')!;
    expect(payment.idempotencyKey).toBe(`payment:${o.id}`);
    expect(payment.lines).toEqual(
      expect.arrayContaining([
        { account: `member:${o.from}`, amountCents: o.amountCents },
        { account: 'member:you', amountCents: -o.amountCents },
      ]),
    );
    expectConserved(w);
    // once confirmed, the billable balance no longer owes it
    const bill = billableBalances(w);
    expect(bill.you).toBe(0);
    expect(bill[o.from]).toBe(0);
    const next = transition(w, 'monday_noon');
    expect(next.obligations.filter((x) => x.settlementId === next.settlements[1]!.id && x.to === 'you' && x.from === o.from)).toHaveLength(0);
    expect(obligationsMatchOracle(next)).toBe(true);
  });

  it('a marked-paid obligation survives the next settlement as provisionally paid', () => {
    let w = settledWeek();
    const o = w.obligations.find((x) => x.to === 'you')!;
    w = markObligationPaid(w, o.id);
    const next = transition(w, 'monday_noon');
    expect(next.obligations.find((x) => x.id === o.id)?.status).toBe('marked_paid');
    const rebilled = next.obligations.filter((x) => x.settlementId === next.settlements[1]!.id && x.from === o.from && x.to === 'you');
    expect(rebilled).toHaveLength(0);
    expect(obligationsMatchOracle(next)).toBe(true);
  });
});

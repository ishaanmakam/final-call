import { checkedInIds, fmtCents, fmtCountdown, fmtTime, focusInstance, hasFreeze, memberBalances, phaseOf, yourLiveState, type Instance, type World } from '../../sim';
import { actions, useWorld } from '../store';
import { AvatarStack, Card, Icon, PButton, Pill, ProgressRing, ResultPill, type PillTone } from './primitives';

const LIVE_PILL: Record<string, { label: string; tone: PillTone } | null> = {
  waiting: null,
  checked_in: { label: 'Checked in', tone: 'success' },
  out_of_fence: { label: 'Not there yet', tone: 'unverified' },
  unjudged: { label: 'Weak GPS', tone: 'unverified' },
  queued: { label: 'Saved offline', tone: 'unverified' },
  frozen: { label: 'Frozen', tone: 'frozen' },
  refused: { label: 'Nothing sent', tone: 'pending' },
};

export function HomeScreen() {
  const w = useWorld();
  const inst = focusInstance(w);
  const balance = memberBalances(w).you;
  return (
    <div className="screen">
      <div className="nav">
        <h1>Morning crew</h1>
        <div className="nav-actions" aria-hidden="true">
          <Icon name="share" size={24} />
          <Icon name="more" size={24} />
        </div>
      </div>
      <div className="content">
        <div>
          <h2 className="section-header">Today</h2>
          {inst ? <TodayCard w={w} inst={inst} /> : <Card>No pact day today.</Card>}
        </div>
        <div>
          <h2 className="section-header">This week</h2>
          <Card className="list">
            <div className="p-row">
              <div className="main">
                <span className="t-body">Running balance</span>
                <span className="t-subheadline c-secondary">Settles Monday noon on Venmo</span>
              </div>
              <span className={`t-headline tabular ${balance > 0 ? 'pos' : balance < 0 ? 'neg' : ''}`}>{balance > 0 ? `+${fmtCents(balance)}` : fmtCents(balance)}</span>
            </div>
            <button type="button" className="p-row" style={{ background: 'none', border: 0, width: '100%', textAlign: 'left', padding: '12px 16px', cursor: 'pointer' }} onClick={() => actions.setScreen('feed')}>
              <div className="main">
                <span className="t-body">Feed</span>
                <span className="t-subheadline c-secondary">Results, appeals and challenges</span>
              </div>
              <span className="c-tertiary">
                <Icon name="chevron" />
              </span>
            </button>
          </Card>
        </div>
      </div>
    </div>
  );
}

function TodayCard({ w, inst }: { w: World; inst: Instance }) {
  const phase = phaseOf(w, inst);
  const closed = phase === 'closed';
  const inIds = checkedInIds(w, inst);
  const total = inst.roster.length;
  const live = yourLiveState(w, inst);
  const result = inst.results.you;
  const timing =
    inst.status === 'voided'
      ? "Didn't count today"
      : phase === 'before'
        ? `Opens ${fmtTime(inst.windowOpenAt, w.pact.tz)} · by ${fmtTime(inst.deadlineAt, w.pact.tz)}`
        : closed
          ? `Closed ${fmtTime(inst.deadlineAt, w.pact.tz)}`
          : `${fmtCountdown(inst.deadlineAt - w.now)} left · by ${fmtTime(inst.deadlineAt, w.pact.tz)}`;
  const tally = closed ? resultTally(inst) : `${inIds.length} of ${total} checked in`;
  const showCheckIn = !closed && phase !== 'before' && live !== 'checked_in' && live !== 'frozen';
  const pill = closed && result ? <ResultPill status={result.status} /> : LIVE_PILL[live] ? <Pill tone={LIVE_PILL[live]!.tone}>{LIVE_PILL[live]!.label}</Pill> : null;
  return (
    <Card className="today-card">
      <div className="head">
        <div className="titles">
          <span className="t-headline">{w.pact.title}</span>
          <span className={`t-subheadline c-secondary ${closed ? '' : 'tabular'}`}>{timing}</span>
        </div>
        {inst.status !== 'voided' ? (
          <ProgressRing size={52} strokeWidth={4} progress={total ? inIds.length / total : 0} color={inIds.length === total ? 'var(--success)' : 'var(--tint)'} label={`${inIds.length} of ${total} checked in`}>
            <span className="t-caption1 semibold tabular">
              {inIds.length}/{total}
            </span>
          </ProgressRing>
        ) : null}
      </div>
      <div className="who">
        <AvatarStack w={w} ids={inst.roster} highlight={inIds} />
        {pill}
      </div>
      <span className="t-subheadline c-secondary">{inst.status === 'voided' ? 'Fewer than two people were in it, so nothing counts.' : tally}</span>
      {showCheckIn ? (
        <PButton block onClick={() => actions.setScreen('checkin')}>
          Check in
        </PButton>
      ) : hasFreeze(w, inst.id, 'you') && !closed ? (
        <span className="t-footnote c-secondary">You froze today. It won't count for or against you.</span>
      ) : null}
    </Card>
  );
}

function resultTally(inst: Instance): string {
  const counts = new Map<string, number>();
  for (const id of inst.roster) {
    const s = inst.results[id]?.status ?? 'pending';
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const word: Record<string, string> = { success: 'showed up', failed: 'missed', unverified: 'unverified', frozen: 'frozen', void: "didn't count", pending: 'waiting' };
  return [...counts.entries()].map(([s, n]) => `${n} ${word[s] ?? s}`).join(' · ');
}

import {
  canOpenReview,
  eligibleVoters,
  firstName,
  fmtCents,
  fmtDateHeader,
  fmtTime,
  listNames,
  memberById,
  memberDeltaFor,
  reviewsFor,
  visibleCheckins,
  voteLabel,
  type Instance,
  type Review,
  type World,
} from '../../sim';
import { actions, useWorld } from '../store';
import { Avatar, Card, Icon, PButton, Pill, ResultPill, type PillTone } from './primitives';

const REVIEW_STATUS: Record<Review['status'], { label: string; tone: PillTone }> = {
  open: { label: 'Voting open', tone: 'tint' },
  accepted: { label: 'Upheld', tone: 'success' },
  rejected: { label: 'Turned down', tone: 'void' },
  defaulted: { label: 'No votes, default applied', tone: 'pending' },
};

export function FeedScreen() {
  const w = useWorld();
  const days = w.instances.filter((i) => i.status !== 'scheduled' && i.status !== 'open').sort((a, b) => b.deadlineAt - a.deadlineAt);
  return (
    <div className="screen">
      <div className="nav">
        <h1>Feed</h1>
      </div>
      <div className="content">
        {days.length === 0 ? (
          <Card>
            <span className="t-title3">Nothing yet</span>
            <span className="t-subheadline c-secondary">Results land here when a gate closes. Appeals, challenges and votes show up under the day they belong to.</span>
          </Card>
        ) : (
          days.map((inst) => <DayCard key={inst.id} w={w} inst={inst} />)
        )}
      </div>
    </div>
  );
}

function DayCard({ w, inst }: { w: World; inst: Instance }) {
  const reviews = reviewsFor(w, inst.id);
  return (
    <section className="feed-day" aria-label={fmtDateHeader(inst.localDate)}>
      <h2 className="section-header caps">{fmtDateHeader(inst.localDate)}</h2>
      <Card className="list">
        <div className="feed-card-head">
          <span className="t-headline">{w.pact.title}</span>
          <span className="t-subheadline c-secondary">
            {fmtTime(inst.deadlineAt, w.pact.tz)} · {fmtCents(w.pact.stakeCents)} pledge
          </span>
        </div>
        {inst.roster.map((id) => (
          <MemberRow key={id} w={w} inst={inst} id={id} />
        ))}
        {reviews.map((r) => (
          <ReviewBlock key={r.id} w={w} inst={inst} review={r} />
        ))}
        <div className="t-callout">{summaryLine(w, inst)}</div>
      </Card>
    </section>
  );
}

function MemberRow({ w, inst, id }: { w: World; inst: Instance; id: Instance['roster'][number] }) {
  const m = memberById(w, id);
  const r = inst.results[id];
  const delta = memberDeltaFor(w, inst.id, id);
  const first = visibleCheckins(w, inst.id, id).find((c) => c.verdict === 'in_fence' && c.serverReceivedAt! <= inst.deadlineAt);
  let line = 'No money moved';
  if (r?.status === 'success') {
    const at = r.firstSuccessAt ? fmtTime(Date.parse(r.firstSuccessAt), w.pact.tz) : first ? fmtTime(first.serverReceivedAt!, w.pact.tz) : null;
    line = `${at ? `Counted at ${at}` : 'Counted'} · ${delta > 0 ? `+${fmtCents(delta)} from the pool` : 'shares the pool'}`;
  } else if (r?.status === 'failed') line = `Forfeited ${fmtCents(-delta || w.pact.stakeCents)} to the pool`;
  else if (r?.status === 'unverified') line = 'No money moved · never costs you';
  const canAppeal = id === 'you' && canOpenReview(w, inst.id, 'you', 'appeal', 'you');
  const canChallenge = id !== 'you' && canOpenReview(w, inst.id, id, 'challenge', 'you');
  return (
    <div className="p-row">
      <Avatar member={m} you={id === 'you'} />
      <div className="main">
        <span className="t-body">{id === 'you' ? 'You' : m.name}</span>
        <span className="t-subheadline c-secondary">{line}</span>
      </div>
      <div className="trailing">
        {r ? <ResultPill status={r.status} /> : <Pill tone="pending">Waiting</Pill>}
        {canAppeal ? (
          <button type="button" className="p-btn tertiary small" style={{ height: 28, padding: '0 4px', fontSize: 15 }} onClick={() => actions.openReview(inst.id, 'you', 'appeal', 'you', 'I was there; GPS put me across the street.')}>
            Appeal
          </button>
        ) : null}
        {canChallenge ? (
          <button type="button" className="p-btn tertiary small" style={{ height: 28, padding: '0 4px', fontSize: 15 }} onClick={() => actions.openReview(inst.id, id, 'challenge', 'you', `${firstName(w, id)} wasn't there; I was in the building and didn't see them.`)}>
            Challenge
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ReviewBlock({ w, inst, review }: { w: World; inst: Instance; review: Review }) {
  const voters = eligibleVoters(w, review);
  const yes = Object.values(review.votes).filter((v) => v === true).length;
  const no = Object.values(review.votes).filter((v) => v === false).length;
  const youCanVote = review.status === 'open' && voters.includes('you') && review.votes.you === undefined;
  const st = REVIEW_STATUS[review.status];
  const title = review.systemOpened
    ? `${firstName(w, review.subject)}'s third unverified day this month`
    : review.kind === 'appeal'
      ? `${memberById(w, review.subject).name} appealed`
      : `${memberById(w, review.openedBy).name} challenged ${firstName(w, review.subject)}`;
  const tally = review.kind === 'appeal' ? `${yes} ${yes === 1 ? 'says' : 'say'} they showed up, ${no} ${no === 1 ? 'says' : 'say'} they didn't` : `${yes} ${yes === 1 ? 'says' : 'say'} they weren't there, ${no} ${no === 1 ? 'says' : 'say'} they were`;
  const consequence =
    review.status !== 'open'
      ? null
      : review.kind === 'appeal'
        ? 'If nobody votes by Monday noon, the miss stands and the pledge is forfeited.'
        : 'If nobody votes by Monday noon, the result stands.';
  return (
    <div className="review-block">
      <span className="icon">
        <Icon name="review" size={22} />
      </span>
      <div className="body">
        <div className="head">
          <span className="t-headline">{title}</span>
          <Pill tone={st.tone}>{st.label}</Pill>
        </div>
        <span className="quote">{review.systemOpened ? review.reason : `“${review.reason}”`}</span>
        <span className="t-subheadline c-secondary">{tally}</span>
        {youCanVote ? (
          <div className="votes">
            <PButton small onClick={() => actions.castVote(review.id, 'you', true)}>
              {cap(voteLabel(review, true))}
            </PButton>
            <PButton small variant="secondary" onClick={() => actions.castVote(review.id, 'you', false)}>
              {cap(voteLabel(review, false))}
            </PButton>
          </div>
        ) : review.votes.you !== undefined ? (
          <span className="t-footnote c-secondary">You voted: {voteLabel(review, review.votes.you)}.</span>
        ) : null}
        {consequence ? <span className="t-footnote c-secondary">{consequence}</span> : null}
      </div>
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function summaryLine(w: World, inst: Instance): string {
  if (inst.status === 'voided') return "Didn't count: fewer than two people were in it. No money moved.";
  const winners = inst.roster.filter((id) => inst.results[id]?.status === 'success');
  const losers = inst.roster.filter((id) => inst.results[id]?.status === 'failed');
  const pool = losers.length * w.pact.stakeCents + (inst.carryInCents ?? 0);
  const names = (ids: typeof winners) => listNames(ids.map((id) => (id === 'you' ? 'you' : firstName(w, id))));
  if (losers.length === 0) return `${winners.length} showed up · nobody missed. Nothing to split.`;
  if (winners.length === 0) return `Nobody showed up. ${fmtCents(pool)} carried to the next day's pool.`;
  return `${winners.length} showed up · ${names(losers)} missed. Pool ${fmtCents(pool)}${inst.carryInCents ? ` (incl. ${fmtCents(inst.carryInCents)} carried)` : ''} to ${names(winners)}.`;
}

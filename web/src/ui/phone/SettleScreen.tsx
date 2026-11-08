import { firstName, fmtCents, fmtDateShort, listNames, memberBalances, memberById, type Obligation, type World } from '../../sim';
import { actions, useWorld } from '../store';
import { Avatar, Card, Icon, PButton, Pill, type PillTone } from './primitives';

const OB_PILL: Record<Obligation['status'], { label: string; tone: PillTone }> = {
  pending: { label: 'Unpaid', tone: 'unverified' },
  marked_paid: { label: 'Marked paid', tone: 'frozen' },
  confirmed: { label: 'Confirmed', tone: 'success' },
  superseded: { label: 'Replaced', tone: 'pending' },
};

export function SettleScreen() {
  const w = useWorld();
  const last = w.settlements.at(-1) ?? null;
  const live = last ? w.obligations.filter((o) => o.settlementId === last.id) : [];
  const mine = live.filter((o) => o.from === 'you' || o.to === 'you');
  const others = live.filter((o) => o.from !== 'you' && o.to !== 'you');
  const owed = mine.filter((o) => o.to === 'you' && o.status !== 'confirmed').reduce((a, o) => a + o.amountCents, 0);
  const owe = mine.filter((o) => o.from === 'you' && o.status !== 'confirmed').reduce((a, o) => a + o.amountCents, 0);
  const net = owed - owe;
  const balances = memberBalances(w);
  return (
    <div className="screen">
      <div className="nav">
        <h1>Settle up</h1>
      </div>
      <div className="content">
        {!last ? (
          <Card>
            <span className="t-title3">Nothing to settle yet</span>
            <span className="t-subheadline c-secondary">Monday at noon the week's pool is simplified into a few Venmo payments. Until then the running balance below is what the week looks like so far.</span>
          </Card>
        ) : (
          <>
            <div className="settle-hero">
              <h2>{net > 0 ? `You're owed ${fmtCents(net)}` : net < 0 ? `You owe ${fmtCents(-net)}` : mine.length ? 'All settled' : "You're square"}</h2>
              <span className="t-subheadline c-secondary">{heroLine(w, mine)}</span>
            </div>
            {mine.length > 0 ? (
              <div>
                <h3 className="section-header">Week of {fmtDateShort(last.weekStart)}</h3>
                <Card className="list">
                  {mine.map((o) => (
                    <ObligationRow key={o.id} w={w} o={o} />
                  ))}
                </Card>
                <p className="section-footer" style={{ marginTop: 8 }}>
                  One Venmo payment per row, simplified so you pay at most a few friends. Paid counts once the other person confirms.
                </p>
              </div>
            ) : null}
            {others.length > 0 ? (
              <div>
                <h3 className="section-header">Between others</h3>
                <Card className="list">
                  {others.map((o) => (
                    <div className="p-row" key={o.id}>
                      <Avatar member={memberById(w, o.from)} />
                      <div className="main">
                        <span className="t-body">{memberById(w, o.from).name}</span>
                        <span className="t-subheadline c-secondary">Pays {memberById(w, o.to).name}</span>
                      </div>
                      <div className="trailing">
                        <span className="t-title3 tabular">{fmtCents(o.amountCents)}</span>
                        <Pill tone={OB_PILL[o.status].tone}>{OB_PILL[o.status].label}</Pill>
                      </div>
                    </div>
                  ))}
                </Card>
                <p className="section-footer" style={{ marginTop: 8 }}>
                  Shown so everyone can see the week adds up. Nothing here needs you.
                </p>
              </div>
            ) : null}
            {last.ridingInCarryCents > 0 ? (
              <p className="section-footer">{fmtCents(last.ridingInCarryCents)} is still in the carry from a day nobody showed up. It isn't owed to anyone yet.</p>
            ) : null}
          </>
        )}
        <div>
          <h3 className="section-header">Running balance</h3>
          <Card className="list">
            {w.members.map((m) => (
              <div className="p-row" key={m.id}>
                <Avatar member={m} you={m.id === 'you'} />
                <div className="main">
                  <span className="t-body">{m.id === 'you' ? 'You' : m.name}</span>
                </div>
                <span className={`t-headline tabular ${balances[m.id] > 0 ? 'pos' : balances[m.id] < 0 ? 'neg' : 'c-secondary'}`}>{balances[m.id] > 0 ? `+${fmtCents(balances[m.id])}` : fmtCents(balances[m.id])}</span>
              </div>
            ))}
          </Card>
          <p className="section-footer" style={{ marginTop: 8 }}>
            Derived from the ledger, never stored. Confirmed Venmo payments are included.
          </p>
        </div>
      </div>
    </div>
  );
}

function heroLine(w: World, mine: Obligation[]): string {
  const pay = mine.filter((o) => o.from === 'you' && o.status !== 'confirmed');
  const get = mine.filter((o) => o.to === 'you' && o.status !== 'confirmed');
  const parts: string[] = [];
  if (pay.length) parts.push(`You pay ${listNames(pay.map((o) => `${firstName(w, o.to)} ${fmtCents(o.amountCents)}`))}`);
  if (get.length) parts.push(`${listNames(get.map((o) => firstName(w, o.from)))} ${get.length === 1 ? 'pays' : 'pay'} you ${fmtCents(get.reduce((a, o) => a + o.amountCents, 0))}`);
  if (parts.length === 0) return mine.length ? 'Every payment this week is confirmed.' : 'Nothing is owed between you and anyone this week.';
  return `${parts.join('; ')}, on Venmo.`;
}

function ObligationRow({ w, o }: { w: World; o: Obligation }) {
  const payer = o.from === 'you';
  const other = memberById(w, payer ? o.to : o.from);
  const pill = OB_PILL[o.status];
  return (
    <div className="ob-row">
      <div className="top">
        <Avatar member={other} />
        <div className="main" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="t-body">{other.name}</span>
          <span className="t-subheadline c-secondary">{payer ? 'You pay' : 'Pays you'}</span>
        </div>
        <div className="trailing" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <span className="amount">{fmtCents(o.amountCents)}</span>
          <Pill tone={pill.tone}>{pill.label}</Pill>
        </div>
      </div>
      {o.status === 'confirmed' ? (
        <span className="t-footnote c-secondary">{payer ? `${firstName(w, o.to)} confirmed it landed.` : 'You confirmed it landed. The ledger has the payment.'}</span>
      ) : payer ? (
        o.status === 'pending' ? (
          <>
            <div className="actions">
              <PButton small onClick={() => actions.payOnVenmo(o.id)}>
                <Icon name="share" size={18} /> Pay on Venmo
              </PButton>
              <PButton small variant="secondary" onClick={() => actions.markPaid(o.id)}>
                Mark paid
              </PButton>
            </div>
            <span className="t-footnote c-secondary">Venmo opens with {firstName(w, o.to)}, the amount and a note prefilled. Mark it paid once you've sent it.</span>
          </>
        ) : (
          <span className="t-footnote c-secondary">You marked this paid. It counts once {firstName(w, o.to)} confirms.</span>
        )
      ) : o.status === 'marked_paid' ? (
        <>
          <div className="actions">
            <PButton small onClick={() => actions.confirm(o.id)}>
              Confirm received
            </PButton>
            <PButton small variant="tertiary" onClick={() => actions.dispute(o.id)}>
              Not received
            </PButton>
          </div>
          <span className="t-footnote c-secondary">{firstName(w, o.from)} marked this paid. Confirm when it lands.</span>
        </>
      ) : (
        <>
          <div className="actions">
            <PButton small variant="secondary" onClick={() => actions.confirm(o.id)}>
              Confirm received
            </PButton>
          </div>
          <span className="t-footnote c-secondary">{firstName(w, o.from)} hasn't marked this paid yet. If it already landed, confirm it.</span>
        </>
      )}
    </div>
  );
}

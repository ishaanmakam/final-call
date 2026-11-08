import { DateTime } from 'luxon';
import { carryBalance, conservation, firstName, fmtCents, fmtDateShort, fmtSigned, fmtTime, instanceById, memberBalances, obligationsMatchOracle, type LedgerLine, type Obligation, type World } from '../../sim';
import { actions, useStore, useWorld } from '../store';

function accountName(w: World, account: string): string {
  if (account.startsWith('member:')) return firstName(w, account.slice(7) as 'you');
  if (account.startsWith('pot:')) return `Pool ${fmtDateShort(instanceById(w, account.slice(4)).localDate).slice(0, 3)}`;
  return 'Carry';
}

const KIND_LABEL: Record<string, string> = { stake: 'forfeit', payout: 'payout', rollover: 'carry', settlement_payment: 'venmo', correction: 'correction' };

export function LedgerPanel() {
  const w = useWorld();
  const c = conservation(w);
  const balances = memberBalances(w);
  const carry = carryBalance(w);
  const entries = [...w.entries].reverse();
  return (
    <section className="panel" aria-labelledby="ledger-h">
      <h2 id="ledger-h">
        Ledger <span className="hint">append-only entries, lines sum to zero, balances derived</span>
      </h2>
      <div className="balances" aria-label="Balances">
        {w.members.map((m) => (
          <div className="cell" key={m.id}>
            <span className="t-footnote c-secondary">{m.id === 'you' ? 'You' : firstName(w, m.id)}</span>
            <span className={`v ${balances[m.id] > 0 ? 'pos' : balances[m.id] < 0 ? 'neg' : ''}`}>{fmtSigned(balances[m.id])}</span>
          </div>
        ))}
        <div className="cell">
          <span className="t-footnote c-secondary">Carry</span>
          <span className="v">{fmtCents(carry)}</span>
        </div>
      </div>
      <p className={`t-footnote ${c.ok ? 'ok' : 'bad'}`} aria-live="polite">
        {c.ok ? '✓' : '✗'} Σ members {fmtSigned(c.membersTotal)} + carry {fmtCents(c.carry)} = {fmtCents(c.membersTotal + c.carry)}
        {c.nonEmptyPots.length ? ` · pools not empty: ${c.nonEmptyPots.join(', ')}` : ' · every pool at $0.00'}
        {c.entriesBalanced ? '' : ' · an entry does not balance'}
      </p>
      {entries.length === 0 ? (
        <p className="empty">No entries yet. The first gate that closes with a miss posts one.</p>
      ) : (
        <table className="ledger">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Kind</th>
              <th scope="col">Memo and lines</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="tabular" style={{ whiteSpace: 'nowrap', color: 'var(--secondary)' }}>
                  {DateTime.fromMillis(e.createdAt, { zone: w.pact.tz }).toFormat('ccc h:mm a')}
                </td>
                <td>
                  <span className={`kind ${e.kind}`}>{KIND_LABEL[e.kind] ?? e.kind}</span>
                </td>
                <td>
                  <div>{e.memo}</div>
                  <div className="lines">
                    {e.lines.map((l: LedgerLine) => (
                      <span className="line" key={l.account}>
                        <b>{accountName(w, l.account)}</b> {fmtSigned(l.amountCents)}
                      </span>
                    ))}
                  </div>
                  <div className="t-caption1 c-tertiary" style={{ marginTop: 2 }}>
                    {e.idempotencyKey}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const OB_LABEL: Record<Obligation['status'], string> = { pending: 'Unpaid', marked_paid: 'Marked paid', confirmed: 'Confirmed', superseded: 'Replaced' };
const OB_TONE: Record<Obligation['status'], string> = { pending: 'unverified', marked_paid: 'frozen', confirmed: 'success', superseded: 'pending' };

export function SettlementPanel() {
  const w = useWorld();
  const note = useStore((s) => s.note);
  const last = w.settlements.at(-1) ?? null;
  const live = last ? w.obligations.filter((o) => o.settlementId === last.id || o.status === 'marked_paid') : [];
  const older = w.obligations.filter((o) => !live.includes(o));
  const matches = obligationsMatchOracle(w);
  return (
    <section className="panel" aria-labelledby="settle-h">
      <h2 id="settle-h">
        Weekly settle-up <span className="hint">simplifyDebts over billable balances</span>
      </h2>
      {note ? (
        <p className="t-footnote" style={{ background: 'var(--tint-soft)', color: 'var(--label)', padding: '8px 10px', borderRadius: 8 }} role="status">
          {note}{' '}
          <button type="button" className="btn tertiary xsmall" onClick={() => actions.clearNote()}>
            OK
          </button>
        </p>
      ) : null}
      {!last ? (
        <p className="empty">No settle-up yet. Monday noon simplifies the week's balances into the fewest payments.</p>
      ) : (
        <>
          <p className="t-footnote c-secondary">
            Week of {fmtDateShort(last.weekStart)} · ran {fmtDateShort(DateTime.fromMillis(last.ranAt, { zone: w.pact.tz }).toISODate()!)} {fmtTime(last.ranAt, w.pact.tz)}
            {last.ridingInCarryCents ? ` · ${fmtCents(last.ridingInCarryCents)} riding in carry` : ''} · <span className={matches ? 'ok' : 'bad'}>{matches ? '✓ equals the oracle' : '✗ differs from the oracle'}</span>
          </p>
          {live.length === 0 ? <p className="empty">Everyone was square.</p> : null}
          <div>
            {live.map((o) => (
              <div className="obligation" key={o.id}>
                <span className="who">
                  <span>
                    <b>{firstName(w, o.from)}</b> pays <b>{firstName(w, o.to)}</b>
                  </span>
                  <span className={`pill compact ${OB_TONE[o.status]}`}>{OB_LABEL[o.status]}</span>
                </span>
                <span className="amount">{fmtCents(o.amountCents)}</span>
                <div className="actions">
                  {o.status === 'pending' ? (
                    <>
                      <button type="button" className="btn xsmall" onClick={() => actions.markPaid(o.id)}>
                        {firstName(w, o.from)} marks paid
                      </button>
                      <button type="button" className="btn xsmall" onClick={() => actions.confirm(o.id)}>
                        {firstName(w, o.to)} confirms
                      </button>
                    </>
                  ) : o.status === 'marked_paid' ? (
                    <>
                      <button type="button" className="btn xsmall primary" onClick={() => actions.confirm(o.id)}>
                        {firstName(w, o.to)} confirms
                      </button>
                      <button type="button" className="btn xsmall" onClick={() => actions.dispute(o.id)}>
                        {firstName(w, o.to)} disputes
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          {older.length ? <p className="t-footnote c-secondary">{older.length} earlier obligation{older.length === 1 ? '' : 's'} replaced or confirmed.</p> : null}
        </>
      )}
    </section>
  );
}

export function EventLog() {
  const w = useWorld();
  const events = [...w.events].reverse().slice(0, 60);
  return (
    <section className="panel" aria-labelledby="log-h">
      <h2 id="log-h">
        Log <span className="hint">what the server did, newest first</span>
      </h2>
      {events.length === 0 ? (
        <p className="empty">Nothing yet.</p>
      ) : (
        <ul className="log">
          {events.map((e) => (
            <li key={e.id}>
              <time dateTime={new Date(e.at).toISOString()}>{DateTime.fromMillis(e.at, { zone: w.pact.tz }).toFormat('ccc h:mm a')}</time>
              <span>{e.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

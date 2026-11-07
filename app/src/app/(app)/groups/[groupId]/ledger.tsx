import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';
import { displayName, useLedger, type Ledger } from '@/api/queries';
import { confirmObligation, markObligationPaid } from '@/api/rpc';
import type { ObligationRow } from '@/api/types';
import { obligationLabel } from '@/components/status';
import { colors } from '@/components/theme';
import { Badge, Body, Button, Card, ErrorText, Heading, Loading, QueryState, Row, Screen } from '@/components/ui';
import { useUserId } from '@/lib/auth';
import { formatCents } from '@/lib/money';
import { openVenmoPayment } from '@/lib/openVenmo';
import { formatLocalDateShort } from '@/lib/time';
import { normalizeVenmoUsername } from '@/lib/venmo';

function ObligationCard({
  ob,
  ledger,
  userId,
  onChanged,
}: {
  ob: ObligationRow;
  ledger: Ledger;
  userId: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<'paid' | 'confirm' | 'venmo' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const iPay = ob.from_user === userId;
  const iReceive = ob.to_user === userId;
  const from = iPay ? 'You' : displayName(ledger.profiles, ob.from_user);
  const to = iReceive ? 'you' : displayName(ledger.profiles, ob.to_user);
  const payeeVenmo = normalizeVenmoUsername(ledger.profiles.get(ob.to_user)?.venmo_username);
  const status = obligationLabel[ob.status];
  const weekOf = ledger.settlement ? formatLocalDateShort(ledger.settlement.week_start) : '';

  const run = async (kind: 'paid' | 'confirm' | 'venmo', fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      if (kind !== 'venmo') onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}>
        <Body>
          {from} {iPay ? 'pay' : 'pays'} {to} {formatCents(ob.amount_cents)}
        </Body>
        <Badge label={status.label} tone={status.tone} />
      </Row>
      {iPay && ob.status === 'pending' ? (
        <>
          {payeeVenmo ? (
            <Button
              title="Pay on Venmo"
              loading={busy === 'venmo'}
              onPress={() =>
                void run('venmo', () =>
                  openVenmoPayment({
                    recipient: payeeVenmo,
                    amountCents: ob.amount_cents,
                    note: `Show Up pool, week of ${weekOf}`,
                  }),
                )
              }
            />
          ) : (
            <Body muted>{to} hasn't added a Venmo username yet. Pay them however you like, then mark it paid.</Body>
          )}
          <Button
            title="Mark paid"
            variant="secondary"
            loading={busy === 'paid'}
            onPress={() => void run('paid', () => markObligationPaid(ob.id))}
          />
        </>
      ) : null}
      {iReceive && (ob.status === 'pending' || ob.status === 'marked_paid') ? (
        <Button
          title="Confirm received"
          variant={ob.status === 'marked_paid' ? 'primary' : 'secondary'}
          loading={busy === 'confirm'}
          onPress={() => void run('confirm', () => confirmObligation(ob.id))}
        />
      ) : null}
      <ErrorText error={error} />
    </Card>
  );
}

export default function LedgerScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const userId = useUserId();
  const ledger = useLedger(groupId);
  const qc = useQueryClient();

  if (ledger.isPending) return <Loading />;
  if (ledger.isError) return <QueryState error={ledger.error} onRetry={() => void ledger.refetch()} />;
  const { balances, settlement, obligations, profiles } = ledger.data;
  const onChanged = () => void qc.invalidateQueries({ queryKey: ['group', groupId, 'ledger'] });
  const mine = obligations.filter((o) => o.from_user === userId || o.to_user === userId);
  const others = obligations.filter((o) => o.from_user !== userId && o.to_user !== userId);

  return (
    <Screen refreshing={ledger.isRefetching} onRefresh={() => void ledger.refetch()}>
      <Heading>Balances</Heading>
      <Body muted>Plus means the group owes you; minus means you owe. Money still in a pact's pool isn't owed yet.</Body>
      <Card>
        {balances.length === 0 ? <Body muted>No activity yet.</Body> : null}
        {balances.map((b) => (
          <Row key={b.user_id} style={{ justifyContent: 'space-between' }}>
            <Body>{b.user_id === userId ? 'You' : displayName(profiles, b.user_id)}</Body>
            <Text
              style={{
                fontWeight: '600',
                color: b.balance_cents > 0 ? colors.success : b.balance_cents < 0 ? colors.danger : colors.muted,
              }}
            >
              {formatCents(b.balance_cents, { signed: true })}
            </Text>
          </Row>
        ))}
      </Card>

      <Heading>{settlement ? `Settle-up, week of ${formatLocalDateShort(settlement.week_start)}` : 'Settle-up'}</Heading>
      {!settlement ? <Body muted>The first settle-up runs Monday at noon.</Body> : null}
      {settlement && obligations.length === 0 ? <Body muted>Everyone is square this week.</Body> : null}
      {mine.map((ob) => (
        <ObligationCard key={ob.id} ob={ob} ledger={ledger.data} userId={userId} onChanged={onChanged} />
      ))}
      {others.length > 0 ? <Heading>Between others</Heading> : null}
      {others.map((ob) => (
        <ObligationCard key={ob.id} ob={ob} ledger={ledger.data} userId={userId} onChanged={onChanged} />
      ))}
    </Screen>
  );
}

import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Text } from 'react-native';
import { displayName, queryKeys, useLedger, type Ledger } from '@/api/queries';
import { confirmObligation, disputeObligation, markObligationPaid } from '@/api/rpc';
import type { ObligationRow } from '@/api/types';
import { obligationLabel } from '@/components/status';
import { colors } from '@/components/theme';
import { Badge, Body, Button, Card, ErrorText, Heading, Loading, QueryState, Row, Screen } from '@/components/ui';
import { useUserId } from '@/lib/auth';
import { formatCents } from '@/lib/money';
import { groupOpenObligations, type ObligationGroup } from '@/lib/obligations';
import { openVenmoPayment } from '@/lib/openVenmo';
import { formatLocalDateShort } from '@/lib/time';
import { normalizeVenmoUsername } from '@/lib/venmo';

type Busy = 'paid' | 'confirm' | 'dispute' | 'venmo';

function ObligationCard({
  ob,
  weekStart,
  ledger,
  userId,
  onChanged,
}: {
  ob: ObligationRow;
  weekStart: string | null;
  ledger: Ledger;
  userId: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<unknown>(null);
  const iPay = ob.from_user === userId;
  const iReceive = ob.to_user === userId;
  const from = iPay ? 'You' : displayName(ledger.profiles, ob.from_user);
  const to = iReceive ? 'you' : displayName(ledger.profiles, ob.to_user);
  const payeeVenmo = normalizeVenmoUsername(ledger.profiles.get(ob.to_user)?.venmo_username);
  const status = obligationLabel[ob.status];
  const weekOf = weekStart ? formatLocalDateShort(weekStart) : '';

  const run = async (kind: Busy, fn: () => Promise<unknown>) => {
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

  const confirmDispute = () =>
    Alert.alert(
      "Didn't receive it?",
      `This moves the ${formatCents(ob.amount_cents)} from ${from} back to unpaid so they can pay again.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: "Didn't receive it",
          style: 'destructive',
          onPress: () => void run('dispute', () => disputeObligation(ob.id)),
        },
      ],
    );

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
                    note: weekOf ? `Show Up pool, week of ${weekOf}` : 'Show Up pool',
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
        <Row>
          <Button
            title="Confirm received"
            variant={ob.status === 'marked_paid' ? 'primary' : 'secondary'}
            loading={busy === 'confirm'}
            disabled={busy !== null && busy !== 'confirm'}
            onPress={() => void run('confirm', () => confirmObligation(ob.id))}
            style={{ flex: 1 }}
          />
          {ob.status === 'marked_paid' ? (
            <Button
              title="Didn't receive it"
              variant="ghost"
              loading={busy === 'dispute'}
              disabled={busy !== null && busy !== 'dispute'}
              onPress={confirmDispute}
              style={{ flex: 1 }}
            />
          ) : null}
        </Row>
      ) : null}
      <ErrorText error={error} />
    </Card>
  );
}

function WeekGroups({
  groups,
  ledger,
  userId,
  onChanged,
}: {
  groups: ObligationGroup[];
  ledger: Ledger;
  userId: string;
  onChanged: () => void;
}) {
  return (
    <>
      {groups.map((g) => (
        <Card key={g.settlementId}>
          <Body muted>{g.weekStart ? `Week of ${formatLocalDateShort(g.weekStart)}` : 'Earlier week'}</Body>
          {g.obligations.map((ob) => (
            <ObligationCard
              key={ob.id}
              ob={ob}
              weekStart={g.weekStart}
              ledger={ledger}
              userId={userId}
              onChanged={onChanged}
            />
          ))}
        </Card>
      ))}
    </>
  );
}

export default function LedgerScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const userId = useUserId();
  const ledger = useLedger(groupId);
  const qc = useQueryClient();

  if (ledger.isPending) return <Loading />;
  if (ledger.isError) return <QueryState error={ledger.error} onRetry={() => void ledger.refetch()} />;
  const { balances, latestSettlement, settlements, obligations, profiles } = ledger.data;
  const onChanged = () => void qc.invalidateQueries({ queryKey: queryKeys.ledger(groupId) });
  const { mine, others } = groupOpenObligations(obligations, settlements, userId);

  return (
    <Screen refreshing={ledger.isRefetching} onRefresh={() => void ledger.refetch()}>
      <Heading>Running balance (includes this week, not settled yet)</Heading>
      <Body muted>
        Plus means the group owes you; minus means you owe. Money still in a pact's pool isn't owed yet, and days
        since the last settle-up aren't in "To settle now" until Monday's run.
      </Body>
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

      <Heading>To settle now</Heading>
      {!latestSettlement && obligations.length === 0 ? <Body muted>The first settle-up runs Monday at noon.</Body> : null}
      {latestSettlement && mine.length === 0 ? <Body muted>Nothing for you to settle.</Body> : null}
      <WeekGroups groups={mine} ledger={ledger.data} userId={userId} onChanged={onChanged} />
      {others.length > 0 ? <Heading>Between others</Heading> : null}
      <WeekGroups groups={others} ledger={ledger.data} userId={userId} onChanged={onChanged} />
    </Screen>
  );
}

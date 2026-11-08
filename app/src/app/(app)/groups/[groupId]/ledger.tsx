import { useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Alert, Platform, StyleSheet, View } from 'react-native';
import { displayName, queryKeys, useLedger, type Ledger } from '@/api/queries';
import { confirmObligation, disputeObligation, markObligationPaid } from '@/api/rpc';
import type { ObligationRow } from '@/api/types';
import { Avatar, Button, EmptyState, Icon, ListRow, Pill, Screen, Skeleton, SkeletonCard, Text, useToast } from '@/components';
import {
  obligationPill,
  settleHeadline,
  settleSubline,
  settleSummary,
  sideOf,
  signedBalance,
  splitWeeks,
} from '@/features/settle/summary';
import { useUserId } from '@/lib/auth';
import { classifyRpcError, userMessage } from '@/lib/errors';
import { formatCents } from '@/lib/money';
import { groupOpenObligations, type ObligationGroup } from '@/lib/obligations';
import { openVenmoPayment } from '@/lib/openVenmo';
import { formatLocalDateShort } from '@/lib/time';
import { normalizeVenmoUsername } from '@/lib/venmo';
import { haptic, radius, space, useTheme } from '@/theme';

const THIS_WEEK_FOOTER =
  "One Venmo payment per row, simplified so you pay at most a few friends. Paid counts once the other person confirms.";
const EARLIER_FOOTER = "Unpaid amounts roll into the next settle-up as one total per friend; the old row shows as Replaced.";
const BALANCE_FOOTER =
  "If settle-up ran right now, including this week. Plus means the group owes you. Corrections after a review land in the next settle-up; nothing already paid changes.";

type Busy = 'paid' | 'confirm' | 'dispute' | 'venmo';

/** Inset-grouped block with the iOS header / footer chrome; rows draw their own separators. */
function Section({ header, footer, children }: { header?: string; footer?: string; children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={styles.section}>
      {header ? (
        <Text variant="footnote" color="secondary" style={styles.sectionHeader} accessibilityRole="header">
          {header}
        </Text>
      ) : null}
      <View style={[styles.block, { backgroundColor: colors.surface, borderColor: colors.separator }]}>{children}</View>
      {footer ? (
        <Text variant="footnote" color="secondary" style={styles.sectionFooter}>
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

function Divider() {
  const { colors } = useTheme();
  return <View style={[styles.divider, { backgroundColor: colors.separator }]} />;
}

// ---------- one obligation ----------

function Obligation({
  ob,
  weekStart,
  showWeek,
  ledger,
  userId,
  onChanged,
}: {
  ob: ObligationRow;
  weekStart: string | null;
  showWeek: boolean;
  ledger: Ledger;
  userId: string;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<Busy | null>(null);
  const [venmoOpened, setVenmoOpened] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const side = sideOf(ob, userId);
  const otherId = side === 'pay' ? ob.to_user : ob.from_user;
  const fullName = displayName(ledger.profiles, otherId);
  /** sentences use the first name; the row title keeps the full one */
  const other = fullName.split(' ')[0] ?? fullName;
  const payeeVenmo = normalizeVenmoUsername(ledger.profiles.get(ob.to_user)?.venmo_username);
  const pill = obligationPill(ob.status, side);
  const weekOf = weekStart ? formatLocalDateShort(weekStart) : null;
  const week = showWeek && weekOf ? ` · week of ${weekOf}` : '';
  const amount = formatCents(ob.amount_cents);
  const subtitle = side === 'pay' ? `You pay${week}` : side === 'receive' ? `Pays you${week}` : `Pays ${displayName(ledger.profiles, ob.to_user)}${week}`;

  const run = async (kind: Busy, fn: () => Promise<unknown>) => {
    if (busy) return;
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

  const payOnVenmo = () =>
    run('venmo', async () => {
      await openVenmoPayment({
        recipient: payeeVenmo!,
        amountCents: ob.amount_cents,
        note: weekOf ? `Final Call pool, week of ${weekOf}` : 'Final Call pool',
      });
      setVenmoOpened(true);
    });

  const markPaid = () => {
    const go = () =>
      void run('paid', async () => {
        await markObligationPaid(ob.id);
        toast.show({ message: `Marked paid. ${other} confirms when it lands.`, icon: 'checkmark', tone: 'frozen' });
      });
    if (Platform.OS === 'web') {
      go();
      return;
    }
    Alert.alert(`Mark ${amount} to ${other} as paid?`, `${other} will be asked to confirm it landed. Until then it shows as marked paid.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Mark paid', onPress: go },
    ]);
  };

  const confirmReceived = () =>
    void run('confirm', async () => {
      await confirmObligation(ob.id);
      toast.show({ message: `Confirmed ${amount} from ${other}.`, icon: 'checkmark', tone: 'success' });
    });

  const notReceived = () => {
    const go = () => {
      haptic('commit');
      void run('dispute', () => disputeObligation(ob.id));
    };
    if (Platform.OS === 'web') {
      go();
      return;
    }
    Alert.alert(`Didn't receive ${amount} from ${other}?`, `This sends it back to unpaid so ${other} can pay again. Nothing is deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Not received', style: 'destructive', onPress: go },
    ]);
  };

  let actions: ReactNode = null;
  if (side === 'pay' && ob.status === 'pending') {
    actions = payeeVenmo ? (
      <>
        <View style={styles.buttons}>
          <Button
            title={`Pay ${amount} on Venmo`}
            size="small"
            variant={venmoOpened ? 'secondary' : 'primary'}
            leading={<Icon name="arrow.up.right" size={16} color={venmoOpened ? 'label' : 'onTint'} />}
            loading={busy === 'venmo'}
            disabled={busy !== null && busy !== 'venmo'}
            onPress={() => void payOnVenmo()}
            accessibilityHint={`Opens Venmo with ${amount} and a note filled in for ${other}`}
            style={styles.flex}
          />
        </View>
        <View style={styles.buttons}>
          <Button
            title="I paid"
            size="small"
            variant={venmoOpened ? 'primary' : 'secondary'}
            loading={busy === 'paid'}
            disabled={busy !== null && busy !== 'paid'}
            onPress={markPaid}
            accessibilityHint={`Marks ${amount} to ${other} as paid, for ${other} to confirm`}
            style={styles.flex}
          />
        </View>
        <Text variant="footnote" color="secondary">
          {venmoOpened ? `Back from Venmo? Mark it paid so ${other} can confirm.` : `Opens Venmo with the amount and note filled in. Then mark it paid here.`}
        </Text>
      </>
    ) : (
      <>
        <Text variant="footnote" color="secondary">
          {other} hasn't added a Venmo username. Pay however you both like, then mark it paid.
        </Text>
        <View style={styles.buttons}>
          <Button
            title="I paid"
            size="small"
            variant="secondary"
            loading={busy === 'paid'}
            disabled={busy !== null && busy !== 'paid'}
            onPress={markPaid}
            accessibilityHint={`Marks ${amount} to ${other} as paid, for ${other} to confirm`}
            style={styles.flex}
          />
        </View>
      </>
    );
  } else if (side === 'pay' && ob.status === 'marked_paid') {
    actions = (
      <Text variant="footnote" color="secondary">
        Waiting for {other} to confirm it landed.
      </Text>
    );
  } else if (side === 'receive' && ob.status === 'pending') {
    actions = (
      <>
        <View style={styles.buttons}>
          <Button
            title="Confirm received"
            size="small"
            variant="secondary"
            loading={busy === 'confirm'}
            disabled={busy !== null && busy !== 'confirm'}
            onPress={confirmReceived}
            accessibilityHint={`Records that ${other} paid you ${amount}`}
            style={styles.flex}
          />
        </View>
        <Text variant="footnote" color="secondary">
          {other} hasn't marked this paid yet. If it already landed, confirm it.
        </Text>
      </>
    );
  } else if (side === 'receive' && ob.status === 'marked_paid') {
    actions = (
      <>
        <View style={styles.buttons}>
          <Button
            title="Confirm received"
            size="small"
            loading={busy === 'confirm'}
            disabled={busy !== null && busy !== 'confirm'}
            onPress={confirmReceived}
            accessibilityHint={`Records that ${other} paid you ${amount}`}
            style={styles.flex}
          />
          <Button
            title="Not received"
            size="small"
            variant="tertiary"
            loading={busy === 'dispute'}
            disabled={busy !== null && busy !== 'dispute'}
            onPress={notReceived}
            accessibilityHint={`Sends ${amount} back to unpaid so ${other} can pay again`}
            style={styles.flex}
          />
        </View>
        <Text variant="footnote" color="secondary">
          {other} marked this paid. Confirm when it lands.
        </Text>
      </>
    );
  }

  return (
    <View style={styles.obligation} accessible={false}>
      <View style={styles.obRow}>
        <Avatar person={{ id: otherId, name: fullName }} size={32} />
        <View style={styles.obText}>
          <Text variant="body" numberOfLines={1}>
            {fullName}
          </Text>
          <Text variant="subheadline" color="secondary" numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <View style={styles.obTrailing}>
          <Text variant="body" emphasis tabular>
            {amount}
          </Text>
          <Pill label={pill.label} tone={pill.tone} size="compact" />
        </View>
      </View>
      {actions ? <View style={styles.actions}>{actions}</View> : null}
      {error ? (
        <Text variant="footnote" color="forfeit" accessibilityRole="alert">
          {userMessage(error)}
        </Text>
      ) : null}
    </View>
  );
}

function ObligationRows({
  groups,
  showWeek = false,
  ledger,
  userId,
  onChanged,
}: {
  groups: ObligationGroup[];
  /** name the week on each row when the block spans several weeks */
  showWeek?: boolean;
  ledger: Ledger;
  userId: string;
  onChanged: () => void;
}) {
  const flat = groups.flatMap((g) => g.obligations.map((ob) => ({ ob, weekStart: g.weekStart })));
  return (
    <>
      {flat.map(({ ob, weekStart }, i) => (
        <View key={ob.id}>
          {i > 0 ? <Divider /> : null}
          <Obligation ob={ob} weekStart={weekStart} showWeek={showWeek} ledger={ledger} userId={userId} onChanged={onChanged} />
        </View>
      ))}
    </>
  );
}

// ---------- screen ----------

function SettleSkeleton() {
  return (
    <View style={styles.skeleton} accessibilityLabel="Loading settle-up" accessibilityState={{ busy: true }}>
      <Skeleton width="55%" height={24} />
      <Skeleton width="85%" height={12} />
      <View style={styles.skeletonGap} />
      <SkeletonCard lines={3} />
      <SkeletonCard lines={4} />
    </View>
  );
}

export default function LedgerScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const userId = useUserId();
  const ledger = useLedger(groupId);
  const qc = useQueryClient();
  const [earlierOpen, setEarlierOpen] = useState(false);
  const onChanged = () => void qc.invalidateQueries({ queryKey: queryKeys.ledger(groupId) });

  if (ledger.isPending) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Settle up' }} />
        <SettleSkeleton />
      </Screen>
    );
  }
  if (ledger.isError) {
    const offline = classifyRpcError(ledger.error) === 'network';
    return (
      <Screen scroll={false}>
        <Stack.Screen options={{ title: 'Settle up' }} />
        <EmptyState
          layout="screen"
          icon={offline ? 'wifi.slash' : 'exclamationmark.triangle'}
          title={offline ? "You're offline" : "Couldn't load settle-up"}
          body={offline ? 'Nothing here changes until you reconnect; payments you make on Venmo are still yours to mark paid afterwards.' : userMessage(ledger.error)}
          action={{ label: 'Try again', onPress: () => void ledger.refetch(), variant: 'secondary' }}
        />
      </Screen>
    );
  }

  const { balances, latestSettlement, settlements, obligations, profiles } = ledger.data;
  const { mine, others } = groupOpenObligations(obligations, settlements, userId);
  const { thisWeek, earlier } = splitWeeks(mine, latestSettlement?.id ?? null);
  const summary = settleSummary(obligations, userId);
  const earlierCount = earlier.reduce((n, g) => n + g.obligations.length, 0);
  const nothingYet = !latestSettlement && obligations.length === 0 && balances.length === 0;

  if (nothingYet) {
    return (
      <Screen scroll={false}>
        <Stack.Screen options={{ title: 'Settle up' }} />
        <EmptyState
          layout="screen"
          icon="clock"
          title="Nothing to settle"
          body="Settle-up runs Monday at noon, group time. Until then this week's results show only in the running balance, and nobody owes anyone yet."
        />
      </Screen>
    );
  }

  return (
    <Screen refreshing={ledger.isRefetching} onRefresh={() => void ledger.refetch()}>
      <Stack.Screen options={{ title: 'Settle up' }} />
      <View style={styles.headline} accessible accessibilityRole="header">
        <Text variant="title2" tabular>
          {settleHeadline(summary)}
        </Text>
        <Text variant="footnote" color="secondary">
          {settleSubline(summary, (id) => (id === userId ? 'you' : displayName(profiles, id).split(' ')[0] ?? 'Someone'), latestSettlement !== null)}
        </Text>
      </View>

      {thisWeek ? (
        <Section header={thisWeek.weekStart ? `Week of ${formatLocalDateShort(thisWeek.weekStart)}` : 'This week'} footer={THIS_WEEK_FOOTER}>
          <ObligationRows groups={[thisWeek]} ledger={ledger.data} userId={userId} onChanged={onChanged} />
        </Section>
      ) : latestSettlement ? (
        <Section header={`Week of ${formatLocalDateShort(latestSettlement.week_start)}`} footer={THIS_WEEK_FOOTER}>
          <View style={styles.quiet}>
            <Text variant="subheadline" color="secondary">
              Nothing for you to pay or receive this week.
            </Text>
          </View>
        </Section>
      ) : null}

      {earlier.length > 0 ? (
        <Section footer={earlierOpen ? EARLIER_FOOTER : undefined}>
          <ListRow
            title="Earlier weeks"
            subtitle={`${earlierCount} still open`}
            position={earlierOpen ? 'middle' : 'only'}
            trailing={<Icon name={earlierOpen ? 'chevron.down' : 'chevron.right'} size={16} color="tertiary" />}
            onPress={() => setEarlierOpen((v) => !v)}
            accessibilityLabel={`Earlier weeks, ${earlierCount} still open`}
            accessibilityHint={earlierOpen ? 'Collapses the list' : 'Shows them'}
          />
          {earlierOpen ? <ObligationRows groups={earlier} showWeek ledger={ledger.data} userId={userId} onChanged={onChanged} /> : null}
        </Section>
      ) : null}

      {others.length > 0 ? (
        <Section header="Between others" footer="Shown so everyone can see the week adds up. Nothing here needs you.">
          <ObligationRows groups={others} showWeek={others.length > 1} ledger={ledger.data} userId={userId} onChanged={onChanged} />
        </Section>
      ) : null}

      <Section header="Running balance" footer={BALANCE_FOOTER}>
        {balances.length === 0 ? (
          <View style={styles.quiet}>
            <Text variant="subheadline" color="secondary">
              No results yet. The first deadline starts it.
            </Text>
          </View>
        ) : null}
        {balances.map((b, i) => {
          const name = b.user_id === userId ? 'You' : displayName(profiles, b.user_id);
          return (
            <View key={b.user_id}>
              {i > 0 ? <Divider /> : null}
              <View style={styles.balanceRow} accessible accessibilityLabel={`${name}, ${signedBalance(b.balance_cents)}`}>
                <Avatar person={{ id: b.user_id, name: displayName(profiles, b.user_id) }} size={28} highlighted={b.user_id === userId} />
                <Text variant="body" style={styles.flex} numberOfLines={1}>
                  {name}
                </Text>
                <Text variant="body" emphasis tabular>
                  {signedBalance(b.balance_cents)}
                </Text>
              </View>
            </View>
          );
        })}
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headline: { gap: space.xs, paddingHorizontal: space.xs, paddingBottom: space.xs },
  section: { gap: space.xs },
  sectionHeader: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xs },
  sectionFooter: { paddingHorizontal: space.lg, paddingTop: space.xs },
  block: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: space.lg },
  obligation: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md },
  obRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  obText: { flex: 1, gap: 1 },
  obTrailing: { alignItems: 'flex-end', gap: space.xs },
  actions: { gap: space.sm },
  buttons: { flexDirection: 'row', gap: space.sm },
  quiet: { paddingHorizontal: space.lg, paddingVertical: space.md },
  balanceRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, minHeight: 44, paddingVertical: space.sm },
  skeleton: { gap: space.md, paddingTop: space.xs },
  skeletonGap: { height: space.sm },
});

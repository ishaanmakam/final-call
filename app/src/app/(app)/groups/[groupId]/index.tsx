import { useQueryClient } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Alert, Pressable, Share } from 'react-native';
import { displayName, useGroupHome, type TodayItem } from '@/api/queries';
import { leaveGroup } from '@/api/rpc';
import { dayStateLabel } from '@/components/status';
import { Badge, Body, Button, Card, Heading, Loading, QueryState, Row, Screen } from '@/components/ui';
import { useUserId } from '@/lib/auth';
import { inviteLink } from '@/lib/links';
import { formatCents } from '@/lib/money';
import { describeDays, displayTimeOfDay, formatCountdown, formatTimeInZone, msUntil, windowState } from '@/lib/time';
import { useNow } from '@/lib/useNow';
import type { ProfileRow } from '@/api/types';

function TodayCard({
  item,
  userId,
  profiles,
  now,
}: {
  item: TodayItem;
  userId: string;
  profiles: Map<string, ProfileRow>;
  now: number;
}) {
  const { instance, pact, summary } = item;
  const state = windowState(now, instance.window_open_at, instance.deadline_at);
  const isClosed = ['closed', 'settled', 'voided'].includes(instance.status) || state === 'closed';
  const amIn = item.participantIds.includes(userId);
  const timing =
    state === 'before'
      ? `Opens ${formatTimeInZone(instance.window_open_at, pact.tz)}`
      : state === 'open'
        ? `${formatCountdown(msUntil(instance.deadline_at, now))} left · deadline ${formatTimeInZone(instance.deadline_at, pact.tz)}`
        : `Closed at ${formatTimeInZone(instance.deadline_at, pact.tz)}`;

  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}>
        <Heading>{pact.title}</Heading>
        {instance.status === 'voided' ? <Badge label="Void" tone="neutral" /> : null}
      </Row>
      <Body muted>{timing}</Body>
      <Body>{summary.label}</Body>
      <Row>
        {item.participantIds.map((uid) => {
          const s = dayStateLabel[summary.byUser[uid] ?? 'waiting'];
          return <Badge key={uid} label={`${uid === userId ? 'You' : displayName(profiles, uid)}: ${s.label}`} tone={s.tone} />;
        })}
      </Row>
      {amIn && !isClosed ? (
        <Button
          title={state === 'open' ? 'Check in' : 'Open check-in'}
          variant={state === 'open' ? 'primary' : 'secondary'}
          onPress={() => router.push(`/checkin/${instance.id}`)}
        />
      ) : null}
    </Card>
  );
}

export default function GroupHome() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const userId = useUserId();
  const home = useGroupHome(groupId, userId);
  const now = useNow(1000);
  const qc = useQueryClient();

  if (home.isPending) return <Loading />;
  if (home.isError) return <QueryState error={home.error} onRetry={() => void home.refetch()} />;
  const { group, members, profiles, pacts, today, unjoinedPactIds } = home.data;

  const share = () =>
    void Share.share({
      message: `Join "${group.name}" on Show Up: ${inviteLink(group.invite_code)}\nOr enter code ${group.invite_code} in the app.`,
    });

  const confirmLeave = () =>
    Alert.alert('Leave group?', 'You will stop taking part in its pacts. Open balances still need to be settled.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () =>
          void leaveGroup(groupId)
            .then(() => qc.invalidateQueries({ queryKey: ['groups'] }))
            .then(() => router.replace('/groups'))
            .catch((e: unknown) => Alert.alert('Could not leave', e instanceof Error ? e.message : String(e))),
      },
    ]);

  return (
    <Screen refreshing={home.isRefetching} onRefresh={() => void home.refetch()}>
      <Stack.Screen options={{ title: group.name }} />
      <Row>
        <Button title="Feed" variant="secondary" onPress={() => router.push(`/groups/${groupId}/feed`)} style={{ flex: 1 }} />
        <Button title="Ledger" variant="secondary" onPress={() => router.push(`/groups/${groupId}/ledger`)} style={{ flex: 1 }} />
        <Button title="Invite" variant="secondary" onPress={share} style={{ flex: 1 }} />
      </Row>

      <Heading>Today</Heading>
      {today.length === 0 ? <Body muted>Nothing scheduled today.</Body> : null}
      {today.map((item) => (
        <TodayCard key={item.instance.id} item={item} userId={userId} profiles={profiles} now={now} />
      ))}

      <Heading>Pacts</Heading>
      {pacts.length === 0 ? <Body muted>No pacts yet. Create one to get going.</Body> : null}
      {pacts.map((pact) => (
        <Pressable key={pact.id} accessibilityRole="button" onPress={() => router.push(`/pacts/${pact.id}`)}>
          <Card>
            <Row style={{ justifyContent: 'space-between' }}>
              <Heading>{pact.title}</Heading>
              {pact.paused ? <Badge label="Paused" tone="neutral" /> : null}
              {unjoinedPactIds.has(pact.id) ? <Badge label="Set your place to join" tone="warn" /> : null}
            </Row>
            <Body muted>
              {describeDays(pact.days_of_week)} · by {displayTimeOfDay(pact.deadline_local)} · pledge{' '}
              {formatCents(pact.stake_cents)}
            </Body>
          </Card>
        </Pressable>
      ))}
      <Button title="New pact" onPress={() => router.push(`/groups/${groupId}/new-pact`)} />

      <Heading>Members ({members.length}/8)</Heading>
      <Body>{members.map((m) => (m.user_id === userId ? 'You' : displayName(profiles, m.user_id))).join(', ')}</Body>
      <Body muted>Invite code: {group.invite_code}</Body>
      <Button title="Leave group" variant="ghost" onPress={confirmLeave} />
    </Screen>
  );
}

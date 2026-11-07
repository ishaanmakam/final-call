import { useQueryClient } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Switch } from 'react-native';
import { displayName, usePactDetail } from '@/api/queries';
import { declareFreeze, setPactPaused } from '@/api/rpc';
import type { PactInstanceRow } from '@/api/types';
import { Badge, Body, Button, Card, ErrorText, Heading, Loading, QueryState, Row, Screen } from '@/components/ui';
import { useUserId } from '@/lib/auth';
import { formatCents } from '@/lib/money';
import { describeDays, displayTimeOfDay, formatDateInZone, formatTimeInZone, windowState } from '@/lib/time';
import { useNow } from '@/lib/useNow';

export default function PactDetail() {
  const { pactId } = useLocalSearchParams<{ pactId: string }>();
  const userId = useUserId();
  const detail = usePactDetail(pactId, userId);
  const qc = useQueryClient();
  const now = useNow(30_000);
  const [error, setError] = useState<unknown>(null);
  const [pausing, setPausing] = useState(false);

  if (detail.isPending) return <Loading />;
  if (detail.isError) return <QueryState error={detail.error} onRetry={() => void detail.refetch()} />;
  const { pact, participants, profiles, upcoming, myFreezes } = detail.data;
  const amIn = participants.some((p) => p.user_id === userId);
  const frozenIds = new Set(myFreezes.map((f) => f.instance_id));

  const togglePause = async (paused: boolean) => {
    setPausing(true);
    setError(null);
    try {
      await setPactPaused(pactId, paused);
      await qc.invalidateQueries({ queryKey: ['pact', pactId] });
      await qc.invalidateQueries({ queryKey: ['group', pact.group_id] });
    } catch (e) {
      setError(e);
    } finally {
      setPausing(false);
    }
  };

  const freeze = (inst: PactInstanceRow) =>
    Alert.alert(
      'Freeze this day?',
      `${formatDateInZone(inst.deadline_at, pact.tz)} won't count for or against you. One freeze per week per pact.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Freeze',
          onPress: () =>
            void declareFreeze(inst.id)
              .then(() => qc.invalidateQueries({ queryKey: ['pact', pactId] }))
              .catch((e: unknown) => setError(e)),
        },
      ],
    );

  return (
    <Screen refreshing={detail.isRefetching} onRefresh={() => void detail.refetch()}>
      <Stack.Screen options={{ title: pact.title }} />
      <Card>
        <Heading>{pact.title}</Heading>
        <Body>
          {describeDays(pact.days_of_week)}, window {displayTimeOfDay(pact.window_open_local)} to{' '}
          {displayTimeOfDay(pact.deadline_local)}
        </Body>
        <Body muted>Time zone {pact.tz}</Body>
        <Body>Pledge {formatCents(pact.stake_cents)} per day</Body>
        <Row style={{ justifyContent: 'space-between' }}>
          <Body>Paused</Body>
          <Switch
            value={pact.paused}
            disabled={pausing}
            onValueChange={(v) => void togglePause(v)}
            accessibilityLabel="Pause this pact"
          />
        </Row>
        {pact.paused ? <Body muted>Paused pacts skip their days until resumed.</Body> : null}
      </Card>

      <Heading>Who's in</Heading>
      {participants.length === 0 ? <Body muted>Nobody has set a place yet.</Body> : null}
      {participants.map((p) => (
        <Card key={p.user_id}>
          <Body>{p.user_id === userId ? 'You' : displayName(profiles, p.user_id)}</Body>
          <Body muted>
            {p.place_label} · {p.place_radius_m} m radius
          </Body>
        </Card>
      ))}
      <Button
        title={amIn ? 'Change my place' : 'Set my place and join'}
        variant={amIn ? 'secondary' : 'primary'}
        onPress={() => router.push(`/pacts/${pactId}/place`)}
      />

      <Heading>Upcoming</Heading>
      {upcoming.length === 0 ? <Body muted>Days appear here up to a week ahead.</Body> : null}
      {upcoming.map((inst) => {
        const state = windowState(now, inst.window_open_at, inst.deadline_at);
        const frozen = frozenIds.has(inst.id);
        return (
          <Card key={inst.id}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Body>
                {formatDateInZone(inst.deadline_at, pact.tz)} · by {formatTimeInZone(inst.deadline_at, pact.tz)}
              </Body>
              {frozen ? <Badge label="Frozen" tone="neutral" /> : null}
              {inst.status === 'voided' ? <Badge label="Void" tone="neutral" /> : null}
            </Row>
            {amIn && state === 'open' && !frozen ? (
              <Button title="Check in" onPress={() => router.push(`/checkin/${inst.id}`)} />
            ) : null}
            {amIn && state === 'before' && !frozen && inst.status === 'scheduled' ? (
              <Button title="Freeze this day" variant="ghost" onPress={() => freeze(inst)} />
            ) : null}
          </Card>
        );
      })}
      <ErrorText error={error} />
    </Screen>
  );
}

import { useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useInstanceDetail } from '@/api/queries';
import { RpcError, checkIn, declareFreeze } from '@/api/rpc';
import type { CheckinRow } from '@/api/types';
import { resultLabel } from '@/components/status';
import { colors, space } from '@/components/theme';
import { Badge, Body, Button, Card, ErrorText, Heading, Loading, QueryState, Screen } from '@/components/ui';
import { useUserId } from '@/lib/auth';
import type { CheckinAttempt } from '@/lib/checkinQueue';
import { enqueueCheckin, kickQueue } from '@/lib/checkinQueueRuntime';
import { attemptFromFix, attemptWithoutFix, ensureForegroundPermission, takeHighAccuracyFix } from '@/lib/location';
import { deviceTimeZone, formatCountdown, formatDateInZone, formatTimeInZone, msUntil, windowState } from '@/lib/time';
import { useNow } from '@/lib/useNow';

type Phase =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'sending' }
  | { kind: 'verdict'; row: CheckinRow }
  | { kind: 'queued' }
  | { kind: 'nofix'; capturedAt: number; reason: string }
  | { kind: 'permission'; blocked: boolean }
  | { kind: 'error'; error: unknown };

function verdictMessage(row: CheckinRow, radiusM: number | undefined): { title: string; body: string; good: boolean } {
  const acc = row.accuracy_m !== null ? `±${Math.round(row.accuracy_m)} m` : 'unknown accuracy';
  switch (row.verdict) {
    case 'in_fence':
      return { title: "You're in", body: 'Check-in counted. Nice.', good: true };
    case 'out_of_fence':
      return {
        title: 'Not at your place yet',
        body: `About ${Math.round(row.distance_m ?? 0)} m from the center${radiusM ? ` (circle is ${radiusM} m)` : ''}, GPS ${acc}. Get closer and tap again.`,
        good: false,
      };
    case 'unjudgeable':
      return {
        title: 'GPS too weak to judge',
        body: `Accuracy was ${acc}. Try again near a window. If nothing better lands, the day counts as unverified, not missed.`,
        good: false,
      };
    case 'rejected_simulated':
      return { title: 'Location rejected', body: 'That location looked simulated, so it was not counted.', good: false };
  }
}

export default function CheckInScreen() {
  const { instanceId } = useLocalSearchParams<{ instanceId: string }>();
  const userId = useUserId();
  const detail = useInstanceDetail(instanceId, userId);
  const now = useNow(1000);
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  if (detail.isPending) return <Loading />;
  if (detail.isError) return <QueryState error={detail.error} onRetry={() => void detail.refetch()} />;
  const { instance, pact, myPlace, myCheckins, myResult, myFreeze } = detail.data;

  const state = windowState(now, instance.window_open_at, instance.deadline_at);
  const finished = ['closed', 'settled', 'voided'].includes(instance.status);
  const busy = phase.kind === 'locating' || phase.kind === 'sending';
  const canCheckIn = state === 'open' && !finished && !!myPlace && !myFreeze && !busy;
  const alreadyIn = myCheckins.some(
    (c) => c.verdict === 'in_fence' && Date.parse(c.server_received_at) <= Date.parse(instance.deadline_at),
  );
  const showZone = pact.tz !== deviceTimeZone();
  const deadlineText = `${formatTimeInZone(instance.deadline_at, pact.tz)}${showZone ? ` (${pact.tz})` : ''}`;

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['instance', instanceId] }),
      qc.invalidateQueries({ queryKey: ['group', pact.group_id] }),
    ]);

  const submit = async (attempt: CheckinAttempt) => {
    setPhase({ kind: 'sending' });
    try {
      const row = await checkIn(attempt);
      setPhase({ kind: 'verdict', row });
      kickQueue(); // network is clearly up: flush anything older
      await refresh();
    } catch (e) {
      if (e instanceof RpcError && e.kind !== 'rejected') {
        await enqueueCheckin(attempt);
        setPhase({ kind: 'queued' });
      } else {
        setPhase({ kind: 'error', error: e });
      }
    }
  };

  const onCheckIn = async () => {
    const permission = await ensureForegroundPermission();
    if (permission !== 'granted') {
      setPhase({ kind: 'permission', blocked: permission === 'blocked' });
      return;
    }
    setPhase({ kind: 'locating' });
    const tappedAt = Date.now();
    try {
      const fix = await takeHighAccuracyFix();
      await submit(attemptFromFix(instanceId, fix));
    } catch (e) {
      setPhase({ kind: 'nofix', capturedAt: tappedAt, reason: e instanceof Error ? e.message : String(e) });
    }
  };

  const onFreeze = () =>
    Alert.alert('Freeze today?', "Today won't count for or against you. One freeze per week per pact.", [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Freeze',
        onPress: () =>
          void declareFreeze(instanceId)
            .then(refresh)
            .catch((e: unknown) => setPhase({ kind: 'error', error: e })),
      },
    ]);

  let timing: string;
  if (finished || state === 'closed') timing = `Closed. Deadline was ${deadlineText}.`;
  else if (state === 'before')
    timing = `Window opens in ${formatCountdown(msUntil(instance.window_open_at, now))} at ${formatTimeInZone(instance.window_open_at, pact.tz)}`;
  else timing = `${formatCountdown(msUntil(instance.deadline_at, now))} until ${deadlineText}`;

  const buttonLabel =
    phase.kind === 'locating' ? 'Getting GPS…' : phase.kind === 'sending' ? 'Sending…' : alreadyIn ? 'Checked in' : 'Check In';

  return (
    <Screen refreshing={detail.isRefetching} onRefresh={() => void detail.refetch()}>
      <Stack.Screen options={{ title: pact.title }} />
      <Body muted>{formatDateInZone(instance.deadline_at, pact.tz)}</Body>
      <Text style={styles.countdown} accessibilityLiveRegion="polite">
        {timing}
      </Text>

      <View style={styles.center}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Check in"
          accessibilityHint="Reads your location once and sends it"
          accessibilityState={{ disabled: !canCheckIn, busy }}
          disabled={!canCheckIn}
          onPress={() => void onCheckIn()}
          style={({ pressed }) => [
            styles.big,
            alreadyIn && styles.bigDone,
            !canCheckIn && !alreadyIn && styles.bigDisabled,
            pressed && styles.bigPressed,
          ]}
        >
          <Text style={styles.bigText}>{buttonLabel}</Text>
        </Pressable>
      </View>

      {!myPlace ? <Body muted>You haven't joined this pact, so there's nothing to check in to.</Body> : null}
      {myFreeze ? <Body muted>You froze this day.</Body> : null}
      {myPlace && state === 'open' && !finished ? (
        <Body muted>
          Target: {myPlace.place_label} ({myPlace.place_radius_m} m). Your location is read once, right now, and
          nowhere else.
        </Body>
      ) : null}

      {phase.kind === 'verdict'
        ? (() => {
            const v = verdictMessage(phase.row, myPlace?.place_radius_m);
            return (
              <Card style={{ borderColor: v.good ? colors.success : colors.warn }}>
                <Heading>{v.title}</Heading>
                <Body>{v.body}</Body>
              </Card>
            );
          })()
        : null}
      {phase.kind === 'queued' ? (
        <Card>
          <Heading>Saved offline</Heading>
          <Body>
            No connection, so your check-in is saved with the time of your GPS fix. It sends automatically when you're
            back online. If it lands after the deadline it counts as unverified, not missed.
          </Body>
        </Card>
      ) : null}
      {phase.kind === 'nofix' ? (
        <Card>
          <Heading>No GPS fix</Heading>
          <Body>{phase.reason}</Body>
          <Button title="Try again" onPress={() => void onCheckIn()} />
          <Button
            title="Send without location"
            variant="secondary"
            accessibilityHint="Records that you tried. It counts as unverified, which never costs you."
            onPress={() => void submit(attemptWithoutFix(instanceId, phase.capturedAt))}
          />
        </Card>
      ) : null}
      {phase.kind === 'permission' ? (
        <Card>
          <Heading>Location is off for Show Up</Heading>
          <Body>Check-ins need your location once per tap. Allow "While Using the App".</Body>
          {phase.blocked ? <Button title="Open Settings" onPress={() => void Linking.openSettings()} /> : null}
        </Card>
      ) : null}
      {phase.kind === 'error' ? <ErrorText error={phase.error} /> : null}

      {state === 'before' && !finished && myPlace && !myFreeze ? (
        <Button title="Freeze today" variant="ghost" onPress={onFreeze} />
      ) : null}

      {myResult ? (
        <Card>
          <Heading>Result</Heading>
          <Badge label={resultLabel[myResult.status].label} tone={resultLabel[myResult.status].tone} />
        </Card>
      ) : null}

      {myCheckins.length > 0 ? (
        <Card>
          <Heading>Your taps</Heading>
          {myCheckins.map((c) => (
            <Body key={c.id}>
              {formatTimeInZone(c.server_received_at, pact.tz)} · {c.verdict.replace(/_/g, ' ')}
              {c.accuracy_m !== null ? ` · ±${Math.round(c.accuracy_m)} m` : ''}
            </Body>
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  countdown: { fontSize: 22, fontWeight: '700', color: colors.text, textAlign: 'center' },
  center: { alignItems: 'center', paddingVertical: space.xl },
  big: {
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigDone: { backgroundColor: colors.success },
  bigDisabled: { backgroundColor: colors.muted, opacity: 0.5 },
  bigPressed: { transform: [{ scale: 0.97 }] },
  bigText: { color: colors.primaryText, fontSize: 28, fontWeight: '800' },
});

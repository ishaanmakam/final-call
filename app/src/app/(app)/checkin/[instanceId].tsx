import { useQueryClient } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, StyleSheet, View } from 'react-native';
import Animated, { FadeOut } from 'react-native-reanimated';
import { useInstanceDetail } from '@/api/queries';
import { RpcError, checkIn, declareFreeze } from '@/api/rpc';
import type { CheckinRow } from '@/api/types';
import { EmptyState, Icon, ListGroup, ListRow, Screen, Skeleton, StatusPill, Text, resultLabel } from '@/components';
import { CheckinButton, RING_SIZE, type RingTone } from '@/features/checkin/CheckinButton';
import { VerdictPanel } from '@/features/checkin/VerdictPanel';
import { WindowClock } from '@/features/checkin/WindowClock';
import {
  buttonState,
  busyFootnote,
  panelForError,
  panelForPermission,
  panelForQueued,
  panelForRow,
  resultFootnote,
  tapRow,
  type PanelAction,
  type VerdictPanel as Panel,
} from '@/features/checkin/copy';
import { useWindowPhase } from '@/features/checkin/useWindowPhase';
import { useUserId } from '@/lib/auth';
import type { CheckinAttempt } from '@/lib/checkinQueue';
import { enqueueCheckin, kickQueue } from '@/lib/checkinQueueRuntime';
import { captureAttempt } from '@/lib/checkinAttempt';
import { userMessage } from '@/lib/errors';
import { ensureForegroundPermission, takeHighAccuracyFix } from '@/lib/location';
import { formatDateInZone, formatTimeInZone } from '@/lib/time';
import { durations, haptic, space } from '@/theme';

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy'; stage: 'locating' | 'sending'; tappedAt: string }
  | { kind: 'panel'; panel: Panel; key: number; permissionBlocked?: boolean };

const RING_TONE: Record<Panel['tone'], RingTone> = { success: 'success', unverified: 'unverified', forfeit: 'forfeit', neutral: 'tint' };

export default function CheckInScreen() {
  const { instanceId } = useLocalSearchParams<{ instanceId: string }>();
  const userId = useUserId();
  const detail = useInstanceDetail(instanceId, userId);
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const panelCount = useRef(0);

  // one haptic per verdict, on the same frame the panel mounts
  const show = useCallback((panel: Panel, extra?: { permissionBlocked?: boolean }) => {
    haptic(panel.haptic);
    panelCount.current += 1;
    setPhase({ kind: 'panel', panel, key: panelCount.current, ...extra });
  }, []);

  // a blocked permission re-checks itself when the person comes back from Settings
  const blocked = phase.kind === 'panel' && phase.permissionBlocked === true;
  useEffect(() => {
    if (!blocked) return;
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      void ensureForegroundPermission().then((p) => {
        if (p === 'granted') setPhase({ kind: 'idle' });
      });
    });
    return () => sub.remove();
  }, [blocked]);

  if (detail.isPending) return <CheckInSkeleton />;
  if (detail.isError) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Check in' }} />
        <EmptyState
          layout="screen"
          icon="wifi.slash"
          title="Couldn't load this day"
          body={userMessage(detail.error)}
          action={{ label: 'Try again', onPress: () => void detail.refetch() }}
        />
      </Screen>
    );
  }
  return (
    <Loaded
      instanceId={instanceId}
      detail={detail.data}
      refetching={detail.isRefetching}
      refetch={() => void detail.refetch()}
      phase={phase}
      setPhase={setPhase}
      show={show}
      invalidate={(groupId: string) =>
        Promise.all([
          qc.invalidateQueries({ queryKey: ['instance', instanceId] }),
          qc.invalidateQueries({ queryKey: ['group', groupId] }),
        ])
      }
    />
  );
}

type Detail = NonNullable<ReturnType<typeof useInstanceDetail>['data']>;

function Loaded({
  instanceId,
  detail,
  refetching,
  refetch,
  phase,
  setPhase,
  show,
  invalidate,
}: {
  instanceId: string;
  detail: Detail;
  refetching: boolean;
  refetch: () => void;
  phase: Phase;
  setPhase: (p: Phase) => void;
  show: (panel: Panel, extra?: { permissionBlocked?: boolean }) => void;
  invalidate: (groupId: string) => Promise<unknown>;
}) {
  const { instance, pact, myPlace, judgedPlace, myCheckins, myResult, myFreeze } = detail;
  const windowPhase = useWindowPhase(instance.window_open_at, instance.deadline_at);
  const finished = ['closed', 'settled', 'voided'].includes(instance.status);
  const deadlineMs = Date.parse(instance.deadline_at);
  const inFromServer = myCheckins.some((c) => c.verdict === 'in_fence' && Date.parse(c.server_received_at) <= deadlineMs);
  const inFromPanel = phase.kind === 'panel' && phase.panel.pill === 'success';
  const alreadyIn = inFromServer || inFromPanel;
  const state = buttonState({
    phase: windowPhase,
    finished,
    frozen: !!myFreeze,
    alreadyIn,
    busy: phase.kind === 'busy' ? phase.stage : null,
  });
  const ringTone: RingTone = phase.kind === 'panel' ? RING_TONE[phase.panel.tone] : 'tint';
  const deadlineText = formatTimeInZone(instance.deadline_at, pact.tz);
  const refresh = () => invalidate(pact.group_id);

  const submit = async (attempt: CheckinAttempt, fixProblem: string | null) => {
    setPhase({ kind: 'busy', stage: 'sending', tappedAt: attempt.clientCapturedAt });
    try {
      const row: CheckinRow = await checkIn(attempt);
      show(panelForRow(row, judgedPlace, instance.deadline_at, pact.tz, fixProblem));
      kickQueue(); // network is clearly up: flush anything older
      await refresh();
    } catch (e) {
      if (e instanceof RpcError && e.kind !== 'rejected') {
        await enqueueCheckin(attempt);
        show(panelForQueued(attempt.clientCapturedAt, instance.deadline_at, pact.tz));
      } else {
        show(panelForError(e));
      }
    }
  };

  const onCheckIn = async () => {
    const permission = await ensureForegroundPermission();
    if (permission !== 'granted') {
      show(panelForPermission(permission === 'blocked'), { permissionBlocked: permission === 'blocked' });
      return;
    }
    const tappedAt = Date.now();
    setPhase({ kind: 'busy', stage: 'locating', tappedAt: new Date(tappedAt).toISOString() });
    // Fail-open: a failed or timed-out fix still sends the attempt with null coordinates, stamped with
    // the tap time, so the server records it as unverified instead of the day counting as missed.
    const { attempt, fixError } = await captureAttempt(instanceId, takeHighAccuracyFix, tappedAt);
    await submit(attempt, fixError);
  };

  const onAction = (action: PanelAction) => {
    if (action === 'openSettings') void Linking.openSettings();
    else if (action === 'signIn') router.replace('/sign-in');
    else void onCheckIn();
  };

  const onFreeze = () =>
    Alert.alert(
      `Freeze ${formatDateInZone(instance.deadline_at, pact.tz)}?`,
      "That day won't count for or against you. You have one freeze per week for this pact.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Freeze',
          style: 'destructive',
          onPress: () => {
            haptic('commit');
            void declareFreeze(instanceId)
              .then(refresh)
              .catch((e: unknown) => show(panelForError(e)));
          },
        },
      ],
    );

  const dateLine = [
    formatDateInZone(instance.deadline_at, pact.tz),
    judgedPlace?.label ?? (myPlace ? 'Your place' : null),
    judgedPlace ? `${judgedPlace.radiusM} m` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // the one status line under the circle, until a verdict replaces it
  let statusLine: string | null = null;
  if (phase.kind === 'busy') statusLine = busyFootnote(state, phase.tappedAt, pact.tz);
  else if (myFreeze) statusLine = 'You froze today. It counts for nothing either way.';
  else if (state === 'closed') statusLine = myResult ? null : 'Result posts within a minute.';
  else if (state === 'done') {
    const first = myCheckins.find((c) => c.verdict === 'in_fence' && Date.parse(c.server_received_at) <= deadlineMs);
    statusLine = first ? `You're in. Counted at ${formatTimeInZone(first.client_captured_at ?? first.server_received_at, pact.tz)}.` : "You're in.";
  } else statusLine = 'Your location is read once, when you tap.';

  const canFreeze = windowPhase === 'before' && !finished && !!myPlace && !myFreeze;

  return (
    <Screen refreshing={refetching} onRefresh={refetch}>
      <Stack.Screen options={{ title: pact.title }} />
      <Text variant="subheadline" color="secondary" align="center">
        {dateLine}
      </Text>
      <WindowClock phase={windowPhase} windowOpenAt={instance.window_open_at} deadlineAt={instance.deadline_at} tz={pact.tz} />

      {!myPlace ? (
        <EmptyState
          icon="location"
          title="You haven't joined this pact"
          body="Set your place for it and you can check in from the next window. The group sees whether you made it, never where you are."
          action={{ label: 'Set my place', onPress: () => router.push(`/pacts/${pact.id}/place`) }}
        />
      ) : (
        <>
          <View style={styles.moment}>
            <CheckinButton
              state={state}
              ringTone={ringTone}
              windowOpenAt={instance.window_open_at}
              deadlineAt={instance.deadline_at}
              onPress={() => void onCheckIn()}
              accessibilityHint="Reads your location once and sends it"
            />
          </View>

          {phase.kind === 'panel' ? (
            <View key={phase.key}>
              <VerdictPanel
                panel={phase.panel}
                onAction={onAction}
                onDismiss={() => setPhase({ kind: 'idle' })}
                actionDisabled={phase.panel.action === 'tryAgain' && state !== 'idle' && state !== 'done'}
              />
              {phase.panel.secondaryLine && state === 'idle' ? (
                <Text variant="footnote" color="secondary" align="center" style={styles.secondaryLine}>
                  {phase.panel.secondaryLine}
                </Text>
              ) : null}
            </View>
          ) : (
            <Animated.View key="status" exiting={FadeOut.duration(durations.press)} style={styles.status}>
              {state === 'closed' && myResult ? (
                <StatusPill state={myResult.status} who="Your result" style={styles.centerPill} />
              ) : statusLine ? (
                <Text variant="body" color="secondary" align="center" tabular>
                  {statusLine}
                </Text>
              ) : null}
            </Animated.View>
          )}

          {canFreeze ? (
            <ListGroup style={styles.section}>
              <ListRow
                leading={<Icon name="snowflake" size={20} color="frozen" />}
                title="Freeze today"
                subtitle="Today won't count for or against you. One per week per pact, before the window opens."
                onPress={onFreeze}
                accessibilityHint="Asks you to confirm"
              />
            </ListGroup>
          ) : null}
        </>
      )}

      {myCheckins.length > 0 ? (
        <ListGroup header="Today's taps" style={styles.section}>
          {myCheckins.map((c) => {
            const r = tapRow(c, instance.deadline_at, pact.tz);
            return (
              <ListRow
                key={c.id}
                title={r.title}
                subtitle={r.subtitle || undefined}
                trailing={<StatusPill state={r.state} size="compact" />}
                accessibilityLabel={`${r.title}, ${r.subtitle}`}
              />
            );
          })}
        </ListGroup>
      ) : null}

      {myResult ? (
        <ListGroup header="Result" footer={resultFootnote(myResult.status)} style={styles.section}>
          <ListRow
            title={formatDateInZone(instance.deadline_at, pact.tz)}
            subtitle={myResult.status === 'unverified' ? 'No money moved' : undefined}
            trailing={<StatusPill state={myResult.status} who={resultLabel[myResult.status].label} />}
          />
        </ListGroup>
      ) : null}

      {judgedPlace ? (
        <ListGroup
          header="Your place"
          footer="Judged against the place in force when the window opened. Your location is read once, when you tap, and nowhere else."
          style={styles.section}
        >
          <ListRow
            leading={<Icon name="location" size={20} color="secondary" />}
            title={judgedPlace.label ?? 'Your place'}
            subtitle={`${judgedPlace.radiusM} m circle · by ${deadlineText}`}
          />
        </ListGroup>
      ) : null}
    </Screen>
  );
}

function CheckInSkeleton() {
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Check in' }} />
      <View style={styles.skeletonLines}>
        <Skeleton width="55%" height={14} />
        <Skeleton width="40%" height={28} />
      </View>
      <View style={styles.moment}>
        <Skeleton width={RING_SIZE} height={RING_SIZE} radius={RING_SIZE / 2} />
      </View>
      <View style={styles.skeletonLines}>
        <Skeleton width="70%" height={16} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  moment: { paddingVertical: space.xl, alignItems: 'center' },
  status: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg },
  secondaryLine: { marginTop: space.sm },
  centerPill: { alignSelf: 'center' },
  section: { marginTop: space.md },
  skeletonLines: { alignItems: 'center', gap: space.sm, paddingTop: space.xs },
});

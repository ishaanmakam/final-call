import { useQueryClient } from '@tanstack/react-query';
import { Redirect, Stack, router, usePathname } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import type { InstanceDetail } from '@/api/queries';
import type { CheckinRow } from '@/api/types';
import { useToast } from '@/components';
import { useAuth } from '@/lib/auth';
import type { QueueEvent } from '@/lib/checkinQueue';
import { useCheckinQueueRunner } from '@/lib/checkinQueueRuntime';
import { useLocalNotificationSync } from '@/lib/localNotificationsRuntime';
import { registerForPush, useNotificationRouting } from '@/lib/push';
import { queueNotice } from '@/lib/queueNotice';
import { useReducedMotion, useTheme } from '@/theme';

/** A notice about an offline check-in stays long enough to read the money consequence. */
const NOTICE_MS = 6000;

function SignedIn({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { colors } = useTheme();
  const reduced = useReducedMotion();

  useEffect(() => {
    void registerForPush();
  }, [userId]);

  useNotificationRouting();
  // Boarding / Final call reminders on the phone itself, re-planned as the group and pact queries settle
  useLocalNotificationSync(userId);

  const onQueueEvent = useCallback(
    (event: QueueEvent<CheckinRow>) => {
      const instanceId = event.entry.instanceId;
      void qc.invalidateQueries({ queryKey: ['instance', instanceId] });
      void qc.invalidateQueries({ queryKey: ['group'] });
      // the cached day, if the person has opened it, names the pact and its deadline
      const cached = qc.getQueriesData<InstanceDetail>({ queryKey: ['instance', instanceId] }).find(([, d]) => d)?.[1];
      const notice = queueNotice(event, {
        pactTitle: cached?.pact.title,
        deadlineAt: cached?.instance.deadline_at,
        tz: cached?.pact.tz,
      });
      toast.show({
        message: notice.message,
        tone: notice.tone,
        icon: notice.icon,
        duration: NOTICE_MS,
        onPress: () => router.push(`/checkin/${instanceId}`),
      });
    },
    [qc, toast],
  );
  useCheckinQueueRunner(onQueueEvent);

  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.tint,
        headerTitleStyle: { color: colors.label },
        headerLargeTitleStyle: { color: colors.label },
        headerStyle: { backgroundColor: colors.bg },
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
        contentStyle: { backgroundColor: colors.bg },
        // Reduce Motion: crossfade instead of the push slide
        animation: reduced ? 'fade' : 'default',
      }}
    >
      {/* Per-screen defaults are titles only; screens set their own options with <Stack.Screen>. */}
      <Stack.Screen name="groups/index" options={{ title: 'Groups', headerLargeTitle: true }} />
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="groups/new" options={{ title: 'New group', presentation: 'modal', headerBackVisible: false }} />
      <Stack.Screen name="groups/[groupId]/index" options={{ title: 'Group' }} />
      <Stack.Screen name="groups/[groupId]/feed" options={{ title: 'Feed' }} />
      <Stack.Screen name="groups/[groupId]/ledger" options={{ title: 'Settle up' }} />
      <Stack.Screen name="groups/[groupId]/new-pact" options={{ title: 'New pact', presentation: 'modal' }} />
      <Stack.Screen name="pacts/[pactId]/index" options={{ title: 'Pact' }} />
      <Stack.Screen name="pacts/[pactId]/place" options={{ title: 'Your place' }} />
      <Stack.Screen name="checkin/[instanceId]" options={{ title: 'Check in' }} />
      <Stack.Screen name="join/[code]" options={{ title: 'Invitation' }} />
      <Stack.Screen name="settings" options={{ title: 'Settings' }} />
    </Stack>
  );
}

/** The auth gate: not content, so a plain indicator on the page ground is right here. */
function Gate() {
  const { colors } = useTheme();
  return (
    <View style={[styles.gate, { backgroundColor: colors.bg }]} accessibilityLabel="Loading" accessibilityState={{ busy: true }}>
      <ActivityIndicator color={colors.secondary} />
    </View>
  );
}

export default function AppLayout() {
  const { session, loading } = useAuth();
  const pathname = usePathname();
  if (loading) return <Gate />;
  if (!session) return <Redirect href={{ pathname: '/sign-in', params: { next: pathname } }} />;
  return <SignedIn userId={session.user.id} />;
}

const styles = StyleSheet.create({
  gate: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

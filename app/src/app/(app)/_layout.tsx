import { useQueryClient } from '@tanstack/react-query';
import { Link, Redirect, Stack, usePathname } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { Alert, Text } from 'react-native';
import type { CheckinRow } from '@/api/types';
import { colors } from '@/components/theme';
import { Loading } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import type { QueueEvent } from '@/lib/checkinQueue';
import { useCheckinQueueRunner } from '@/lib/checkinQueueRuntime';
import { registerForPush, useNotificationRouting } from '@/lib/push';

const verdictText: Record<CheckinRow['verdict'], string> = {
  in_fence: 'You were at your place.',
  out_of_fence: 'You were outside your place.',
  unjudgeable: 'GPS was too weak to judge.',
  rejected_simulated: 'The location looked simulated and was rejected.',
};

function SignedIn({ userId }: { userId: string }) {
  const qc = useQueryClient();

  useEffect(() => {
    void registerForPush();
  }, [userId]);

  useNotificationRouting();

  const onQueueEvent = useCallback(
    (event: QueueEvent<CheckinRow>) => {
      void qc.invalidateQueries({ queryKey: ['instance', event.entry.instanceId] });
      void qc.invalidateQueries({ queryKey: ['group'] });
      if (event.type === 'sent') {
        Alert.alert('Offline check-in delivered', verdictText[event.result.verdict]);
      } else if (event.type === 'rejected') {
        Alert.alert('Offline check-in not accepted', event.error);
      } else {
        Alert.alert('Offline check-in dropped', 'It could not be sent within 24 hours.');
      }
    },
    [qc],
  );
  useCheckinQueueRunner(onQueueEvent);

  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.primary,
        headerTitleStyle: { color: colors.text },
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen
        name="groups/index"
        options={{
          title: 'Groups',
          headerRight: () => (
            <Link href="/settings" accessibilityLabel="Settings">
              <Text style={{ color: colors.primary, fontSize: 16 }}>Settings</Text>
            </Link>
          ),
        }}
      />
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="groups/new" options={{ title: 'New group', presentation: 'modal' }} />
      <Stack.Screen name="groups/[groupId]/index" options={{ title: 'Group' }} />
      <Stack.Screen name="groups/[groupId]/feed" options={{ title: 'Feed' }} />
      <Stack.Screen name="groups/[groupId]/ledger" options={{ title: 'Ledger' }} />
      <Stack.Screen name="groups/[groupId]/new-pact" options={{ title: 'New pact', presentation: 'modal' }} />
      <Stack.Screen name="pacts/[pactId]/index" options={{ title: 'Pact' }} />
      <Stack.Screen name="pacts/[pactId]/place" options={{ title: 'Your place' }} />
      <Stack.Screen name="checkin/[instanceId]" options={{ title: 'Check in' }} />
      <Stack.Screen name="join/[code]" options={{ title: 'Join group' }} />
      <Stack.Screen name="settings" options={{ title: 'Settings' }} />
    </Stack>
  );
}

export default function AppLayout() {
  const { session, loading } = useAuth();
  const pathname = usePathname();
  if (loading) return <Loading />;
  if (!session) return <Redirect href={{ pathname: '/sign-in', params: { next: pathname } }} />;
  return <SignedIn userId={session.user.id} />;
}

import { useQueryClient } from '@tanstack/react-query';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { joinGroup } from '@/api/rpc';
import { EmptyState, Screen, Text } from '@/components';
import { userMessage } from '@/lib/errors';
import { space } from '@/theme';

/** Deep link target: showup://join/<code>. The group's name is not readable before joining (RLS). */
export default function JoinFromLink() {
  const params = useLocalSearchParams<{ code: string | string[] }>();
  const code = (Array.isArray(params.code) ? params.code[0] : params.code) ?? '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const qc = useQueryClient();

  const join = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // join_group returns the id for someone who is already a member, so a re-tapped link just opens the group
      const groupId = await joinGroup(code);
      await qc.invalidateQueries({ queryKey: ['groups'] });
      router.replace(`/groups/${groupId}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Invitation' }} />
      <Screen scroll={false}>
        <View style={styles.center}>
          <EmptyState
            icon="envelope.open"
            title="You're invited"
            body={`Code ${code.toUpperCase()}. Join to see the group's pacts and set your own place for each one. The group sees whether you made it, never where you are.`}
            action={{ label: 'Join group', onPress: () => void join(), loading: busy }}
            secondaryAction={{ label: 'Not now', onPress: () => router.replace('/groups') }}
          />
          {error ? (
            <Text variant="footnote" color="forfeit" align="center" style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="assertive">
              {userMessage(error)}
            </Text>
          ) : null}
        </View>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', paddingBottom: space.giant },
  error: { paddingHorizontal: space.lg },
});

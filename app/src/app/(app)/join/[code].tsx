import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { joinGroup } from '@/api/rpc';
import { Body, Button, Card, ErrorText, Heading, Screen } from '@/components/ui';

/** Deep link target: showup://join/<code> */
export default function JoinFromLink() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const qc = useQueryClient();

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
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
    <Screen>
      <Card>
        <Heading>You're invited</Heading>
        <Body>Invite code {code}</Body>
        <Body muted>Joining lets the group see your check-in results. Your location is never shared, only whether you made it.</Body>
      </Card>
      <ErrorText error={error} />
      <Button title="Join group" onPress={() => void join()} loading={busy} />
      <Button title="Not now" variant="ghost" onPress={() => router.replace('/groups')} />
    </Screen>
  );
}

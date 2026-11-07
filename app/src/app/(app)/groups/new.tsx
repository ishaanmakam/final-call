import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { createGroup, joinGroup } from '@/api/rpc';
import { Body, Button, Chip, ErrorText, Field, Row, Screen } from '@/components/ui';
import { inviteCodeFromUrl } from '@/lib/links';
import { deviceTimeZone, isValidTimeZone } from '@/lib/time';

export default function NewGroup() {
  const params = useLocalSearchParams<{ mode?: string }>();
  const [mode, setMode] = useState<'create' | 'join'>(params.mode === 'join' ? 'join' : 'create');
  const [name, setName] = useState('');
  const [tz, setTz] = useState(deviceTimeZone());
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const qc = useQueryClient();

  const submit = async () => {
    setError(null);
    let groupId: string;
    setBusy(true);
    try {
      if (mode === 'create') {
        if (name.trim().length < 2) throw new Error('Give the group a name.');
        if (!isValidTimeZone(tz.trim())) throw new Error(`Unknown time zone "${tz}". Use an IANA name like America/Los_Angeles.`);
        groupId = await createGroup(name.trim(), tz.trim());
      } else {
        const parsed = inviteCodeFromUrl(code);
        if (!parsed) throw new Error('Paste the invite link or type the code.');
        groupId = await joinGroup(parsed);
      }
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
      <Row>
        <Chip label="Create" selected={mode === 'create'} onPress={() => setMode('create')} />
        <Chip label="Join" selected={mode === 'join'} onPress={() => setMode('join')} />
      </Row>
      {mode === 'create' ? (
        <>
          <Field label="Group name" value={name} onChangeText={setName} placeholder="Morning crew" maxLength={60} />
          <Field
            label="Settlement time zone"
            value={tz}
            onChangeText={setTz}
            autoCapitalize="none"
            autoCorrect={false}
            hint="Weekly settle-up runs Monday at noon in this zone."
          />
        </>
      ) : (
        <>
          <Field
            label="Invite code or link"
            value={code}
            onChangeText={setCode}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="showup://join/… or code"
          />
          <Body muted>Groups hold up to 8 people.</Body>
        </>
      )}
      <ErrorText error={error} />
      <Button title={mode === 'create' ? 'Create group' : 'Join group'} onPress={() => void submit()} loading={busy} />
    </Screen>
  );
}

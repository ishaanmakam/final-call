import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Switch } from 'react-native';
import { useProfile, useUpdateProfile } from '@/api/queries';
import { Body, Button, Card, ErrorText, Field, Heading, Loading, QueryState, Row, Screen } from '@/components/ui';
import { signOut, useUserId } from '@/lib/auth';
import { checkinQueue } from '@/lib/checkinQueueRuntime';
import { clearPushOnSignOut, disablePush, enablePush, getNotificationsEnabled } from '@/lib/push';
import { normalizeVenmoUsername } from '@/lib/venmo';

export default function Settings() {
  const userId = useUserId();
  const profile = useProfile(userId);
  const update = useUpdateProfile(userId);
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [venmo, setVenmo] = useState('');
  const [notif, setNotif] = useState<boolean | null>(null);
  const [notifNote, setNotifNote] = useState<string | null>(null);
  const [queued, setQueued] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void getNotificationsEnabled().then(setNotif);
    void checkinQueue.pending().then((q) => setQueued(q.length));
  }, []);

  useEffect(() => {
    if (profile.data) {
      setName(profile.data.display_name);
      setVenmo(profile.data.venmo_username ?? '');
    }
  }, [profile.data]);

  if (profile.isPending) return <Loading />;
  if (profile.isError) return <QueryState error={profile.error} onRetry={() => void profile.refetch()} />;

  const save = () => {
    setError(null);
    setSaved(false);
    const v = venmo.trim() === '' ? null : normalizeVenmoUsername(venmo);
    if (venmo.trim() !== '' && v === null) {
      setError(new Error('Venmo usernames are 5 to 30 letters, numbers, - or _.'));
      return;
    }
    if (name.trim().length === 0) {
      setError(new Error('Display name cannot be empty.'));
      return;
    }
    update.mutate(
      { display_name: name.trim(), venmo_username: v },
      { onSuccess: () => setSaved(true), onError: setError },
    );
  };

  const toggleNotifications = async (on: boolean) => {
    setNotif(on);
    setNotifNote(null);
    try {
      if (on) {
        const r = await enablePush();
        if (r.status === 'denied') setNotifNote('Notifications are blocked in iOS Settings.');
        if (r.status === 'unavailable') setNotifNote(r.reason ?? 'Push is unavailable on this device.');
      } else {
        await disablePush();
      }
    } catch (e) {
      setError(e);
    }
  };

  const onSignOut = async () => {
    try {
      await clearPushOnSignOut();
    } catch {
      // best effort
    }
    try {
      await signOut();
      qc.clear();
      router.replace('/sign-in');
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Screen>
      <Card>
        <Heading>Profile</Heading>
        <Field label="Display name" value={name} onChangeText={setName} maxLength={40} />
        <Field
          label="Venmo username"
          value={venmo}
          onChangeText={setVenmo}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="@your-venmo"
          hint="Friends use this to pay you at settle-up."
        />
        <Button title="Save" onPress={save} loading={update.isPending} />
        {saved ? <Body muted>Saved.</Body> : null}
      </Card>

      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Body>Notifications</Body>
          <Switch
            value={notif ?? false}
            disabled={notif === null}
            onValueChange={(v) => void toggleNotifications(v)}
            accessibilityLabel="Notifications"
          />
        </Row>
        <Body muted>Window opening, 15-minute warnings, results, reviews and settle-up.</Body>
        {notifNote ? <Body muted>{notifNote}</Body> : null}
      </Card>

      {queued > 0 ? (
        <Card>
          <Body>
            {queued} offline check-in{queued === 1 ? '' : 's'} waiting to send.
          </Body>
        </Card>
      ) : null}

      <ErrorText error={error} />
      <Button title="Sign out" variant="danger" onPress={() => void onSignOut()} />
    </Screen>
  );
}

import { useQueryClient } from '@tanstack/react-query';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { createGroup, joinGroup } from '@/api/rpc';
import { Icon, ListGroup, ListRow, Screen, SegmentedControl, Sheet, Text, TextField } from '@/components';
import { NAME_MAX, canCreate, canJoin, groupNameError, normalizeInviteInput, parseInviteInput } from '@/features/groups/forms';
import { HeaderItems, HeaderTextButton } from '@/features/groups/headerButtons';
import { searchZones, zoneDisplayName } from '@/features/groups/timeZones';
import { userMessage } from '@/lib/errors';
import { deviceTimeZone } from '@/lib/time';
import { space } from '@/theme';

const MODES = ['Create', 'Join'] as const;
const ZONE_ROWS = 6;

const SETTLE_FOOTNOTE = "Every Monday at noon in this zone, the week's forfeits are totalled and everyone gets a Venmo link for what they owe.";
const JOIN_FOOTNOTE = 'Groups hold up to 8 people. Joining shows the group your check-in results, never your location.';

function dismiss() {
  if (router.canGoBack()) router.back();
  else router.replace('/groups');
}

export default function NewGroup() {
  const params = useLocalSearchParams<{ mode?: string }>();
  const [mode, setMode] = useState<'create' | 'join'>(params.mode === 'join' ? 'join' : 'create');
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [tz, setTz] = useState(() => deviceTimeZone());
  const [zonePicker, setZonePicker] = useState(false);
  const [zoneQuery, setZoneQuery] = useState('');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const qc = useQueryClient();

  const deviceTz = useMemo(() => deviceTimeZone(), []);
  const zones = useMemo(() => searchZones(zoneQuery, deviceTz).slice(0, ZONE_ROWS), [zoneQuery, deviceTz]);

  const valid = mode === 'create' ? canCreate(name) : canJoin(code);

  const submit = async () => {
    if (busy) return;
    setError(null);
    let request: () => Promise<string>;
    if (mode === 'create') {
      const err = groupNameError(name);
      setNameError(err);
      if (err) return;
      request = () => createGroup(name.trim(), tz);
    } else {
      const parsed = parseInviteInput(code);
      if ('error' in parsed) {
        setCodeError(parsed.error);
        return;
      }
      setCodeError(null);
      request = () => joinGroup(parsed.code);
    }
    setBusy(true);
    try {
      const groupId = await request();
      await qc.invalidateQueries({ queryKey: ['groups'] });
      router.replace(`/groups/${groupId}`);
    } catch (e) {
      // join errors are about the code (wrong, full); they belong under the field
      if (mode === 'join') setCodeError(userMessage(e));
      else setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: mode === 'create' ? 'New group' : 'Join a group',
          headerLeft: () => (
            <HeaderItems side="left">
              <HeaderTextButton title="Cancel" onPress={dismiss} />
            </HeaderItems>
          ),
          headerRight: () => (
            <HeaderItems>
              <HeaderTextButton title={mode === 'create' ? 'Create' : 'Join'} emphasis disabled={!valid} loading={busy} onPress={() => void submit()} />
            </HeaderItems>
          ),
        }}
      />
      <Screen>
        <SegmentedControl
          segments={MODES}
          index={mode === 'create' ? 0 : 1}
          onChange={(i) => {
            setMode(i === 0 ? 'create' : 'join');
            setError(null);
          }}
          accessibilityLabel="Create or join"
        />

        {mode === 'create' ? (
          <View style={styles.section}>
            <TextField
              label="Name"
              value={name}
              onChangeText={(t) => {
                setName(t);
                if (nameError) setNameError(null);
              }}
              error={nameError}
              placeholder="Morning crew"
              maxLength={NAME_MAX}
              autoFocus
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={() => void submit()}
            />
            <ListGroup footer={SETTLE_FOOTNOTE}>
              <ListRow
                title="Settles up in"
                leading={<Icon name="globe" size={20} color="secondary" />}
                trailing={
                  <Text variant="body" color="secondary" numberOfLines={1}>
                    {zoneDisplayName(tz)}
                  </Text>
                }
                chevron
                onPress={() => {
                  setZoneQuery('');
                  setZonePicker(true);
                }}
                accessibilityLabel={`Settles up in ${zoneDisplayName(tz)}`}
                accessibilityHint="Opens the time zone picker"
              />
            </ListGroup>
          </View>
        ) : (
          <View style={styles.section}>
            <TextField
              label="Invite link or code"
              value={code}
              onChangeText={(t) => {
                setCode(normalizeInviteInput(t));
                if (codeError) setCodeError(null);
              }}
              error={codeError}
              helper={JOIN_FOOTNOTE}
              placeholder="Paste the link or type the code"
              autoFocus
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              returnKeyType="join"
              onSubmitEditing={() => void submit()}
            />
          </View>
        )}

        {error ? (
          <Text variant="footnote" color="forfeit" accessibilityRole="alert" accessibilityLiveRegion="assertive">
            {userMessage(error)}
          </Text>
        ) : null}
      </Screen>

      <Sheet open={zonePicker} onClose={() => setZonePicker(false)} title="Settles up in">
        <TextField
          label="Search"
          value={zoneQuery}
          onChangeText={setZoneQuery}
          placeholder="City or zone"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        <ListGroup footer={zones.length === 0 ? 'No zone matches that. Try the nearest big city.' : 'Type to find other zones.'}>
          {zones.map((z) => (
            <ListRow
              key={z.tz}
              title={z.name}
              subtitle={z.tz === deviceTz ? `${z.city} · this device` : z.city}
              trailing={z.tz === tz ? <Icon name="checkmark" size={18} color="tint" accessibilityLabel="Selected" /> : undefined}
              onPress={() => {
                setTz(z.tz);
                setZonePicker(false);
              }}
              accessibilityLabel={`${z.name}, ${z.city}${z.tz === tz ? ', selected' : ''}`}
            />
          ))}
        </ListGroup>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.lg },
});

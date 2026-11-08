import { useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Platform, StyleSheet, Switch, TextInput, View, type TextInputProps } from 'react-native';
import Animated from 'react-native-reanimated';
import { useProfile, useUpdateProfile } from '@/api/queries';
import { Button, EmptyState, Icon, ListGroup, ListRow, Screen, SkeletonList, Text } from '@/components';
import { confirmDestructive } from '@/features/settings/confirm';
import { profilePatch, type ProfileSaved } from '@/features/settings/profileForm';
import { signOut, useUserId } from '@/lib/auth';
import { checkinQueue, kickQueue, subscribeToQueue } from '@/lib/checkinQueueRuntime';
import { classifyRpcError, userMessage } from '@/lib/errors';
import { clearPushOnSignOut, disablePush, enablePush, getNotificationsEnabled } from '@/lib/push';
import { TOUCH_TARGET, haptic, space, transition, type as typeScale, useTheme } from '@/theme';

const PROFILE_FOOTNOTE = "Friends use your Venmo to pay you at settle-up. Leave it blank and they'll pay you however you agree.";
const NOTIF_FOOTNOTE = 'When a window opens, 15 minutes before a deadline, results, reviews and settle-up.';
const ABOUT_FOOTNOTE =
  'Your location is read once, only when you tap Check In. Raw coordinates are deleted after 30 days. No real money moves through Show Up; it keeps the tally and hands out Venmo links at settle-up.';
const SAVED_MS = 2000;

/** A grouped-list row whose value is typed in place: label left, input right, autosaves on end-editing. */
function FieldRow({
  label,
  value,
  onChangeText,
  onEndEditing,
  prefix,
  last,
  ...input
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  onEndEditing: () => void;
  prefix?: string;
  last?: boolean;
} & Omit<TextInputProps, 'style' | 'value' | 'onChangeText' | 'onEndEditing'>) {
  const { colors } = useTheme();
  const body = typeScale.body;
  return (
    <View style={[styles.fieldRow, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }]}>
      <Text variant="body" nativeID={`${label}-label`} style={styles.fieldLabel}>
        {label}
      </Text>
      {prefix ? (
        <Text variant="body" color="secondary" accessibilityElementsHidden importantForAccessibility="no">
          {prefix}
        </Text>
      ) : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onEndEditing={onEndEditing}
        onBlur={onEndEditing}
        placeholderTextColor={colors.secondary}
        accessibilityLabel={label}
        accessibilityLabelledBy={`${label}-label`}
        maxFontSizeMultiplier={body.maxFontSizeMultiplier}
        returnKeyType="done"
        style={[styles.fieldInput, { color: colors.label, fontSize: body.fontSize, letterSpacing: body.letterSpacing }, prefix ? styles.fieldInputPrefixed : null]}
        {...input}
      />
    </View>
  );
}

const fadeTransition = transition('opacity', 'state');

export default function Settings() {
  const userId = useUserId();
  const profile = useProfile(userId);
  const update = useUpdateProfile(userId);
  const qc = useQueryClient();
  const { colors } = useTheme();
  const [name, setName] = useState('');
  const [venmo, setVenmo] = useState('');
  const dirty = useRef(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [notif, setNotif] = useState<boolean | null>(null);
  const [notifNote, setNotifNote] = useState<{ text: string; denied: boolean } | null>(null);
  const [queued, setQueued] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refreshQueued = useCallback(() => void checkinQueue.pending().then((q) => setQueued(q.length)), []);

  useEffect(() => {
    void getNotificationsEnabled().then(setNotif);
    refreshQueued();
    const unsubscribe = subscribeToQueue(refreshQueued);
    return () => {
      unsubscribe();
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, [refreshQueued]);

  // seed the fields from the profile, but never over what the person is typing
  useEffect(() => {
    if (profile.data && !dirty.current) {
      setName(profile.data.display_name);
      setVenmo(profile.data.venmo_username ?? '');
    }
  }, [profile.data]);

  const savedValues: ProfileSaved | null = profile.data
    ? { display_name: profile.data.display_name, venmo_username: profile.data.venmo_username }
    : null;

  const autosave = () => {
    if (!savedValues || update.isPending) return;
    const { patch, error: err } = profilePatch({ name, venmo }, savedValues);
    setProfileError(err);
    if (err || !patch) return;
    update.mutate(patch, {
      onSuccess: () => {
        dirty.current = false;
        setSaved(true);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), SAVED_MS);
      },
      onError: (e) => setProfileError(userMessage(e)),
    });
  };

  const toggleNotifications = async (on: boolean) => {
    setNotif(on);
    setNotifNote(null);
    haptic('snap');
    try {
      if (on) {
        const r = await enablePush();
        if (r.status === 'denied') setNotifNote({ text: 'Notifications are off in iOS Settings.', denied: true });
        if (r.status === 'unavailable') setNotifNote({ text: r.reason ?? 'Push is unavailable on this device.', denied: false });
      } else {
        await disablePush();
      }
    } catch (e) {
      setError(e);
    }
  };

  const onSignOut = async () => {
    const ok = await confirmDestructive({
      title: 'Sign out?',
      message: 'Your groups and results stay on the server. Sign back in any time with Apple or your email.',
      confirmLabel: 'Sign out',
    });
    if (!ok) return;
    haptic('commit');
    setSigningOut(true);
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
      setSigningOut(false);
    }
  };

  if (profile.isPending) {
    return (
      <Screen>
        <SkeletonList rows={2} subtitle={false} />
        <SkeletonList rows={1} />
        <SkeletonList rows={1} subtitle={false} />
      </Screen>
    );
  }
  if (!profile.data) {
    const network = classifyRpcError(profile.error) === 'network';
    return (
      <Screen>
        <EmptyState
          layout="screen"
          icon={network ? 'wifi.slash' : 'exclamationmark.triangle'}
          title={network ? "You're offline" : "Couldn't load your settings"}
          body={network ? 'Your profile will appear once you have a connection.' : userMessage(profile.error)}
          action={{ label: 'Try again', onPress: () => void profile.refetch(), loading: profile.isFetching }}
        />
      </Screen>
    );
  }

  const version = Constants.expoConfig?.version ?? '0.1.0';

  return (
    <Screen>
      <View>
        <View style={styles.headerRow}>
          <Text variant="footnote" color="secondary">
            Profile
          </Text>
          <Animated.View style={[fadeTransition, { opacity: saved || update.isPending ? 1 : 0 }]} accessibilityLiveRegion="polite">
            <Text variant="footnote" color={update.isPending ? 'secondary' : 'success'}>
              {update.isPending ? 'Saving…' : 'Saved'}
            </Text>
          </Animated.View>
        </View>
        <ListGroup>
          <View style={{ backgroundColor: colors.surface }}>
            <FieldRow
              label="Name"
              value={name}
              onChangeText={(t) => {
                dirty.current = true;
                setName(t);
              }}
              onEndEditing={autosave}
              maxLength={50}
              autoCapitalize="words"
              textContentType="name"
            />
            <FieldRow
              label="Venmo"
              value={venmo}
              onChangeText={(t) => {
                dirty.current = true;
                setVenmo(t.replace(/^@/, ''));
              }}
              onEndEditing={autosave}
              prefix="@"
              placeholder="username"
              autoCapitalize="none"
              autoCorrect={false}
              last
            />
          </View>
        </ListGroup>
        <View style={styles.footer}>
          {profileError ? (
            <Text variant="footnote" color="forfeit" accessibilityRole="alert" accessibilityLiveRegion="polite">
              {profileError}
            </Text>
          ) : (
            <Text variant="footnote" color="secondary">
              {PROFILE_FOOTNOTE}
            </Text>
          )}
        </View>
      </View>

      <ListGroup header="Notifications" footer={notifNote ? notifNote.text : NOTIF_FOOTNOTE}>
        <ListRow
          title="Allow notifications"
          leading={<Icon name="bell" size={20} color="secondary" />}
          trailing={
            <Switch
              value={notif ?? false}
              disabled={notif === null}
              onValueChange={(v) => void toggleNotifications(v)}
              accessibilityLabel="Allow notifications"
              trackColor={{ true: colors.tint, false: colors.fillStrong }}
              thumbColor={colors.surfaceElevated}
              {...(Platform.OS === 'ios' ? { ios_backgroundColor: colors.fillStrong } : {})}
              // react-native-web only: its active thumb defaults to teal
              {...(Platform.OS === 'web' ? { activeThumbColor: colors.surfaceElevated } : {})}
            />
          }
        />
        {notifNote?.denied ? (
          <ListRow
            title="Open Settings"
            leading={<Icon name="gearshape" size={20} color="tint" />}
            chevron
            onPress={() => void Linking.openSettings()}
            accessibilityHint="Opens iOS Settings for Show Up"
          />
        ) : null}
      </ListGroup>

      {queued > 0 ? (
        <ListGroup header="Offline" footer="Queued taps keep their original time. A tap that lands after its deadline counts as unverified, never missed.">
          <ListRow
            title={`${queued} check-in${queued === 1 ? '' : 's'} waiting to send`}
            subtitle="Sends when you're back online"
            leading={<Icon name="wifi.slash" size={20} color="secondary" />}
            trailing={<Button title="Send now" variant="tertiary" size="small" onPress={kickQueue} accessibilityHint="Retries sending now" />}
          />
        </ListGroup>
      ) : null}

      <ListGroup header="About" footer={ABOUT_FOOTNOTE}>
        <ListRow
          title="Version"
          trailing={
            <Text variant="body" color="secondary" tabular>
              {version}
            </Text>
          }
        />
      </ListGroup>

      <ListGroup>
        <ListRow title="Sign out" destructive onPress={() => void onSignOut()} disabled={signingOut} accessibilityHint="Asks you to confirm first" />
      </ListGroup>

      {error ? (
        <Text variant="footnote" color="forfeit" accessibilityRole="alert" accessibilityLiveRegion="assertive">
          {userMessage(error)}
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  fieldRow: {
    minHeight: TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.lg,
    paddingRight: space.md,
  },
  // a minimum, not a fixed width: "Venmo" at an accessibility size must not clip
  fieldLabel: { minWidth: 84 },
  fieldInput: { flex: 1, minHeight: TOUCH_TARGET, paddingVertical: space.sm + 2, paddingHorizontal: space.xs, textAlign: 'right' },
  fieldInputPrefixed: { textAlign: 'left', marginLeft: -space.sm + 2 },
  footer: { paddingHorizontal: space.lg, paddingTop: space.xs, gap: space.xs },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: space.lg, paddingBottom: space.xs },
});

import * as AppleAuthentication from 'expo-apple-authentication';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Linking, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DEMO } from '@/api/demo';
import { Button, Icon, Text, TextField } from '@/components';
import { EMAIL_INVALID, isValidEmail, safeNext } from '@/features/auth/magicLink';
import { sendMagicLink, signInWithApple, useAuth } from '@/lib/auth';
import { pendingNext } from '@/lib/pendingNextRuntime';
import { userMessage } from '@/lib/errors';
import { gutter, radius, space, useTheme } from '@/theme';

const PITCH = "Pledge a few dollars to be where you said you'd be. Show up and you split what the others forfeit. Miss, and your pledge goes to the pool.";
const PRIVACY = 'Your location is read once, only when you tap Check In during a window. Never in the background.';
/** the web simulator that shares the Pages site with this app (docs/DEPLOY.md §13) */
const SIMULATOR_URL = 'https://ishaanmakam.github.io/final-call/';

export default function SignIn() {
  const { session, loading } = useAuth();
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ next?: string; signedOut?: string }>();
  // demo mode: ?signedOut=1 means "show this screen"; the fake session is dropped a tick later
  const demoSignedOut = DEMO && (params.signedOut === '1' || params.signedOut === 'true');
  const [appleAvailable, setAppleAvailable] = useState(DEMO && Platform.OS !== 'ios');
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'apple' | 'email' | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (Platform.OS === 'ios') void AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
  }, []);

  if (loading) {
    return (
      <View style={[styles.gate, { backgroundColor: colors.bg }]} accessibilityLabel="Loading" accessibilityState={{ busy: true }}>
        <ActivityIndicator color={colors.secondary} />
      </View>
    );
  }
  if (session && !demoSignedOut) return <Redirect href={safeNext(params.next) as never} />;

  const onApple = async () => {
    setError(null);
    setBusy('apple');
    try {
      await signInWithApple();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'ERR_REQUEST_CANCELED') setError(e);
    } finally {
      setBusy(null);
    }
  };

  const onEmail = async () => {
    setError(null);
    if (!isValidEmail(email)) {
      setEmailError(EMAIL_INVALID);
      return;
    }
    setEmailError(null);
    setBusy('email');
    try {
      // the callback URL cannot carry `next` (A5): park it for auth-callback to pick up
      await pendingNext.set(params.next).catch(() => undefined);
      await sendMagicLink(email);
      setSentTo(email.trim());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const nativeApple = Platform.OS === 'ios' && !DEMO;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.wrap}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentInsetAdjustmentBehavior="automatic"
        >
          <View style={styles.hero}>
            <Text variant="largeTitle" accessibilityRole="header">
              Final Call
            </Text>
            <Text variant="body" color="secondary">
              {PITCH}
            </Text>
            <View style={styles.privacy}>
              <Icon name="location" size={14} color="tertiary" />
              <Text variant="footnote" color="secondary" style={styles.flex}>
                {PRIVACY}
              </Text>
            </View>
          </View>

          {sentTo ? (
            <View style={styles.sent} accessibilityLiveRegion="polite">
              <View style={[styles.iconWell, { backgroundColor: colors.fill }]}>
                <Icon name="envelope.open" size={24} color="secondary" />
              </View>
              <Text variant="title3" align="center" accessibilityRole="header">
                Check your email
              </Text>
              <Text variant="subheadline" color="secondary" align="center">
                We sent a sign-in link to {sentTo}. {Platform.OS === 'web' ? 'Open it in this browser.' : 'Open it on this phone.'}
              </Text>
              <View style={styles.sentActions}>
                {Platform.OS === 'ios' ? (
                  <Button
                    title="Open Mail"
                    variant="secondary"
                    size="small"
                    onPress={() => void Linking.openURL('message://').catch(() => undefined)}
                  />
                ) : null}
                <Button title="Use a different email" variant="tertiary" size="small" onPress={() => setSentTo(null)} />
              </View>
            </View>
          ) : (
            <View style={styles.form}>
              {appleAvailable ? (
                <>
                  {nativeApple ? (
                    <View pointerEvents={busy ? 'none' : 'auto'} style={busy === 'apple' && styles.dim}>
                      <AppleAuthentication.AppleAuthenticationButton
                        buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                        buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
                        cornerRadius={radius.md}
                        style={styles.apple}
                        onPress={() => void onApple()}
                      />
                    </View>
                  ) : (
                    <Button
                      title="Sign in with Apple"
                      variant="secondary"
                      leading={<Icon name="apple.logo" size={18} />}
                      loading={busy === 'apple'}
                      onPress={() => void onApple()}
                    />
                  )}
                  <View style={styles.divider} accessible={false}>
                    <View style={[styles.rule, { backgroundColor: colors.separator }]} />
                    <Text variant="footnote" color="secondary">
                      or
                    </Text>
                    <View style={[styles.rule, { backgroundColor: colors.separator }]} />
                  </View>
                </>
              ) : null}
              <TextField
                label="Email"
                value={email}
                onChangeText={(t) => {
                  setEmail(t);
                  if (emailError) setEmailError(null);
                }}
                error={emailError}
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="emailAddress"
                placeholder="name@example.com"
                returnKeyType="send"
                onSubmitEditing={() => void onEmail()}
              />
              <Button title="Email me a sign-in link" onPress={() => void onEmail()} loading={busy === 'email'} />
            </View>
          )}

          {error ? (
            <Text variant="footnote" color="forfeit" align="center" accessibilityRole="alert" accessibilityLiveRegion="assertive">
              {userMessage(error)}
            </Text>
          ) : null}

          <View style={styles.legal}>
            <Button title="Privacy" variant="tertiary" size="small" onPress={() => router.push('/legal/privacy')} accessibilityHint="Opens the privacy policy" />
            <Text variant="footnote" color="tertiary" accessibilityElementsHidden importantForAccessibility="no">
              ·
            </Text>
            <Button title="Terms" variant="tertiary" size="small" onPress={() => router.push('/legal/terms')} accessibilityHint="Opens the terms of use" />
            {Platform.OS === 'web' ? (
              <>
                <Text variant="footnote" color="tertiary" accessibilityElementsHidden importantForAccessibility="no">
                  ·
                </Text>
                <Button
                  title="Simulator"
                  variant="tertiary"
                  size="small"
                  onPress={() => void Linking.openURL(SIMULATOR_URL).catch(() => undefined)}
                  accessibilityHint="Opens the Final Call simulator, which runs a group through a season without an account"
                />
              </>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  gate: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  wrap: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: gutter, paddingVertical: space.xxl, gap: space.xxl },
  hero: { gap: space.md },
  privacy: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start', paddingTop: space.xs },
  form: { gap: space.lg },
  apple: { height: 50, width: '100%' },
  dim: { opacity: 0.45 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  sent: { alignItems: 'center', gap: space.sm, paddingVertical: space.lg },
  iconWell: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: space.xs },
  sentActions: { marginTop: space.md, alignItems: 'center', gap: space.xs },
  legal: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: space.xs, marginTop: -space.lg },
});

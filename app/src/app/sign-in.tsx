import * as AppleAuthentication from 'expo-apple-authentication';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, space } from '@/components/theme';
import { Body, Button, Card, ErrorText, Field, Heading, Loading, Title } from '@/components/ui';
import { sendMagicLink, signInWithApple, useAuth } from '@/lib/auth';

function safeNext(next: string | string[] | undefined): string {
  const value = Array.isArray(next) ? next[0] : next;
  return value && value.startsWith('/') && !value.startsWith('/sign-in') ? value : '/groups';
}

export default function SignIn() {
  const { session, loading } = useAuth();
  const params = useLocalSearchParams<{ next?: string }>();
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<'apple' | 'email' | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (Platform.OS === 'ios') void AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
  }, []);

  if (loading) return <Loading />;
  if (session) return <Redirect href={safeNext(params.next) as never} />;

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
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError(new Error('Enter a valid email address.'));
      return;
    }
    setBusy('email');
    try {
      await sendMagicLink(email);
      setSentTo(email.trim());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.wrap}>
        <Title>Show Up</Title>
        <Body muted>Make a pact with friends to be where you said you'd be. Miss it and your pledge goes to the pool.</Body>

        {appleAvailable ? (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
            cornerRadius={12}
            style={styles.apple}
            onPress={() => void onApple()}
          />
        ) : null}

        <Card>
          <Heading>Or use email</Heading>
          {sentTo ? (
            <Body>Check {sentTo} on this phone and tap the link to finish signing in.</Body>
          ) : (
            <>
              <Field
                label="Email"
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                textContentType="emailAddress"
                placeholder="you@uw.edu"
                returnKeyType="send"
                onSubmitEditing={() => void onEmail()}
              />
              <Button title="Email me a sign-in link" onPress={() => void onEmail()} loading={busy === 'email'} />
            </>
          )}
          {sentTo ? <Button title="Use a different email" variant="ghost" onPress={() => setSentTo(null)} /> : null}
        </Card>
        <ErrorText error={error} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  wrap: { flex: 1, padding: space.xl, gap: space.lg, justifyContent: 'center' },
  apple: { height: 50, width: '100%' },
});

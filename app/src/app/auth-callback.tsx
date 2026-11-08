import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { EmptyState, Screen, Text } from '@/components';
import { callbackErrorFromParams, exchangeErrorMessage, type CallbackParams } from '@/features/auth/magicLink';
import { completeMagicLink } from '@/lib/auth';
import { space, useTheme } from '@/theme';

/** Target of the magic link: showup://auth-callback?code=... (PKCE). */
export default function AuthCallback() {
  const params: CallbackParams = useLocalSearchParams<{ code?: string; error?: string; error_code?: string; error_description?: string }>();
  const { colors } = useTheme();
  const code = Array.isArray(params.code) ? params.code[0] : params.code;
  const [error, setError] = useState<string | null>(() => callbackErrorFromParams(params));

  useEffect(() => {
    if (error || !code) return;
    completeMagicLink(code)
      .then(() => router.replace('/groups'))
      .catch((e: unknown) => setError(exchangeErrorMessage(e)));
    // `error` is intentionally not a dependency: a failed exchange must not re-run on re-render
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!error) {
    return (
      <Screen scroll={false} contentStyle={styles.center} testID="auth-callback-busy">
        <View style={styles.busy} accessibilityLiveRegion="polite" accessibilityLabel="Signing you in" accessibilityState={{ busy: true }}>
          <ActivityIndicator color={colors.secondary} />
          <Text variant="subheadline" color="secondary">
            Signing you in…
          </Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll={false}>
      <EmptyState
        layout="screen"
        icon="envelope"
        title="Couldn't finish signing in"
        body={error}
        action={{ label: 'Back to sign in', onPress: () => router.replace('/sign-in') }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { justifyContent: 'center', alignItems: 'center' },
  busy: { alignItems: 'center', gap: space.md },
});

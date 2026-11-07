import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { isSupabaseConfigured } from '@/api/supabase';
import { colors } from '@/components/theme';
import { Body, Screen, Title } from '@/components/ui';
import { AuthProvider } from '@/lib/auth';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 2 },
  },
});

function useAppFocus() {
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (Platform.OS !== 'web') focusManager.setFocused(state === 'active');
    });
    return () => sub.remove();
  }, []);
}

function MissingConfig() {
  return (
    <Screen>
      <Title>Setup needed</Title>
      <Body>
        EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY are not set. Copy .env.example to .env (local) or
        add them as EAS environment variables, then rebuild or restart Metro.
      </Body>
    </Screen>
  );
}

export default function RootLayout() {
  useAppFocus();
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {isSupabaseConfigured ? (
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <Stack
              screenOptions={{
                headerTintColor: colors.primary,
                headerTitleStyle: { color: colors.text },
                contentStyle: { backgroundColor: colors.bg },
              }}
            >
              <Stack.Screen name="(app)" options={{ headerShown: false }} />
              <Stack.Screen name="sign-in" options={{ headerShown: false }} />
              <Stack.Screen name="auth-callback" options={{ title: 'Signing in' }} />
            </Stack>
          </AuthProvider>
        </QueryClientProvider>
      ) : (
        <MissingConfig />
      )}
    </SafeAreaProvider>
  );
}

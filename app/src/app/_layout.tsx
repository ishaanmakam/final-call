import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { DEMO, DemoParamsSync } from '@/api/demo';
import { isSupabaseConfigured } from '@/api/supabase';
import { ToastProvider } from '@/components/Toast';
import { Body, Screen, Title } from '@/components/ui';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider, useTheme } from '@/theme';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: DEMO ? 0 : 2 },
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
        add them as EAS environment variables, then rebuild or restart Metro. Or run with EXPO_PUBLIC_DEMO=1 for
        fixture data.
      </Body>
    </Screen>
  );
}

/** Native stack chrome follows the theme; header and content colors come from the palette. */
function ThemedStack() {
  const { colors, scheme } = useTheme();
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerTintColor: colors.tint,
          headerTitleStyle: { color: colors.label },
          headerStyle: { backgroundColor: colors.bg },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="(app)" options={{ headerShown: false }} />
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="auth-callback" options={{ title: 'Signing in' }} />
      </Stack>
    </>
  );
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default function RootLayout() {
  useAppFocus();
  const configured = isSupabaseConfigured || DEMO;
  return (
    <Providers>
      {configured ? (
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            {DEMO ? <DemoParamsSync /> : null}
            <ThemedStack />
          </AuthProvider>
        </QueryClientProvider>
      ) : (
        <MissingConfig />
      )}
    </Providers>
  );
}

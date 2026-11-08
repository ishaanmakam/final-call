import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { DEMO, DemoParamsSync } from '@/api/demo';
import { isSupabaseConfigured } from '@/api/supabase';
import { Screen, Text } from '@/components';
import { ToastProvider } from '@/components/Toast';
import { AuthProvider } from '@/lib/auth';
import { initSentry, wrapRoot } from '@/lib/sentry';
import { ThemeProvider, useTheme } from '@/theme';

// Crash reporting first, so a failure anywhere below is reported. No-op without EXPO_PUBLIC_SENTRY_DSN.
initSentry();

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

/** Developer-only: the app has no backend to talk to. Blunt on purpose, labelled so a tester knows. */
function MissingConfig() {
  return (
    <Screen>
      <Text variant="title2" accessibilityRole="header">
        Setup needed (developer)
      </Text>
      <Text variant="body" color="secondary">
        EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY are not set. Copy .env.example to .env (local) or add
        them as EAS environment variables, then rebuild or restart Metro. Or run with EXPO_PUBLIC_DEMO=1 for fixture
        data.
      </Text>
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
        <Stack.Screen name="auth-callback" options={{ headerShown: false }} />
        {/* legal pages live outside the signed-in group: the sign-in footer links to them */}
        <Stack.Screen name="legal/privacy" options={{ title: 'Privacy policy', headerBackButtonDisplayMode: 'minimal' }} />
        <Stack.Screen name="legal/terms" options={{ title: 'Terms of use', headerBackButtonDisplayMode: 'minimal' }} />
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

function RootLayout() {
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

// Sentry.wrap only when enabled: touch breadcrumbs and the app-start span; otherwise the plain component.
export default wrapRoot(RootLayout);

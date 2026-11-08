import type { Session } from '@supabase/supabase-js';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEMO, DEMO_USER_ID, getDemoSettings, subscribeDemoSettings } from '../api/demo/settings';
import { supabase } from '../api/supabase';
import { nonceFromBytes } from '../features/auth/appleNonce';
import { cancelAllLocalNotifications } from './localNotificationsRuntime';

interface AuthState {
  session: Session | null;
  loading: boolean;
}

const AuthContext = createContext<AuthState>({ session: null, loading: true });

/** A session-shaped object for demo mode; nothing here is ever sent anywhere. */
const demoSession = (): Session =>
  ({
    access_token: 'demo',
    refresh_token: 'demo',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: DEMO_USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'demo@finalcall.app',
      app_metadata: {},
      user_metadata: {},
      created_at: new Date(0).toISOString(),
    },
  }) as unknown as Session;

function DemoAuthProvider({ children }: { children: ReactNode }) {
  const [signedOut, setSignedOut] = useState(() => getDemoSettings().signedOut);
  useEffect(() => subscribeDemoSettings((s) => setSignedOut(s.signedOut)), []);
  const value = useMemo<AuthState>(() => ({ session: signedOut ? null : demoSession(), loading: false }), [signedOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function SupabaseAuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ session: null, loading: true });

  useEffect(() => {
    let mounted = true;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (mounted) setState({ session: data.session, loading: false });
      })
      .catch(() => {
        if (mounted) setState({ session: null, loading: false });
      });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (mounted) setState({ session, loading: false });
    });
    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo(() => state, [state]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const AuthProvider = DEMO ? DemoAuthProvider : SupabaseAuthProvider;

export const useAuth = (): AuthState => useContext(AuthContext);

/** Current user id. Only call inside the signed-in route group. */
export function useUserId(): string {
  const { session } = useAuth();
  if (!session) throw new Error('useUserId called without a session');
  return session.user.id;
}

export const AUTH_CALLBACK_PATH = 'auth-callback';

/**
 * Replay protection (features/auth/appleNonce.ts): Apple gets the SHA-256 of a fresh random nonce
 * and embeds it in the identity token; Supabase gets the raw nonce, hashes it and compares.
 */
export async function signInWithApple(): Promise<void> {
  if (DEMO) return;
  const rawNonce = nonceFromBytes(await Crypto.getRandomBytesAsync(16));
  const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);
  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
    nonce: hashedNonce,
  });
  if (!credential.identityToken) throw new Error('Apple did not return an identity token.');
  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: 'apple',
    token: credential.identityToken,
    nonce: rawNonce,
  });
  if (error) throw error;
  // Apple only shares the name on the very first sign-in; keep it if we got it.
  const fullName = credential.fullName
    ? AppleAuthentication.formatFullName(credential.fullName, 'default').trim()
    : '';
  if (fullName && data.user) {
    await supabase.from('profiles').update({ display_name: fullName }).eq('id', data.user.id);
  }
}

export async function sendMagicLink(email: string): Promise<void> {
  if (DEMO) return;
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: Linking.createURL(AUTH_CALLBACK_PATH), shouldCreateUser: true },
  });
  if (error) throw error;
}

/** Completes the PKCE magic-link flow from `finalcall://auth-callback?code=...`. */
export async function completeMagicLink(code: string): Promise<void> {
  if (DEMO) return;
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  if (DEMO) return;
  // another account may sign in on this phone: drop every local reminder of ours first
  await cancelAllLocalNotifications().catch(() => undefined);
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/**
 * Account deletion (Settings): the server anonymizes the profile and erases the identity
 * (`delete_my_account`, CONTRACT.md "Account deletion"); afterwards the local session is dropped
 * the same way as a sign-out. Throws the RPC error (e.g. the open-window refusal) before anything
 * local changes.
 */
export async function deleteAccountAndSignOut(deleteOnServer: () => Promise<unknown>): Promise<void> {
  await deleteOnServer();
  if (DEMO) return;
  await cancelAllLocalNotifications().catch(() => undefined);
  // the auth row is gone, so the server-side sign-out may 403: the local session is what matters
  await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
}

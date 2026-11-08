import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { AppState, Platform } from 'react-native';
import { createChunkedStore } from '../lib/secureChunks';
import type { Database } from './types';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const isSupabaseConfigured = url.startsWith('http') && anonKey.length > 0;

/**
 * Session (and PKCE verifier) live in the iOS Keychain via expo-secure-store. SecureStore caps a
 * value at 2048 bytes and a session JSON is bigger, so values are split into <= 1900-byte chunks
 * (see lib/secureChunks.ts). Keychain writes have no cross-item transaction; a torn write reads
 * back as "no session", never as a corrupt one.
 */
const secureStorage = createChunkedStore({
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
});

export const supabase = createClient<Database>(
  isSupabaseConfigured ? url : 'http://localhost:54321',
  isSupabaseConfigured ? anonKey : 'missing-anon-key',
  {
    auth: {
      storage: Platform.OS === 'web' ? undefined : secureStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
  },
);

// Refresh tokens only while foregrounded (recommended for React Native).
AppState.addEventListener('change', (state) => {
  if (state === 'active') void supabase.auth.startAutoRefresh();
  else void supabase.auth.stopAutoRefresh();
});

export const REVIEW_PHOTO_BUCKET = 'review-photos';

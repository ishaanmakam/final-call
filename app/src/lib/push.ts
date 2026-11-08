import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { DEMO } from '../api/demo/settings';
import { registerPushToken } from '../api/rpc';
import { supabase } from '../api/supabase';
import { routeFromData } from './pushRoute';

const PREF_KEY = 'finalcall.notificationsEnabled';
const TOKEN_KEY = 'finalcall.expoPushToken';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function getNotificationsEnabled(): Promise<boolean> {
  return (await SecureStore.getItemAsync(PREF_KEY)) !== 'false';
}

function easProjectId(): string | undefined {
  const fromExtra = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  return fromExtra || Constants.easConfig?.projectId || undefined;
}

export type PushRegistration =
  | { status: 'registered'; token: string }
  | { status: 'disabled' | 'denied' | 'unavailable'; reason?: string };

/** Ask for permission, fetch the Expo push token and store it server-side. */
export async function registerForPush(): Promise<PushRegistration> {
  if (DEMO) return { status: 'unavailable', reason: 'Push is off in demo mode.' };
  if (!(await getNotificationsEnabled())) return { status: 'disabled' };
  let perms = await Notifications.getPermissionsAsync();
  if (!perms.granted && perms.canAskAgain) perms = await Notifications.requestPermissionsAsync();
  if (!perms.granted) return { status: 'denied' };
  const projectId = easProjectId();
  if (!projectId) return { status: 'unavailable', reason: 'No EAS projectId configured (set EAS_PROJECT_ID).' };
  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await registerPushToken(token, Platform.OS);
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    return { status: 'registered', token };
  } catch (e) {
    // Simulators have no push token; never block sign-in on push.
    return { status: 'unavailable', reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Turn notifications off for this device. Contract has no unregister RPC, so this deletes the
 * caller's own push_tokens row (needs an RLS delete policy: user_id = auth.uid()).
 */
export async function disablePush(): Promise<void> {
  await SecureStore.setItemAsync(PREF_KEY, 'false');
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  if (token) {
    const { error } = await supabase.from('push_tokens').delete().eq('token', token);
    if (error) throw new Error(error.message);
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  }
}

export async function enablePush(): Promise<PushRegistration> {
  await SecureStore.setItemAsync(PREF_KEY, 'true');
  return registerForPush();
}

/** Forget the device token locally on sign-out (server row is removed best-effort). */
export async function clearPushOnSignOut(): Promise<void> {
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  if (token) {
    await supabase.from('push_tokens').delete().eq('token', token);
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  }
}

export { routeFromData };

/** The last notification tap this process acted on, so a remount never replays it (A4). */
let handledResponseId: string | null = null;

/** Tapping a notification opens the matching screen (payload keys: url | kind + ids). */
export function useNotificationRouting(): void {
  useEffect(() => {
    const open = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      const id = response.notification.request.identifier;
      if (id === handledResponseId) return;
      handledResponseId = id;
      const target = routeFromData(response.notification.request.content.data as Record<string, unknown> | undefined);
      if (target) router.push(target as never);
    };
    // cold start from a notification: the response that launched the app (once per process)
    open(Notifications.getLastNotificationResponse());
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, []);
}

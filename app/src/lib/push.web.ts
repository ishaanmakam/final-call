/**
 * Web build of push.ts: Expo push and the Keychain do not exist here, so every call is a no-op
 * that reports "unavailable". Same exports as push.ts (Metro picks this file for --platform web).
 */
export type PushRegistration =
  | { status: 'registered'; token: string }
  | { status: 'disabled' | 'denied' | 'unavailable'; reason?: string };

let enabled = true;

export async function getNotificationsEnabled(): Promise<boolean> {
  return enabled;
}

export async function registerForPush(): Promise<PushRegistration> {
  return { status: 'unavailable', reason: 'Push notifications are not available on the web.' };
}

export async function disablePush(): Promise<void> {
  enabled = false;
}

export async function enablePush(): Promise<PushRegistration> {
  enabled = true;
  return registerForPush();
}

export async function clearPushOnSignOut(): Promise<void> {
  // nothing registered on the web
}

export function useNotificationRouting(): void {
  // no notification taps on the web
}

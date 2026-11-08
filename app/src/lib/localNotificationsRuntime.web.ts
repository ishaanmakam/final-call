/**
 * Web build of localNotificationsRuntime.ts: no local notifications in the browser (the web
 * bundle exists for the screenshot harness and demos). Same exports, all no-ops.
 */
import type { QueryClient } from '@tanstack/react-query';

export function syncLocalNotifications(_qc: QueryClient, _userId: string): Promise<void> {
  return Promise.resolve();
}

export async function cancelAllLocalNotifications(): Promise<void> {
  // nothing scheduled on the web
}

export function useLocalNotificationSync(_userId: string): void {
  // nothing to sync on the web
}

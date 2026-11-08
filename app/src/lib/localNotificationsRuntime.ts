/**
 * Applies `planLocalNotifications` with expo-notifications. Mount `useLocalNotificationSync`
 * once in the signed-in tree: it re-plans whenever a group home, pact or check-in query settles
 * and whenever the app returns to the foreground, cancels the local twin of a server push that
 * arrives first, and never asks for permission itself (push registration owns the one prompt;
 * without the grant this is a no-op). Web and demo builds: no-op (see the .web.ts twin).
 */
import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { DEMO } from '../api/demo/settings';
import {
  BOARDING_PREFIX,
  isOurIdentifier,
  localIdentifierForPush,
  planLocalNotifications,
  upcomingFromQueryCache,
  type PlannedNotification,
} from './localNotifications';
import { captureException } from './sentry';

/** Query updates arrive in bursts (group home, then its instance); plan once per burst. */
const DEBOUNCE_MS = 1500;

function triggerInstant(trigger: unknown): number | null {
  if (!trigger || typeof trigger !== 'object') return null;
  const t = trigger as Record<string, unknown>;
  for (const key of ['value', 'timestamp', 'date']) {
    const v = t[key];
    if (typeof v === 'number') return v;
    if (v instanceof Date) return v.getTime();
  }
  return null;
}

function requestFor(n: PlannedNotification): Notifications.NotificationRequestInput {
  return {
    identifier: n.identifier,
    content: {
      title: n.title,
      body: n.body,
      sound: 'default',
      data: {
        url: n.url,
        instance_id: n.identifier.slice(n.identifier.indexOf(':') + 1),
        kind: n.identifier.startsWith(BOARDING_PREFIX) ? 'window_open' : 'deadline_soon',
        local: true,
      },
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: n.at },
  };
}

let inFlight: Promise<void> | null = null;

/** Plan from the cache and apply the diff. Serialized: a second call waits for the first. */
export function syncLocalNotifications(qc: QueryClient, userId: string): Promise<void> {
  if (DEMO || Platform.OS === 'web') return Promise.resolve();
  const run = async () => {
    const perms = await Notifications.getPermissionsAsync();
    if (!perms.granted) return; // push registration asks; we never add a second prompt
    const pending = await Notifications.getAllScheduledNotificationsAsync();
    const ids = new Set(pending.map((r) => r.identifier));
    const at = new Map<string, number>();
    for (const r of pending) {
      const ms = triggerInstant(r.trigger);
      if (isOurIdentifier(r.identifier) && ms !== null) at.set(r.identifier, ms);
    }
    const plan = planLocalNotifications(upcomingFromQueryCache(qc, userId, Date.now()), ids, Date.now(), at);
    for (const id of plan.cancel) await Notifications.cancelScheduledNotificationAsync(id);
    for (const n of plan.schedule) await Notifications.scheduleNotificationAsync(requestFor(n));
  };
  const next = (inFlight ?? Promise.resolve())
    .then(run)
    .catch((e: unknown) => captureException(e, { where: 'localNotifications.sync' }));
  inFlight = next;
  return next;
}

/** Sign-out: drop every reminder of ours (another account may sign in on this phone). */
export async function cancelAllLocalNotifications(): Promise<void> {
  if (DEMO || Platform.OS === 'web') return;
  const pending = await Notifications.getAllScheduledNotificationsAsync();
  for (const r of pending) {
    if (isOurIdentifier(r.identifier)) await Notifications.cancelScheduledNotificationAsync(r.identifier);
  }
}

export function useLocalNotificationSync(userId: string): void {
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (DEMO || Platform.OS === 'web') return;
    const schedule = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = undefined;
        void syncLocalNotifications(qc, userId);
      }, DEBOUNCE_MS);
    };
    schedule();

    const unsubscribeCache = qc.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      const head = event.query.queryKey[0];
      if (head === 'group' || head === 'pact' || head === 'instance') schedule();
    });
    const appState = AppState.addEventListener('change', (s) => {
      if (s === 'active') schedule();
    });
    // a server push for the same moment arrived first: drop the local twin (no double buzz)
    const received = Notifications.addNotificationReceivedListener((n) => {
      const id = localIdentifierForPush(n.request.content.data as Record<string, unknown> | undefined);
      if (id) void Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
    });
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = undefined;
      unsubscribeCache();
      appState.remove();
      received.remove();
    };
  }, [qc, userId]);
}

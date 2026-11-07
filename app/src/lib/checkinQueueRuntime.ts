import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { sendQueuedCheckin } from '../api/rpc';
import type { CheckinRow } from '../api/types';
import { CheckinQueue, type QueueEvent, type QueueStorage } from './checkinQueue';

const STORAGE_KEY = 'showup.checkinQueue.v1';

const asyncStorage: QueueStorage = {
  load: () => AsyncStorage.getItem(STORAGE_KEY),
  save: (value) => AsyncStorage.setItem(STORAGE_KEY, value),
};

type Listener = (event: QueueEvent<CheckinRow>) => void;
const listeners = new Set<Listener>();

export const checkinQueue = new CheckinQueue<CheckinRow>({
  storage: asyncStorage,
  send: sendQueuedCheckin,
  onEvent: (event) => listeners.forEach((l) => l(event)),
});

export function subscribeToQueue(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let timer: ReturnType<typeof setTimeout> | undefined;

async function scheduleNextWake(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (AppState.currentState !== 'active') return;
  const wake = await checkinQueue.nextWakeAt();
  if (wake === null) return;
  timer = setTimeout(
    () => {
      void checkinQueue.flush().finally(scheduleNextWake);
    },
    Math.max(0, wake - Date.now()),
  );
}

/** Retry immediately, e.g. after a successful request proves the network is back. */
export function kickQueue(): void {
  void checkinQueue.retryNow().finally(scheduleNextWake);
}

/** Enqueue an attempt whose live send failed for network reasons, then schedule retries. */
export async function enqueueCheckin(...args: Parameters<typeof checkinQueue.enqueue>): Promise<void> {
  await checkinQueue.enqueue(...args);
  await scheduleNextWake();
}

/**
 * Mount once inside the signed-in tree. Retries on launch and every time the app comes to
 * the foreground (the usual moment the network is back), then follows the backoff schedule
 * while foregrounded. No NetInfo native module is used; see README.
 */
export function useCheckinQueueRunner(onEvent?: Listener): void {
  useEffect(() => {
    kickQueue();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') kickQueue();
      else if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    });
    const unsubscribe = onEvent ? subscribeToQueue(onEvent) : undefined;
    return () => {
      sub.remove();
      unsubscribe?.();
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
  }, [onEvent]);
}

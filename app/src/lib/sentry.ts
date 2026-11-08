/**
 * Crash reporting, off unless `EXPO_PUBLIC_SENTRY_DSN` is set (and never in demo mode). Every
 * event and breadcrumb passes through `scrubLocation`, so coordinates never leave the phone this
 * way. `captureException` is safe to call anywhere: a no-op when Sentry is off.
 */
import * as Sentry from '@sentry/react-native';
import type { ComponentType } from 'react';
import { DEMO } from '../api/demo/settings';
import { scrubLocation } from './sentryScrub';

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;

export const sentryEnabled: boolean = typeof DSN === 'string' && DSN.length > 0 && !DEMO;

let started = false;

/** Call once, before the root renders. Idempotent. */
export function initSentry(): void {
  if (!sentryEnabled || started) return;
  started = true;
  Sentry.init({
    dsn: DSN,
    environment: process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT || (__DEV__ ? 'development' : 'production'),
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    enableAutoSessionTracking: true,
    beforeSend: (event) => scrubLocation(event),
    beforeBreadcrumb: (breadcrumb) => scrubLocation(breadcrumb),
  });
}

/** Report an unexpected error with optional context (scrubbed). */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!sentryEnabled) return;
  Sentry.captureException(error, context ? { extra: scrubLocation(context) } : undefined);
}

/** Wraps the root component for touch-event breadcrumbs and app-start spans, only when enabled. */
export function wrapRoot<P extends Record<string, unknown>>(component: ComponentType<P>): ComponentType<P> {
  return sentryEnabled ? Sentry.wrap(component) : component;
}

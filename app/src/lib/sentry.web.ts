/**
 * Web build of sentry.ts: the web bundle exists for screenshots and demos, so crash reporting is
 * off there. Same exports, all no-ops (Metro picks this file for --platform web).
 */
import type { ComponentType } from 'react';

export const sentryEnabled = false;

export function initSentry(): void {
  // off on the web
}

export function captureException(_error: unknown, _context?: Record<string, unknown>): void {
  // off on the web
}

export function wrapRoot<P extends Record<string, unknown>>(component: ComponentType<P>): ComponentType<P> {
  return component;
}

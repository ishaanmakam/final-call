/**
 * Ready-to-use Reanimated configs built from the motion tokens. Every spring passes
 * `reduceMotion: ReduceMotion.System`, so the OS setting is honored without each call site
 * remembering to. Import `tokens` directly when you only need the numbers (tests do).
 */
import type { ViewStyle } from 'react-native';
import {
  Easing,
  ReduceMotion,
  cubicBezier,
  withSpring,
  withTiming,
  type CSSTransitionProperties,
  type WithSpringConfig,
  type WithTimingConfig,
} from 'react-native-reanimated';
import { durations, easings, springs as springTokens, type DurationName, type EasingName, type SpringName } from './tokens';

export { useReducedMotion } from 'react-native-reanimated';

const bezier = ([x1, y1, x2, y2]: readonly [number, number, number, number]) => Easing.bezier(x1, y1, x2, y2);

/** Reanimated easing functions for `withTiming`. */
export const easing: Record<EasingName, ReturnType<typeof Easing.bezier>> = {
  out: bezier(easings.out),
  inOut: bezier(easings.inOut),
  sheet: bezier(easings.sheet),
  linear: bezier(easings.linear),
};

/** `cubic-bezier(...)` strings for Reanimated CSS transitions in styles. */
export const cssEasing: Record<EasingName, `cubic-bezier(${string})`> = {
  out: `cubic-bezier(${easings.out.join(', ')})`,
  inOut: `cubic-bezier(${easings.inOut.join(', ')})`,
  sheet: `cubic-bezier(${easings.sheet.join(', ')})`,
  linear: `cubic-bezier(${easings.linear.join(', ')})`,
};

const cssTiming: Record<EasingName, ReturnType<typeof cubicBezier>> = {
  out: cubicBezier(...easings.out),
  inOut: cubicBezier(...easings.inOut),
  sheet: cubicBezier(...easings.sheet),
  linear: cubicBezier(...easings.linear),
};

/**
 * A Reanimated CSS transition for a state change with no finger on it (press scale, a border
 * turning tint on focus). Spread it into an `Animated.View` style next to the properties it
 * animates; no shared value needed. Returns ViewStyle so it composes with StyleSheet arrays.
 */
export function transition(
  property: 'transform' | 'opacity' | 'backgroundColor' | 'borderColor' | 'borderWidth' | Array<'transform' | 'opacity' | 'backgroundColor' | 'borderColor' | 'borderWidth'>,
  duration: DurationName,
  ease: EasingName = 'out',
): ViewStyle {
  const t: CSSTransitionProperties = {
    transitionProperty: property,
    transitionDuration: `${durations[duration]}ms`,
    transitionTimingFunction: cssTiming[ease],
  };
  return t as unknown as ViewStyle;
}

/** Spring config by name. Pass `velocity` from a gesture's release for the momentum springs. */
export function spring(name: SpringName, velocity?: number): WithSpringConfig {
  const t = springTokens[name];
  return {
    duration: t.duration,
    dampingRatio: t.dampingRatio,
    ...(velocity !== undefined ? { velocity } : {}),
    ...(t.overshootClamping ? { overshootClamping: true } : {}),
    reduceMotion: ReduceMotion.System,
  };
}

/** Timing config by duration name and easing name (defaults to ease-out). */
export function timing(duration: DurationName, ease: EasingName = 'out'): WithTimingConfig {
  return { duration: durations[duration], easing: easing[ease], reduceMotion: ReduceMotion.System };
}

/** `withSpring` with a named config: `x.set(settle(0))`. */
export const settle = (to: number, velocity?: number) => withSpring(to, spring('settle', velocity));
export const reveal = (to: number) => withSpring(to, spring('reveal'));
export const snapBack = (to: number, velocity: number) => withSpring(to, spring('snapBack', velocity));
export const sheetSpring = (to: number, velocity: number) => withSpring(to, spring('sheet', velocity));
export const sheetDismiss = (to: number, velocity: number, cb?: (finished?: boolean) => void) =>
  withSpring(to, spring('sheetDismiss', velocity), cb);
export const fade = (to: number, duration: DurationName = 'state') => withTiming(to, timing(duration));

/**
 * Where a flick would come to rest (Apple's exponential-decay projection). Use it to decide
 * between dismiss and snap-back from velocity, not from distance alone.
 */
export function project(velocity: number, decelerationRate = 0.998): number {
  'worklet';
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Resistance past an edge: the further past, the less the element follows. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  'worklet';
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

export { durations, easings, springTokens as springs };

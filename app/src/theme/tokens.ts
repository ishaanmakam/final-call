/**
 * Design tokens for Show Up. Pure data: no React Native imports, so this file is unit-testable
 * (contrast, motion invariants) and is the single source `app/DESIGN.md` documents.
 *
 * Colors are semantic. Code never reaches for a raw hex: it asks for `colors.label`,
 * `colors.tint`, `colors.state.success.fg`, etc. Light and dark are separate palettes with the
 * same keys; every pair listed in `CONTRAST_PAIRS` is verified to WCAG AA by tokens.test.ts.
 */

// ---------- color ----------

export type StateName = 'success' | 'forfeit' | 'unverified' | 'frozen' | 'void' | 'pending' | 'excluded';

export interface StateColor {
  /** text / icon / stroke color for this state */
  fg: string;
  /** soft background a StatusPill sits on */
  soft: string;
}

export interface AvatarColor {
  fg: string;
  bg: string;
}

export interface Palette {
  /** page background (grouped style, slightly tinted) */
  bg: string;
  /** cards, rows, inputs */
  surface: string;
  /** sheets, toasts, anything floating over surface */
  surfaceElevated: string;
  /** control fills on surface (secondary buttons, segmented track) */
  fill: string;
  /** stronger fill (pressed secondary, skeleton base) */
  fillStrong: string;
  /** primary text */
  label: string;
  /** supporting text, placeholders (>= 4.5:1 on bg and surface) */
  secondary: string;
  /** ornaments only: chevrons, separators' big brother (>= 3:1) */
  tertiary: string;
  separator: string;
  /** the one tint: primary actions, links, selection, the check-in ring */
  tint: string;
  /** text on a tint-filled control */
  onTint: string;
  /** tint at rest behind tinted text (selected segment, before-window button) */
  tintSoft: string;
  /** text on a state-filled control (check-in button after a verdict) */
  onState: string;
  state: Record<StateName, StateColor>;
  avatar: readonly AvatarColor[];
  /** sheet / dialog backdrop */
  backdrop: string;
  /** shadow color for the single raised elevation */
  shadow: string;
}

export const light: Palette = {
  bg: '#F5F6F8',
  surface: '#FFFFFF',
  surfaceElevated: '#FFFFFF',
  fill: '#E9ECF1',
  fillStrong: '#DCE0E7',
  label: '#101418',
  secondary: '#5E6773',
  tertiary: '#7E8793',
  separator: '#D9DEE5',
  tint: '#2B4ACB',
  onTint: '#FFFFFF',
  tintSoft: '#E6EAFB',
  onState: '#FFFFFF',
  state: {
    success: { fg: '#187A47', soft: '#DCF4E5' },
    forfeit: { fg: '#B42331', soft: '#FBE3E5' },
    unverified: { fg: '#8A5A00', soft: '#FBEFD0' },
    frozen: { fg: '#2F6E9B', soft: '#DCEDF8' },
    void: { fg: '#5B6472', soft: '#E7EAEF' },
    pending: { fg: '#5B6472', soft: '#EEF0F3' },
    excluded: { fg: '#6A4FA3', soft: '#ECE6F7' },
  },
  avatar: [
    { fg: '#1E4F8F', bg: '#DCE8F7' },
    { fg: '#6B3F9E', bg: '#ECE3F7' },
    { fg: '#9A4A1B', bg: '#FBE6D7' },
    { fg: '#146F6A', bg: '#D7F1EF' },
    { fg: '#8A2E6A', bg: '#F9DEEF' },
    { fg: '#4F5F2A', bg: '#E7EFD3' },
  ],
  backdrop: 'rgba(16, 20, 24, 0.40)',
  shadow: '#101418',
};

export const dark: Palette = {
  bg: '#0C1017',
  surface: '#161C26',
  surfaceElevated: '#1D2432',
  fill: '#1F2632',
  fillStrong: '#2A3240',
  label: '#F3F5F8',
  secondary: '#A6AFBD',
  tertiary: '#7F8896',
  separator: '#2A3240',
  tint: '#8DA2FF',
  onTint: '#0C1017',
  tintSoft: '#1C2545',
  onState: '#0C1017',
  state: {
    success: { fg: '#4FD08B', soft: '#113826' },
    forfeit: { fg: '#FF7B86', soft: '#44191E' },
    unverified: { fg: '#F2B544', soft: '#3C2E0D' },
    frozen: { fg: '#79B8E6', soft: '#15314A' },
    void: { fg: '#A6AFBD', soft: '#262D39' },
    pending: { fg: '#A6AFBD', soft: '#222935' },
    excluded: { fg: '#BFA8F0', soft: '#2C2340' },
  },
  avatar: [
    { fg: '#A9C7F5', bg: '#1B2D47' },
    { fg: '#D2BDF4', bg: '#2D2244' },
    { fg: '#F2B38F', bg: '#44281A' },
    { fg: '#8FDAD4', bg: '#153634' },
    { fg: '#F0A6D8', bg: '#44213A' },
    { fg: '#C8DB9A', bg: '#2C3519' },
  ],
  backdrop: 'rgba(0, 0, 0, 0.55)',
  shadow: '#000000',
};

export const colors = { light, dark } as const;
export type ColorScheme = keyof typeof colors;

export const STATE_NAMES: readonly StateName[] = ['success', 'forfeit', 'unverified', 'frozen', 'void', 'pending', 'excluded'];

/**
 * Every (foreground, background, minimum ratio) pair the UI relies on. tokens.test.ts checks them
 * in both schemes. 4.5 = text, 3 = large text and UI ornaments (WCAG 2.1 AA).
 */
export function contrastPairs(p: Palette): Array<{ name: string; fg: string; bg: string; min: number }> {
  const pairs: Array<{ name: string; fg: string; bg: string; min: number }> = [
    { name: 'label on bg', fg: p.label, bg: p.bg, min: 4.5 },
    { name: 'label on surface', fg: p.label, bg: p.surface, min: 4.5 },
    { name: 'label on surfaceElevated', fg: p.label, bg: p.surfaceElevated, min: 4.5 },
    { name: 'label on fill', fg: p.label, bg: p.fill, min: 4.5 },
    { name: 'secondary on bg', fg: p.secondary, bg: p.bg, min: 4.5 },
    { name: 'secondary on surface', fg: p.secondary, bg: p.surface, min: 4.5 },
    { name: 'secondary on surfaceElevated', fg: p.secondary, bg: p.surfaceElevated, min: 4.5 },
    { name: 'secondary on tintSoft', fg: p.secondary, bg: p.tintSoft, min: 4.5 },
    { name: 'tertiary on bg', fg: p.tertiary, bg: p.bg, min: 3 },
    { name: 'tertiary on surface', fg: p.tertiary, bg: p.surface, min: 3 },
    { name: 'tint on bg', fg: p.tint, bg: p.bg, min: 4.5 },
    { name: 'tint on surface', fg: p.tint, bg: p.surface, min: 4.5 },
    { name: 'tint on tintSoft', fg: p.tint, bg: p.tintSoft, min: 4.5 },
    { name: 'onTint on tint', fg: p.onTint, bg: p.tint, min: 4.5 },
  ];
  for (const name of STATE_NAMES) {
    const s = p.state[name];
    pairs.push({ name: `${name} fg on soft`, fg: s.fg, bg: s.soft, min: 4.5 });
    pairs.push({ name: `${name} fg on bg`, fg: s.fg, bg: p.bg, min: 4.5 });
    pairs.push({ name: `${name} fg on surface`, fg: s.fg, bg: p.surface, min: 4.5 });
    pairs.push({ name: `label on ${name} soft`, fg: p.label, bg: s.soft, min: 4.5 });
  }
  // the check-in button is filled with a state color after a verdict
  for (const name of ['success', 'forfeit', 'unverified'] as const) {
    pairs.push({ name: `onState on ${name} fill`, fg: p.onState, bg: p.state[name].fg, min: 4.5 });
  }
  p.avatar.forEach((a, i) => pairs.push({ name: `avatar ${i} initials`, fg: a.fg, bg: a.bg, min: 4.5 }));
  return pairs;
}

// ---------- type ----------

export type TypeVariant =
  | 'largeTitle'
  | 'title1'
  | 'title2'
  | 'title3'
  | 'headline'
  | 'body'
  | 'callout'
  | 'subheadline'
  | 'footnote'
  | 'caption1'
  | 'caption2';

export interface TypeStyle {
  fontSize: number;
  lineHeight: number;
  /** points, SF Pro's own tracking table for this optical size */
  letterSpacing: number;
  fontWeight: '400' | '500' | '600' | '700';
  /** Dynamic Type ceiling: titles stop earlier so layouts survive accessibility sizes */
  maxFontSizeMultiplier: number;
  /** iOS Dynamic Type ramp this style follows (RN `dynamicTypeRamp`) */
  ramp: TypeVariant;
}

/** SF system font via the iOS Dynamic Type text styles (default "Large" sizes). */
export const type: Record<TypeVariant, TypeStyle> = {
  largeTitle: { fontSize: 34, lineHeight: 41, letterSpacing: 0.37, fontWeight: '700', maxFontSizeMultiplier: 1.3, ramp: 'largeTitle' },
  title1: { fontSize: 28, lineHeight: 34, letterSpacing: 0.36, fontWeight: '700', maxFontSizeMultiplier: 1.4, ramp: 'title1' },
  title2: { fontSize: 22, lineHeight: 28, letterSpacing: 0.35, fontWeight: '700', maxFontSizeMultiplier: 1.5, ramp: 'title2' },
  title3: { fontSize: 20, lineHeight: 25, letterSpacing: 0.38, fontWeight: '600', maxFontSizeMultiplier: 1.5, ramp: 'title3' },
  headline: { fontSize: 17, lineHeight: 22, letterSpacing: -0.41, fontWeight: '600', maxFontSizeMultiplier: 1.8, ramp: 'headline' },
  body: { fontSize: 17, lineHeight: 22, letterSpacing: -0.41, fontWeight: '400', maxFontSizeMultiplier: 2, ramp: 'body' },
  callout: { fontSize: 16, lineHeight: 21, letterSpacing: -0.32, fontWeight: '400', maxFontSizeMultiplier: 2, ramp: 'callout' },
  subheadline: { fontSize: 15, lineHeight: 20, letterSpacing: -0.24, fontWeight: '400', maxFontSizeMultiplier: 2, ramp: 'subheadline' },
  footnote: { fontSize: 13, lineHeight: 18, letterSpacing: -0.08, fontWeight: '400', maxFontSizeMultiplier: 2, ramp: 'footnote' },
  caption1: { fontSize: 12, lineHeight: 16, letterSpacing: 0, fontWeight: '400', maxFontSizeMultiplier: 2, ramp: 'caption1' },
  caption2: { fontSize: 11, lineHeight: 13, letterSpacing: 0.07, fontWeight: '400', maxFontSizeMultiplier: 2, ramp: 'caption2' },
};

// ---------- space & shape ----------

/** 4-pt grid. Names are sizes, not purposes, so a layout reads as numbers. */
export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 40,
  giant: 48,
} as const;

/** Screen gutter (inset-grouped iOS lists use 16). */
export const gutter = 16;

export const radius = {
  xs: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

/** Minimum touch target, points. */
export const TOUCH_TARGET = 44;

/** Blur. Used behind the sheet handle region and toasts only; never as decoration. */
export const materials = {
  /** expo-blur intensity 1..100 */
  intensity: 60,
  /** opaque fallback when blur is unavailable (web, Android low-end): surfaceElevated */
} as const;

// ---------- motion ----------

export type SpringName = 'settle' | 'reveal' | 'snapBack' | 'sheet' | 'sheetDismiss';

export interface SpringToken {
  duration: number;
  dampingRatio: number;
  /** true only for springs that continue a finger's momentum (allowed to bounce) */
  momentum: boolean;
  overshootClamping?: boolean;
}

/** Apple's two designer parameters, passed straight to Reanimated's `withSpring`. */
export const springs: Record<SpringName, SpringToken> = {
  /** default state change with no finger: no overshoot */
  settle: { duration: 400, dampingRatio: 1, momentum: false },
  /** result reveal on the check-in ring: no overshoot, a touch quicker */
  reveal: { duration: 350, dampingRatio: 1, momentum: false },
  /** reposition after a drag release; carries velocity */
  snapBack: { duration: 400, dampingRatio: 0.8, momentum: true },
  /** sheet returning to its detent after a drag; carries velocity */
  sheet: { duration: 300, dampingRatio: 0.8, momentum: true },
  /** sheet leaving the screen: must not spring past the bottom edge */
  sheetDismiss: { duration: 300, dampingRatio: 1, momentum: true, overshootClamping: true },
};

export type EasingName = 'out' | 'inOut' | 'sheet' | 'linear';

/** Cubic bezier control points (x1, y1, x2, y2). Never ease-in on UI. */
export const easings: Record<EasingName, readonly [number, number, number, number]> = {
  out: [0.23, 1, 0.32, 1],
  inOut: [0.77, 0, 0.175, 1],
  sheet: [0.32, 0.72, 0, 1],
  linear: [0, 0, 1, 1],
};

export type DurationName = 'press' | 'state' | 'enter' | 'exit' | 'move' | 'sheet' | 'sweep';

/** ms. UI motion stays under 300 ms; `sweep` is the one continuous loop (locating). */
export const durations: Record<DurationName, number> = {
  press: 120,
  state: 180,
  enter: 250,
  exit: 200,
  move: 250,
  sheet: 300,
  sweep: 1200,
};

export const PRESS_SCALE = 0.97;

// ---------- haptics ----------

export type HapticName =
  | 'pressPrimary'
  | 'selection'
  | 'snap'
  | 'commit'
  | 'success'
  | 'warning'
  | 'error';

export type HapticCall =
  | { kind: 'impact'; style: 'light' | 'medium' | 'heavy' | 'soft' | 'rigid' }
  | { kind: 'selection' }
  | { kind: 'notification'; type: 'success' | 'warning' | 'error' };

/**
 * Which moment gets which haptic. One per user action, same frame as the visual, never the only
 * feedback. Names describe the moment so call sites read as intent.
 */
export const haptics: Record<HapticName, HapticCall> = {
  /** press-in on a primary or destructive button (including the big Check In) */
  pressPrimary: { kind: 'impact', style: 'light' },
  /** a value ticked past a step: segmented control, day chips, time stepper, radius slider detent */
  selection: { kind: 'selection' },
  /** something snapped home: sheet caught its detent, toast dismissed, toggle committed */
  snap: { kind: 'impact', style: 'light' },
  /** a heavy landing or a destructive confirm: leave group, "didn't receive it" */
  commit: { kind: 'impact', style: 'medium' },
  /** verdict in_fence: you showed up */
  success: { kind: 'notification', type: 'success' },
  /** recoverable: out_of_fence, weak GPS, saved offline, no fix (unverified never costs money) */
  warning: { kind: 'notification', type: 'warning' },
  /** rejected_simulated, permission blocked, request refused */
  error: { kind: 'notification', type: 'error' },
};

// ---------- copy ----------

/** UI copy says pledge / forfeit / pool. Code says stake / pot / ledger. */
export const glossary = {
  stake: 'pledge',
  pot: 'pool',
  forfeit: 'forfeit',
  success: 'Showed up',
  failed: 'Missed',
  unverified: 'Unverified',
  frozen: 'Frozen',
  void: "Didn't count",
  excluded: 'Excluded',
  pending: 'Waiting',
  settlement: 'settle-up',
} as const;

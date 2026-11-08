/**
 * Design tokens copied from `app/src/theme/tokens.ts` (the normative source; values, not imports,
 * so the simulator never pulls React Native code). `cssVars` turns a palette into custom properties.
 */

export type StateName = 'success' | 'forfeit' | 'unverified' | 'frozen' | 'void' | 'pending' | 'excluded';

export interface Palette {
  bg: string;
  surface: string;
  surfaceElevated: string;
  fill: string;
  fillStrong: string;
  label: string;
  secondary: string;
  tertiary: string;
  separator: string;
  tint: string;
  onTint: string;
  tintSoft: string;
  onState: string;
  state: Record<StateName, { fg: string; soft: string }>;
  avatar: readonly { fg: string; bg: string }[];
  backdrop: string;
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

export function cssVars(p: Palette): string {
  const lines = [
    `--bg:${p.bg}`,
    `--surface:${p.surface}`,
    `--surface-elevated:${p.surfaceElevated}`,
    `--fill:${p.fill}`,
    `--fill-strong:${p.fillStrong}`,
    `--label:${p.label}`,
    `--secondary:${p.secondary}`,
    `--tertiary:${p.tertiary}`,
    `--separator:${p.separator}`,
    `--tint:${p.tint}`,
    `--on-tint:${p.onTint}`,
    `--tint-soft:${p.tintSoft}`,
    `--on-state:${p.onState}`,
    `--backdrop:${p.backdrop}`,
    `--shadow:${p.shadow}`,
  ];
  for (const [name, s] of Object.entries(p.state)) lines.push(`--${name}:${s.fg}`, `--${name}-soft:${s.soft}`);
  p.avatar.forEach((a, i) => lines.push(`--avatar-${i}-fg:${a.fg}`, `--avatar-${i}-bg:${a.bg}`));
  return lines.join(';');
}

/** Apple's two designer parameters, from `tokens.ts` `springs`; mapped to Motion's duration/bounce. */
export const springs = {
  settle: { duration: 0.4, bounce: 0 },
  reveal: { duration: 0.35, bounce: 0 },
  /** after a drag release only: carries momentum, so it may overshoot */
  snapBack: { duration: 0.4, bounce: 0.2 },
} as const;

export const easings = {
  out: 'cubic-bezier(0.23, 1, 0.32, 1)',
  inOut: 'cubic-bezier(0.77, 0, 0.175, 1)',
  sheet: 'cubic-bezier(0.32, 0.72, 0, 1)',
} as const;

export const durations = { press: 120, state: 180, enter: 250, exit: 200, move: 250, sweep: 1200 } as const;

export const glossary = {
  success: 'Showed up',
  failed: 'Missed',
  unverified: 'Unverified',
  frozen: 'Frozen',
  void: "Didn't count",
  excluded: 'Excluded',
  pending: 'Waiting',
} as const;

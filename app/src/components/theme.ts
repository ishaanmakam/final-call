/**
 * @deprecated Compatibility palette for the phase-1 screens. Use `useTheme()` from `@/theme` for
 * anything new: it follows light/dark live. This object reads the appearance at access time, so
 * `StyleSheet.create` at module load gets the right scheme for the current launch (and for the web
 * screenshot harness), but it will not update if the user flips appearance while the app runs.
 * Phase 2 migrates the screens and deletes this file.
 */
import { Appearance } from 'react-native';
import { colors as palettes, radius as radii, space as spacing, type Palette } from '../theme/tokens';

const current = (): Palette => (Appearance.getColorScheme() === 'dark' ? palettes.dark : palettes.light);

export const colors = {
  get bg() {
    return current().bg;
  },
  get card() {
    return current().surface;
  },
  get text() {
    return current().label;
  },
  get muted() {
    return current().secondary;
  },
  get border() {
    return current().separator;
  },
  get primary() {
    return current().tint;
  },
  get primaryText() {
    return current().onTint;
  },
  get success() {
    return current().state.success.fg;
  },
  get successBg() {
    return current().state.success.soft;
  },
  get danger() {
    return current().state.forfeit.fg;
  },
  get dangerBg() {
    return current().state.forfeit.soft;
  },
  get warn() {
    return current().state.unverified.fg;
  },
  get warnBg() {
    return current().state.unverified.soft;
  },
  get neutralBg() {
    return current().fill;
  },
};

export const space = { xs: spacing.xs, sm: spacing.sm, md: spacing.md, lg: spacing.lg, xl: spacing.xxl };
export const radius = { sm: radii.sm, md: radii.md, lg: radii.xl, pill: radii.pill };

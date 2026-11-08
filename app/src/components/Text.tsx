import { Platform, Text as RNText, StyleSheet, type TextProps as RNTextProps, type TextStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { type as typeScale, type StateName, type TypeVariant } from '../theme/tokens';

export type TextColor = 'label' | 'secondary' | 'tertiary' | 'tint' | 'onTint' | 'onState' | StateName;

export interface TextProps extends RNTextProps {
  variant?: TypeVariant;
  color?: TextColor;
  /** semibold without changing the variant (e.g. a body line that carries a name) */
  emphasis?: boolean;
  /** tabular figures: countdowns, money, anything that changes in place */
  tabular?: boolean;
  align?: TextStyle['textAlign'];
}

export function resolveTextColor(
  colors: ReturnType<typeof useTheme>['colors'],
  color: TextColor,
): string {
  switch (color) {
    case 'label':
    case 'secondary':
    case 'tertiary':
    case 'tint':
    case 'onTint':
    case 'onState':
      return colors[color];
    default:
      return colors.state[color].fg;
  }
}

/**
 * The only text primitive. `variant` maps to an iOS Dynamic Type style (SF system font, its own
 * tracking and leading per size) and caps growth per style so layouts survive accessibility sizes.
 */
export function Text({ variant = 'body', color = 'label', emphasis, tabular, align, style, ...rest }: TextProps) {
  const { colors } = useTheme();
  const t = typeScale[variant];
  return (
    <RNText
      maxFontSizeMultiplier={t.maxFontSizeMultiplier}
      {...(Platform.OS === 'ios' ? { dynamicTypeRamp: t.ramp } : {})}
      {...rest}
      style={[
        styles.base,
        {
          fontSize: t.fontSize,
          lineHeight: t.lineHeight,
          letterSpacing: t.letterSpacing,
          fontWeight: emphasis ? '600' : t.fontWeight,
          color: resolveTextColor(colors, color),
        },
        tabular && styles.tabular,
        align !== undefined && { textAlign: align },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  base: Platform.select({
    web: { fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
    default: {},
  }) as TextStyle,
  tabular: { fontVariant: ['tabular-nums'] },
});

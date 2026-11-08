import { useEffect } from 'react';
import { Platform, StyleSheet, TextInput, type TextInputProps } from 'react-native';
import Animated, { useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated';
import { Text, resolveTextColor, type TextColor } from '../../components';
import { formatCents } from '../../lib/money';
import { easing, useReducedMotion, useTheme } from '../../theme';
import { type as typeScale } from '../../theme/tokens';

Animated.addWhitelistedNativeProps({ text: true });
const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);
type MoneyTextProps = TextInputProps & { text?: string };

/** Same output as lib/money's formatCents, written so it can run on the UI thread each frame. */
function formatCentsWorklet(cents: number, signed: boolean): string {
  'worklet';
  const abs = Math.abs(cents);
  let dollars = String(Math.floor(abs / 100));
  let grouped = '';
  while (dollars.length > 3) {
    grouped = `,${dollars.slice(-3)}${grouped}`;
    dollars = dollars.slice(0, -3);
  }
  const rem = abs % 100;
  const fraction = rem < 10 ? `0${rem}` : String(rem);
  const sign = cents < 0 ? '-' : signed && cents > 0 ? '+' : '';
  return `${sign}$${dollars}${grouped}.${fraction}`;
}

export interface AnimatedHeadlineProps {
  before: string;
  cents: number;
  after: string;
  /** "+$3.34" rather than "$3.34" for a positive amount */
  signed?: boolean;
  color?: TextColor;
  /** count-up length; 350 ms ease-out per the gate-close spec */
  durationMs?: number;
}

export const COUNT_UP_MS = 350;

/**
 * A headline whose money figure counts from $0.00 to its value: the text is driven by a Reanimated
 * shared value through `animatedProps` on a read-only `TextInput`, so no React render happens per
 * frame. The input is laid out once for the final sentence (its `defaultValue`), so the count-up
 * never reflows. Reduced motion and web render a plain `Text` with the final value (opacity only;
 * the card's own entrance covers it). The figure is tabular so digits tick in place.
 */
export function AnimatedHeadline({ before, cents, after, signed = false, color = 'label', durationMs = COUNT_UP_MS }: AnimatedHeadlineProps) {
  const reduced = useReducedMotion();
  const { colors } = useTheme();
  const animate = !reduced && Platform.OS !== 'web';
  const progress = useSharedValue(animate ? 0 : 1);
  const final = `${before}${formatCents(cents, { signed })}${after}`;
  const t = typeScale.headline;

  useEffect(() => {
    if (!animate) return;
    progress.set(0);
    progress.set(withTiming(1, { duration: durationMs, easing: easing.out }));
  }, [animate, cents, durationMs, progress]);

  const animatedProps = useAnimatedProps<MoneyTextProps>(() => ({
    text: `${before}${formatCentsWorklet(Math.round(cents * progress.get()), signed)}${after}`,
  }));

  if (!animate) {
    return (
      <Text variant="headline" color={color} tabular>
        {final}
      </Text>
    );
  }
  return (
    <AnimatedTextInput
      animatedProps={animatedProps}
      defaultValue={final}
      editable={false}
      multiline
      scrollEnabled={false}
      caretHidden
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no"
      underlineColorAndroid="transparent"
      maxFontSizeMultiplier={t.maxFontSizeMultiplier}
      style={[
        styles.input,
        {
          fontSize: t.fontSize,
          lineHeight: t.lineHeight,
          letterSpacing: t.letterSpacing,
          fontWeight: t.fontWeight,
          color: resolveTextColor(colors, color),
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  input: {
    padding: 0,
    margin: 0,
    includeFontPadding: false,
    textAlignVertical: 'top',
    fontVariant: ['tabular-nums'],
    ...Platform.select({ web: { fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif' }, default: {} }),
  },
});

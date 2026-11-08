import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { haptic } from '../theme/haptics';
import { transition } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { PRESS_SCALE, TOUCH_TARGET, durations, radius, space } from '../theme/tokens';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'destructive';

export interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  /** regular = 50pt (the one action on a screen); small = 44pt (rows, pairs) */
  size?: 'regular' | 'small';
  disabled?: boolean;
  loading?: boolean;
  /** leading icon or any node; rendered before the title */
  leading?: ReactNode;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}

/**
 * Press-in scale 0.97 in 120 ms (Reanimated CSS transition, no shared value), haptic on press-in
 * for primary and destructive only, loading keeps the button's width so nothing jumps.
 */
export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'regular',
  disabled,
  loading,
  leading,
  style,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: ButtonProps) {
  const { colors } = useTheme();
  const [pressed, setPressed] = useState(false);
  const inactive = !!disabled || !!loading;

  const palette = {
    primary: { bg: colors.tint, fg: colors.onTint, border: 'transparent' },
    secondary: { bg: colors.fill, fg: colors.label, border: 'transparent' },
    tertiary: { bg: 'transparent', fg: colors.tint, border: 'transparent' },
    destructive: { bg: colors.state.forfeit.fg, fg: colors.onState, border: 'transparent' },
  }[variant];
  const fg = palette.fg;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: !!loading }}
      disabled={inactive}
      hitSlop={size === 'small' ? 6 : 0}
      pressRetentionOffset={16}
      onPress={onPress}
      onPressIn={() => {
        setPressed(true);
        if (variant === 'primary' || variant === 'destructive') haptic('pressPrimary');
      }}
      onPressOut={() => setPressed(false)}
      testID={testID}
      style={style}
    >
      <Animated.View
        style={[
          styles.base,
          pressTransition,
          size === 'small' ? styles.small : styles.regular,
          variant === 'tertiary' && styles.tertiary,
          { backgroundColor: palette.bg, borderColor: palette.border },
          pressed && !inactive && styles.pressed,
          disabled && !loading && styles.disabled,
        ]}
      >
        <View style={[styles.content, loading && styles.hidden]} pointerEvents="none">
          {leading ? <View style={styles.leading}>{leading}</View> : null}
          <Text variant="headline" style={{ color: fg }} numberOfLines={1}>
            {title}
          </Text>
        </View>
        {loading ? (
          <View style={styles.spinner} pointerEvents="none">
            <ActivityIndicator color={fg} />
          </View>
        ) : null}
      </Animated.View>
    </Pressable>
  );
}

const pressTransition = transition('transform', 'press');

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    borderWidth: StyleSheet.hairlineWidth,
    transform: [{ scale: 1 }],
  },
  regular: { minHeight: 50 },
  small: { minHeight: TOUCH_TARGET, paddingHorizontal: space.lg },
  tertiary: { paddingHorizontal: space.md },
  pressed: { transform: [{ scale: PRESS_SCALE }] },
  disabled: { opacity: 0.45 },
  content: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  leading: { marginLeft: -space.xs },
  hidden: { opacity: 0 },
  spinner: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
});

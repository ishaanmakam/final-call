/**
 * Navigation-bar buttons: an SF Symbol with a VoiceOver label, or a text item (Cancel / Create).
 * 44 pt targets, the same 0.97 press as every pressable, tint for anything tappable.
 */
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { Icon, Text, type IconName } from '@/components';
import { PRESS_SCALE, TOUCH_TARGET, space, transition, useTheme } from '@/theme';

const pressTransition = transition('transform', 'press');

export function HeaderIconButton({
  icon,
  label,
  hint,
  onPress,
  testID,
}: {
  icon: IconName;
  /** VoiceOver name; the icon alone never carries meaning */
  label: string;
  hint?: string;
  onPress: () => void;
  testID?: string;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      hitSlop={6}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      testID={testID}
    >
      <Animated.View style={[styles.icon, pressTransition, pressed && styles.pressed]}>
        <Icon name={icon} size={22} color="tint" />
      </Animated.View>
    </Pressable>
  );
}

export function HeaderTextButton({
  title,
  onPress,
  emphasis,
  disabled,
  loading,
}: {
  title: string;
  onPress: () => void;
  /** the screen's commit action (Create, Join, Done) reads bold, like iOS */
  emphasis?: boolean;
  disabled?: boolean;
  loading?: boolean;
}) {
  const { colors } = useTheme();
  const [pressed, setPressed] = useState(false);
  const inactive = !!disabled || !!loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: inactive, busy: !!loading }}
      disabled={inactive}
      hitSlop={6}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
    >
      <Animated.View style={[styles.text, pressTransition, pressed && styles.pressed, disabled && !loading && styles.disabled]}>
        {loading ? (
          <ActivityIndicator color={colors.tint} />
        ) : (
          <Text variant="body" color="tint" emphasis={emphasis} numberOfLines={1}>
            {title}
          </Text>
        )}
      </Animated.View>
    </Pressable>
  );
}

/** Lays out one or more header items; the web header has no inner margin of its own. */
export function HeaderItems({ children, side = 'right' }: { children: ReactNode; side?: 'left' | 'right' }) {
  return <View style={[styles.items, Platform.OS === 'web' && (side === 'right' ? styles.webRight : styles.webLeft)]}>{children}</View>;
}

const styles = StyleSheet.create({
  icon: { width: TOUCH_TARGET, height: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center', transform: [{ scale: 1 }] },
  text: { minHeight: TOUCH_TARGET, paddingHorizontal: space.xs, justifyContent: 'center', transform: [{ scale: 1 }] },
  pressed: { transform: [{ scale: PRESS_SCALE }], opacity: 0.7 },
  disabled: { opacity: 0.45 },
  items: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  webRight: { paddingRight: space.md },
  webLeft: { paddingLeft: space.md },
});

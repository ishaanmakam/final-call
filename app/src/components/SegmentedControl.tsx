import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { haptic } from '../theme/haptics';
import { timing } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { TOUCH_TARGET, radius, space } from '../theme/tokens';
import { Text } from './Text';

export interface SegmentedControlProps {
  segments: readonly string[];
  index: number;
  onChange: (index: number) => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * iOS-style segmented control. The indicator is an absolutely positioned childless pill, so
 * animating its translateX and width re-lays-out nothing else. Selection haptic fires on the
 * press, not when the pill lands.
 */
export function SegmentedControl({ segments, index, onChange, accessibilityLabel, style }: SegmentedControlProps) {
  const { colors } = useTheme();
  const [layouts, setLayouts] = useState<Record<number, { x: number; width: number }>>({});
  const x = useSharedValue(0);
  const w = useSharedValue(0);
  const ready = useSharedValue(0);

  useEffect(() => {
    const l = layouts[index];
    if (!l) return;
    if (ready.get() === 0) {
      x.set(l.x);
      w.set(l.width);
      ready.set(1);
      return;
    }
    x.set(withTiming(l.x, timing('move', 'inOut')));
    w.set(withTiming(l.width, timing('move', 'inOut')));
  }, [index, layouts, x, w, ready]);

  const pill = useAnimatedStyle(() => ({
    opacity: ready.get(),
    width: w.get(),
    transform: [{ translateX: x.get() }],
  }));

  const onLayout = (i: number) => (e: LayoutChangeEvent) => {
    const { x: lx, width } = e.nativeEvent.layout;
    setLayouts((cur) => (cur[i]?.x === lx && cur[i]?.width === width ? cur : { ...cur, [i]: { x: lx, width } }));
  };

  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      style={[styles.track, { backgroundColor: colors.fill }, style]}
    >
      <Animated.View
        pointerEvents="none"
        style={[styles.pill, { backgroundColor: colors.surfaceElevated, shadowColor: colors.shadow }, pill]}
      />
      {segments.map((label, i) => {
        const selected = i === index;
        return (
          <Pressable
            key={label}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={label}
            onLayout={onLayout(i)}
            onPress={() => {
              if (selected) return;
              haptic('selection');
              onChange(i);
            }}
            style={styles.segment}
          >
            <Text variant="subheadline" emphasis={selected} color={selected ? 'label' : 'secondary'} numberOfLines={1}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const PAD = 2;

const styles = StyleSheet.create({
  track: { flexDirection: 'row', borderRadius: radius.sm + PAD, padding: PAD, minHeight: TOUCH_TARGET - 8 },
  segment: { flex: 1, minHeight: TOUCH_TARGET - 8 - PAD * 2, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.sm },
  pill: {
    position: 'absolute',
    top: PAD,
    bottom: PAD,
    left: 0,
    borderRadius: radius.sm,
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
});

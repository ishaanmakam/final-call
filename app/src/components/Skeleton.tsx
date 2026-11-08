import { useEffect } from 'react';
import { StyleSheet, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { easing } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { radius as radii } from '../theme/tokens';

export interface SkeletonProps {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

const PERIOD = 900;

/**
 * Loading placeholder. Shimmer is opacity only (no gradient, no translate), so it costs nothing
 * and reads as "not yet" rather than "broken". Reduced motion: static at the mid opacity.
 */
export function Skeleton({ width = '100%', height = 16, radius = radii.sm, style }: SkeletonProps) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const opacity = useSharedValue(reduced ? 0.7 : 1);

  useEffect(() => {
    if (reduced) {
      opacity.set(0.7);
      return;
    }
    opacity.set(
      withRepeat(
        withSequence(
          withTiming(0.45, { duration: PERIOD, easing: easing.inOut }),
          withTiming(1, { duration: PERIOD, easing: easing.inOut }),
        ),
        -1,
        false,
      ),
    );
    return () => cancelAnimation(opacity);
  }, [opacity, reduced]);

  const animated = useAnimatedStyle(() => ({ opacity: opacity.get() }));

  return (
    <Animated.View
      accessible
      accessibilityLabel="Loading"
      accessibilityState={{ busy: true }}
      style={[styles.base, { width, height, borderRadius: radius, backgroundColor: colors.fillStrong }, animated, style]}
    />
  );
}

/** Three lines in the shape of a card's text, for list placeholders. */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  const { colors } = useTheme();
  return (
    <Animated.View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
      <Skeleton width="55%" height={18} />
      {Array.from({ length: Math.max(0, lines - 1) }, (_, i) => (
        <Skeleton key={i} width={i === lines - 2 ? '40%' : '85%'} height={14} />
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {},
  card: { borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 10 },
});

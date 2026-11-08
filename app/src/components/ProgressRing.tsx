import { useEffect, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { easing, spring } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { durations } from '../theme/tokens';
import type { TextColor } from './Text';
import { resolveTextColor } from './Text';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export interface ProgressRingProps {
  /** 0..1 of the ring drawn, clockwise from 12 o'clock */
  progress: number;
  size?: number;
  strokeWidth?: number;
  color?: TextColor;
  /** when true, a quarter arc sweeps instead of showing progress (GPS locating) */
  indeterminate?: boolean;
  /** `reveal` animates to the new value with the reveal spring; `step` jumps (a ticking clock) */
  animate?: 'reveal' | 'step';
  children?: ReactNode;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Stroke-animated ring (react-native-svg + useAnimatedProps, so the dash offset moves on the UI
 * thread). Reduced motion: progress snaps, and the indeterminate sweep becomes an opacity pulse.
 */
export function ProgressRing({
  progress,
  size = 240,
  strokeWidth = 6,
  color = 'tint',
  indeterminate = false,
  animate = 'reveal',
  children,
  accessibilityLabel,
  style,
}: ProgressRingProps) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(1, Math.max(0, progress));
  const value = useSharedValue(clamped);
  const rotation = useSharedValue(0);
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (animate === 'step' || reduced) value.set(clamped);
    else value.set(withSpring(clamped, spring('reveal')));
  }, [clamped, animate, reduced, value]);

  useEffect(() => {
    if (!indeterminate) {
      cancelAnimation(rotation);
      cancelAnimation(pulse);
      rotation.set(0);
      pulse.set(1);
      return;
    }
    if (reduced) {
      pulse.set(
        withRepeat(
          withSequence(
            withTiming(0.35, { duration: durations.sweep / 2, easing: easing.inOut }),
            withTiming(1, { duration: durations.sweep / 2, easing: easing.inOut }),
          ),
          -1,
          false,
        ),
      );
    } else {
      rotation.set(withRepeat(withTiming(360, { duration: durations.sweep, easing: easing.linear }), -1, false));
    }
    return () => {
      cancelAnimation(rotation);
      cancelAnimation(pulse);
    };
  }, [indeterminate, reduced, rotation, pulse]);

  const arc = useAnimatedProps(() => ({
    strokeDashoffset: c * (1 - (indeterminate ? 0.25 : value.get())),
  }));
  const spin = useAnimatedStyle(() => ({
    opacity: pulse.get(),
    transform: [{ rotate: `${rotation.get()}deg` }],
  }));

  const stroke = resolveTextColor(colors, color);

  return (
    <View
      accessible={!!accessibilityLabel}
      accessibilityRole={accessibilityLabel ? 'progressbar' : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={indeterminate ? undefined : { min: 0, max: 100, now: Math.round(clamped * 100) }}
      style={[{ width: size, height: size }, styles.center, style]}
    >
      <Animated.View style={[StyleSheet.absoluteFill, spin]}>
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.fillStrong} strokeWidth={strokeWidth} fill="none" />
          <AnimatedCircle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={stroke}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${c} ${c}`}
            animatedProps={arc}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </Svg>
      </Animated.View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});

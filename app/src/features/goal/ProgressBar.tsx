import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { resolveTextColor, type TextColor } from '../../components/Text';
import { transition, useTheme } from '../../theme';

export interface ProgressBarProps {
  /** 0..1 */
  fraction: number;
  color?: TextColor;
  width?: number;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * A thin track (fill-strong) with a tinted fill: the standings row's version of the ProgressRing.
 * The fill scales on the x axis from its left edge (transform only, per the motion contract),
 * 180 ms on the state curve when a value changes.
 */
export function ProgressBar({ fraction, color = 'tint', width = 72, accessibilityLabel, style }: ProgressBarProps) {
  const { colors } = useTheme();
  const clamped = Math.min(1, Math.max(0, fraction));
  return (
    <View
      accessible={!!accessibilityLabel}
      accessibilityRole={accessibilityLabel ? 'progressbar' : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      style={[styles.track, { width, backgroundColor: colors.fillStrong }, style]}
    >
      <Animated.View
        style={[styles.fill, fillTransition, { backgroundColor: resolveTextColor(colors, color), transform: [{ scaleX: Math.max(0.001, clamped) }] }]}
      />
    </View>
  );
}

const fillTransition = transition('transform', 'state');

const styles = StyleSheet.create({
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderRadius: 2, transformOrigin: 'left' },
});

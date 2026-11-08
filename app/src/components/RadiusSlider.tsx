import { useEffect, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedReaction, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { haptic } from '../theme/haptics';
import { useTheme } from '../theme/ThemeProvider';
import { TOUCH_TARGET, radius, space } from '../theme/tokens';
import { Button } from './Button';
import { Text } from './Text';

interface Props {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

const THUMB = 28;

const clamp = (v: number, lo: number, hi: number) => {
  'worklet';
  return Math.min(hi, Math.max(lo, v));
};

/**
 * Radius slider on gesture-handler + Reanimated: the thumb and fill follow the finger on the UI
 * thread; React hears about the value only when it crosses a step (never per frame). Keyboard and
 * VoiceOver users get the +/- buttons and the adjustable actions.
 */
export function RadiusSlider({ value, onChange, min = 25, max = 500, step = 5 }: Props) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const ratio = useSharedValue((clamp(value, min, max) - min) / (max - min));
  const startRatio = useSharedValue(0);
  const dragging = useSharedValue(false);
  const trackWidth = useSharedValue(0);
  const stepped = useSharedValue(value);

  // outside changes (buttons, initial load) move the thumb when the finger is not on it
  useEffect(() => {
    if (!dragging.get()) {
      ratio.set((clamp(value, min, max) - min) / (max - min));
      stepped.set(value);
    }
  }, [value, min, max, ratio, dragging, stepped]);

  useAnimatedReaction(
    () => {
      const raw = min + ratio.get() * (max - min);
      return clamp(Math.round(raw / step) * step, min, max);
    },
    (next, prev) => {
      if (prev !== null && next !== prev && dragging.get()) {
        stepped.set(next);
        scheduleOnRN(onChange, next);
        if (next % 25 === 0) scheduleOnRN(haptic, 'selection');
      }
    },
    [min, max, step, onChange],
  );

  const pan = usePanGesture({
    activeOffsetX: [-4, 4],
    onBegin: (e) => {
      'worklet';
      const w = trackWidth.get();
      if (w > 0) ratio.set(clamp(e.x / w, 0, 1));
    },
    onActivate: () => {
      'worklet';
      dragging.set(true);
      startRatio.set(ratio.get());
    },
    onUpdate: (e) => {
      'worklet';
      const w = trackWidth.get();
      if (w > 0) ratio.set(clamp(startRatio.get() + e.translationX / w, 0, 1));
    },
    onFinalize: () => {
      'worklet';
      dragging.set(false);
      // snap the thumb to the committed step
      ratio.set((stepped.get() - min) / (max - min));
    },
  });

  const fillStyle = useAnimatedStyle(() => ({ width: `${ratio.get() * 100}%` }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: Math.max(0, ratio.get() * trackWidth.get() - THUMB / 2) }, { scale: dragging.get() ? 1.1 : 1 }],
  }));

  const onLayout = (e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
    trackWidth.set(e.nativeEvent.layout.width);
  };

  const bump = (delta: number) => onChange(Math.min(max, Math.max(min, value + delta)));

  return (
    <View style={styles.wrap}>
      <Text variant="headline" tabular>
        {value} m radius
      </Text>
      <GestureDetector gesture={pan}>
        <View
          onLayout={onLayout}
          style={styles.hit}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Place radius"
          accessibilityValue={{ min, max, now: value, text: `${value} meters` }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => bump(e.nativeEvent.actionName === 'increment' ? 25 : -25)}
        >
          <View pointerEvents="none" style={[styles.track, { backgroundColor: colors.fillStrong }]}>
            <Animated.View style={[styles.fill, { backgroundColor: colors.tint }, fillStyle]} />
          </View>
          <Animated.View
            pointerEvents="none"
            style={[styles.thumb, { backgroundColor: colors.surfaceElevated, borderColor: colors.tint, shadowColor: colors.shadow }, width === 0 && styles.hidden, thumbStyle]}
          />
        </View>
      </GestureDetector>
      <View style={styles.buttons}>
        <Button title={`-${step * 5}`} variant="secondary" size="small" onPress={() => bump(-step * 5)} accessibilityLabel={`Shrink by ${step * 5} meters`} />
        <Text variant="footnote" color="secondary">
          {min}–{max} m
        </Text>
        <Button title={`+${step * 5}`} variant="secondary" size="small" onPress={() => bump(step * 5)} accessibilityLabel={`Grow by ${step * 5} meters`} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  hit: { height: TOUCH_TARGET, justifyContent: 'center' },
  track: { height: 6, borderRadius: radius.pill, overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  thumb: {
    position: 'absolute',
    left: 0,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    borderWidth: 2,
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  hidden: { opacity: 0 },
  buttons: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});

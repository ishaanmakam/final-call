import { useEffect, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { RADIUS_DETENTS, RADIUS_MAX, RADIUS_MIN, RADIUS_STEP, radiusLine } from '../features/place/radius';
import { haptic } from '../theme/haptics';
import { timing } from '../theme/motion';
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
  /** metres per −/+ button tap and per VoiceOver increment */
  nudge?: number;
}

const THUMB = 28;
const TRACK = 6;

const clamp = (v: number, lo: number, hi: number) => {
  'worklet';
  return Math.min(hi, Math.max(lo, v));
};

const DETENT_SET = new Set(RADIUS_DETENTS);
const isDetent = (m: number) => DETENT_SET.has(m);

/**
 * Radius slider on gesture-handler + Reanimated. The thumb and fill follow the finger on the UI
 * thread; React hears about the value only when it crosses a 5 m step, never per frame. A
 * selection tick fires at the detents (25, 50, 75, 100, 150, 200, 300, 500 m). The whole 44 pt
 * strip is the hit area; VoiceOver gets an adjustable control plus the −/+ buttons.
 */
export function RadiusSlider({ value, onChange, min = RADIUS_MIN, max = RADIUS_MAX, step = RADIUS_STEP, nudge = 25 }: Props) {
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
        if (isDetent(next)) scheduleOnRN(haptic, 'selection');
      }
    },
    [min, max, step, onChange],
  );

  const pan = usePanGesture({
    activeOffsetX: [-4, 4],
    onBegin: (e) => {
      'worklet';
      const w = trackWidth.get() - THUMB;
      if (w > 0) ratio.set(clamp((e.x - THUMB / 2) / w, 0, 1));
    },
    onActivate: () => {
      'worklet';
      dragging.set(true);
      startRatio.set(ratio.get());
    },
    onUpdate: (e) => {
      'worklet';
      const w = trackWidth.get() - THUMB;
      if (w > 0) ratio.set(clamp(startRatio.get() + e.translationX / w, 0, 1));
    },
    onFinalize: () => {
      'worklet';
      dragging.set(false);
      // settle the thumb on the committed step (a few points at most: a short ease, not a jump)
      ratio.set(withTiming((stepped.get() - min) / (max - min), timing('press')));
    },
  });

  const fillStyle = useAnimatedStyle(() => ({ width: `${ratio.get() * 100}%` }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: ratio.get() * Math.max(0, trackWidth.get() - THUMB) },
      // press feedback on the thumb: grows under the finger over 120 ms, shrinks back on release
      { scale: withTiming(dragging.get() ? 1.1 : 1, timing('press')) },
    ],
  }));

  const onLayout = (e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
    trackWidth.set(e.nativeEvent.layout.width);
  };

  const bump = (delta: number) => {
    const next = Math.min(max, Math.max(min, value + delta));
    if (next === value) return;
    haptic('selection');
    onChange(next);
  };

  return (
    <View style={styles.wrap}>
      <Text variant="headline" tabular accessibilityLiveRegion="polite">
        {radiusLine(value)}
      </Text>
      <GestureDetector gesture={pan}>
        <View
          onLayout={onLayout}
          style={styles.hit}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Circle size"
          accessibilityValue={{ min, max, now: value, text: radiusLine(value) }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => bump(e.nativeEvent.actionName === 'increment' ? nudge : -nudge)}
        >
          <View pointerEvents="none" style={[styles.track, { backgroundColor: colors.fillStrong }]}>
            <Animated.View style={[styles.fill, { backgroundColor: colors.tint }, fillStyle]} />
          </View>
          {width > 0
            ? RADIUS_DETENTS.filter((d) => d > min && d < max).map((d) => (
                <View
                  key={d}
                  pointerEvents="none"
                  style={[
                    styles.tick,
                    { left: THUMB / 2 + ((d - min) / (max - min)) * (width - THUMB) - 1, backgroundColor: colors.tertiary },
                  ]}
                />
              ))
            : null}
          <Animated.View
            pointerEvents="none"
            style={[
              styles.thumb,
              { backgroundColor: colors.surfaceElevated, borderColor: colors.tint, shadowColor: colors.shadow },
              width === 0 && styles.hidden,
              thumbStyle,
            ]}
          />
        </View>
      </GestureDetector>
      <View style={styles.buttons}>
        <Button title={`−${nudge} m`} variant="secondary" size="small" onPress={() => bump(-nudge)} accessibilityLabel={`Shrink circle by ${nudge} metres`} />
        <Text variant="footnote" color="secondary" tabular>
          {min}–{max} m
        </Text>
        <Button title={`+${nudge} m`} variant="secondary" size="small" onPress={() => bump(nudge)} accessibilityLabel={`Grow circle by ${nudge} metres`} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  hit: { height: TOUCH_TARGET, justifyContent: 'center' },
  track: { height: TRACK, borderRadius: radius.pill, overflow: 'hidden', marginHorizontal: THUMB / 2 },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  tick: { position: 'absolute', top: TOUCH_TARGET / 2 + TRACK + 2, width: 2, height: 4, borderRadius: 1, opacity: 0.6 },
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

import { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { colors, radius, space } from './theme';
import { Button } from './ui';

interface Props {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Pure-JS slider (PanResponder) so the dev build needs no extra native module.
 * Also exposes increment/decrement accessibility actions and +/- buttons.
 */
export function RadiusSlider({ value, onChange, min = 25, max = 500, step = 5 }: Props) {
  const [width, setWidth] = useState(0);
  const startX = useRef(0);
  const latest = useRef({ width, onChange, min, max, step });
  latest.current = { width, onChange, min, max, step };

  const valueFromX = (x: number): number => {
    const { width: w, min: lo, max: hi, step: st } = latest.current;
    if (w <= 0) return lo;
    const ratio = clamp(x / w, 0, 1);
    return clamp(Math.round((lo + ratio * (hi - lo)) / st) * st, lo, hi);
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        // children are pointerEvents="none", so locationX is relative to the track itself
        onPanResponderGrant: (evt) => {
          startX.current = evt.nativeEvent.locationX;
          latest.current.onChange(valueFromX(startX.current));
        },
        onPanResponderMove: (_evt, gesture) => latest.current.onChange(valueFromX(startX.current + gesture.dx)),
      }),
    [],
  );

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const ratio = (clamp(value, min, max) - min) / (max - min);
  const bump = (delta: number) => onChange(clamp(value + delta, min, max));

  return (
    <View style={styles.wrap}>
      <Text style={styles.value}>{value} m radius</Text>
      <View
        onLayout={onLayout}
        style={styles.hit}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Place radius"
        accessibilityValue={{ min, max, now: value, text: `${value} meters` }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => bump(e.nativeEvent.actionName === 'increment' ? 25 : -25)}
        {...responder.panHandlers}
      >
        <View pointerEvents="none" style={styles.track}>
          <View style={[styles.fill, { width: `${ratio * 100}%` }]} />
        </View>
        <View pointerEvents="none" style={[styles.thumb, { left: Math.max(0, ratio * width - 14) }]} />
      </View>
      <View style={styles.buttons}>
        <Button title={`-${step * 5}`} variant="secondary" onPress={() => bump(-step * 5)} style={styles.small} />
        <Text style={styles.range}>
          {min}–{max} m
        </Text>
        <Button title={`+${step * 5}`} variant="secondary" onPress={() => bump(step * 5)} style={styles.small} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  value: { fontSize: 16, fontWeight: '600', color: colors.text },
  hit: { height: 40, justifyContent: 'center' },
  track: { height: 6, borderRadius: radius.pill, backgroundColor: colors.border, overflow: 'hidden' },
  fill: { height: 6, backgroundColor: colors.primary },
  thumb: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.card,
    borderWidth: 2,
    borderColor: colors.primary,
    top: 6,
  },
  buttons: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  small: { minHeight: 36, paddingHorizontal: space.md },
  range: { color: colors.muted, fontSize: 12 },
});

import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { Countdown, Icon, ProgressRing, Text } from '../../components';
import { msUntil } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { PRESS_SCALE, haptic, transition, useReducedMotion, useTheme } from '../../theme';
import { buttonEnabled, buttonLabel, type ButtonState } from './copy';

export const BUTTON_SIZE = 240;
const RING_STROKE = 6;
const RING_GAP = 8;
export const RING_SIZE = BUTTON_SIZE + 2 * (RING_GAP + RING_STROKE);

export type RingTone = 'tint' | 'success' | 'unverified' | 'forfeit';

export interface CheckinButtonProps {
  state: ButtonState;
  /** the ring's stroke after a verdict; the clock draws in the tint */
  ringTone: RingTone;
  windowOpenAt: string;
  deadlineAt: string;
  onPress: () => void;
  accessibilityHint?: string;
}

/**
 * The ring around the button is the window's clock: full at open, draining to the deadline, redrawn
 * each second with no interpolation. Locating turns it into the indeterminate sweep (reduced
 * motion: an opacity pulse); a verdict recolors it and in_fence fills it with the reveal spring.
 * Only this subtree re-renders per second.
 */
function WindowRing({ state, tone, windowOpenAt, deadlineAt }: { state: ButtonState; tone: RingTone; windowOpenAt: string; deadlineAt: string }) {
  const now = useNow(1000);
  const total = Math.max(1, Date.parse(deadlineAt) - Date.parse(windowOpenAt));
  const remaining = msUntil(deadlineAt, now);
  const busy = state === 'locating' || state === 'sending';
  const empty = state === 'before' || state === 'closed' || state === 'frozen';
  const progress = state === 'done' ? 1 : empty ? 0 : Math.min(1, Math.max(0, remaining / total));
  const urgent = state === 'idle' && remaining > 0 && remaining <= 60_000;
  const color = state === 'done' ? 'success' : urgent && tone === 'tint' ? 'forfeit' : tone;
  return (
    <ProgressRing
      size={RING_SIZE}
      strokeWidth={RING_STROKE}
      progress={progress}
      color={color}
      indeterminate={busy}
      animate={state === 'done' ? 'reveal' : 'step'}
    />
  );
}

/** "Opens in" over the time to the open, inside the neutral pre-window button. */
function BeforeLabel({ windowOpenAt, color }: { windowOpenAt: string; color: string }) {
  const now = useNow(1000);
  return (
    <View style={styles.label}>
      <Text variant="headline" style={{ color }}>
        {buttonLabel.before}
      </Text>
      <Countdown ms={msUntil(windowOpenAt, now)} variant="title2" urgentColor={false} suffix="until it opens" style={{ color }} />
    </View>
  );
}

export function CheckinButton({ state, ringTone, windowOpenAt, deadlineAt, onPress, accessibilityHint }: CheckinButtonProps) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const [pressed, setPressed] = useState(false);
  const enabled = buttonEnabled(state);
  const busy = state === 'locating' || state === 'sending';

  const fill =
    state === 'done'
      ? { bg: colors.state.success.fg, fg: colors.onState }
      : state === 'idle' || busy
        ? { bg: colors.tint, fg: colors.onTint }
        : { bg: colors.fill, fg: colors.secondary };

  const a11yLabel = state === 'before' ? 'Check-in opens later' : state === 'done' ? "You're in. Check in again" : buttonLabel[state];

  return (
    <View style={styles.wrap}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <WindowRing state={state} tone={ringTone} windowOpenAt={windowOpenAt} deadlineAt={deadlineAt} />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        accessibilityHint={enabled ? accessibilityHint : undefined}
        accessibilityState={{ disabled: !enabled, busy }}
        disabled={!enabled}
        pressRetentionOffset={20}
        onPress={onPress}
        onPressIn={() => {
          setPressed(true);
          haptic('pressPrimary');
        }}
        onPressOut={() => setPressed(false)}
        style={styles.press}
      >
        <Animated.View
          style={[
            styles.fill,
            pressTransition,
            pressed && !reduced && styles.pressed,
            pressed && reduced && styles.pressedReduced,
          ]}
        >
          <Animated.View style={[styles.fill, styles.circle, fillTransition, { backgroundColor: fill.bg }]}>
            {state === 'before' ? (
              <BeforeLabel windowOpenAt={windowOpenAt} color={fill.fg} />
            ) : state === 'done' ? (
              <View style={styles.doneRow}>
                <Icon name="checkmark" size={26} color="onState" />
                <Text variant="title2" style={{ color: fill.fg }}>
                  {buttonLabel.done}
                </Text>
              </View>
            ) : (
              <Text variant="title2" style={{ color: fill.fg }}>
                {buttonLabel[state]}
              </Text>
            )}
          </Animated.View>
        </Animated.View>
      </Pressable>
    </View>
  );
}

const pressTransition = transition('transform', 'press');
const fillTransition = transition('backgroundColor', 'state');

const styles = StyleSheet.create({
  wrap: { width: RING_SIZE, height: RING_SIZE, alignSelf: 'center', alignItems: 'center', justifyContent: 'center' },
  press: { width: BUTTON_SIZE, height: BUTTON_SIZE, borderRadius: BUTTON_SIZE / 2 },
  fill: { width: BUTTON_SIZE, height: BUTTON_SIZE, alignItems: 'center', justifyContent: 'center', transform: [{ scale: 1 }] },
  circle: { borderRadius: BUTTON_SIZE / 2 },
  pressed: { transform: [{ scale: PRESS_SCALE }] },
  pressedReduced: { opacity: 0.85 },
  label: { alignItems: 'center' },
  doneRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { haptic } from '../theme/haptics';
import { project, spring, timing } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { gutter, radius, space, type StateName } from '../theme/tokens';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export interface ToastOptions {
  message: string;
  /** colors the leading icon; the surface stays neutral so the toast never shouts */
  tone?: StateName | 'neutral';
  icon?: IconName;
  /** ms before auto-dismiss (default 3500) */
  duration?: number;
  /** tapping the toast runs this and dismisses it (e.g. open the day a notice is about) */
  onPress?: () => void;
}

interface ToastApi {
  show: (toast: ToastOptions) => void;
  hide: () => void;
}

const ToastContext = createContext<ToastApi>({ show: () => undefined, hide: () => undefined });

export const useToast = (): ToastApi => useContext(ToastContext);

const HIDDEN_Y = -120;

/**
 * One toast at a time, at the top, under the status bar. A new toast replaces the current one.
 * Enters and exits along the same path (down in, up out), exit faster than entry; swipe up to
 * dismiss with velocity OR distance; reduced motion fades in place.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<(ToastOptions & { id: number }) | null>(null);
  const counter = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    setCurrent(null);
  }, []);

  const show = useCallback(
    (toast: ToastOptions) => {
      if (timer.current) clearTimeout(timer.current);
      counter.current += 1;
      setCurrent({ ...toast, id: counter.current });
      timer.current = setTimeout(() => setCurrent(null), toast.duration ?? 3500);
    },
    [],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const api = useMemo(() => ({ show, hide }), [show, hide]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastHost toast={current} onDismiss={hide} />
    </ToastContext.Provider>
  );
}

function ToastHost({ toast, onDismiss }: { toast: (ToastOptions & { id: number }) | null; onDismiss: () => void }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [shown, setShown] = useState<(ToastOptions & { id: number }) | null>(toast);
  const y = useSharedValue(HIDDEN_Y);
  const opacity = useSharedValue(0);
  const start = useSharedValue(0);

  useEffect(() => {
    if (toast) {
      setShown(toast);
      if (reduced) {
        y.set(0);
        opacity.set(withTiming(1, timing('enter')));
      } else {
        opacity.set(withTiming(1, timing('enter')));
        y.set(withSpring(0, spring('settle')));
      }
      return;
    }
    if (!shown) return;
    const unmount = () => setShown(null);
    opacity.set(withTiming(0, timing('exit'), (f) => f && scheduleOnRN(unmount)));
    if (!reduced) y.set(withTiming(HIDDEN_Y, timing('exit')));
  }, [toast, reduced, y, opacity, shown]);

  const pan = usePanGesture({
    activeOffsetY: [-6, 6],
    onActivate: () => {
      'worklet';
      start.set(y.get());
    },
    onUpdate: (e) => {
      'worklet';
      const next = start.get() + e.translationY;
      // upward is free; downward resists
      y.set(next <= 0 ? next : next * 0.2);
    },
    onDeactivate: (e) => {
      'worklet';
      const projected = y.get() + project(e.velocityY);
      if (projected < -40 || e.velocityY < -500) {
        opacity.set(withTiming(0, timing('exit')));
        y.set(withSpring(HIDDEN_Y, spring('sheetDismiss', e.velocityY), (f) => f && scheduleOnRN(onDismiss)));
        scheduleOnRN(haptic, 'snap');
      } else {
        y.set(withSpring(0, spring('snapBack', e.velocityY)));
      }
    },
  });

  const style = useAnimatedStyle(() => ({ opacity: opacity.get(), transform: [{ translateY: y.get() }] }));

  if (!shown) return null;
  const tone = shown.tone ?? 'neutral';
  const iconColor = tone === 'neutral' ? 'secondary' : tone;

  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, styles.host]}>
      <GestureDetector gesture={pan}>
        <Animated.View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          accessibilityLabel={shown.message}
          style={[
            styles.toast,
            { top: insets.top + space.sm, backgroundColor: colors.surfaceElevated, shadowColor: colors.shadow, borderColor: colors.separator },
            style,
          ]}
        >
          <Pressable
            disabled={!shown.onPress}
            accessibilityRole={shown.onPress ? 'button' : undefined}
            accessibilityHint={shown.onPress ? 'Opens the day this is about' : undefined}
            onPress={() => {
              shown.onPress?.();
              onDismiss();
            }}
            style={styles.body}
          >
            {shown.icon ? <Icon name={shown.icon} size={18} color={iconColor} /> : null}
            <Text variant="subheadline" emphasis style={styles.message} numberOfLines={4}>
              {shown.message}
            </Text>
          </Pressable>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { alignItems: 'center' },
  toast: {
    position: 'absolute',
    left: gutter,
    right: gutter,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0.18,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  body: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.lg,
  },
  message: { flex: 1 },
});

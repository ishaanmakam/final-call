import { useEffect, useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { haptic } from '../theme/haptics';
import { project, rubberband, spring, timing } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { radius, space } from '../theme/tokens';
import { Text } from './Text';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** VoiceOver name when there is no visible title */
  accessibilityLabel?: string;
}

/**
 * In-screen bottom sheet you can drag to dismiss. (A sheet that is its own route should use
 * `presentation: 'formSheet'` instead and get the platform's real sheet.) Opens on the iOS sheet
 * curve (300 ms timing: no finger, so no bounce); pan on shared values, rubber-band past the top,
 * dismiss on projected distance OR velocity, the finger's velocity handed to the spring, Light
 * haptic when it snaps back home, backdrop derived from the same value.
 */
export function Sheet({ open, onClose, title, children, accessibilityLabel }: SheetProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: screenH } = useWindowDimensions();
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  const height = useSharedValue(screenH);
  const y = useSharedValue(screenH);
  const start = useSharedValue(0);
  const fadeIn = useSharedValue(0);
  // the entrance runs once per open; later layout passes (keyboard, content) must not re-fire it
  const entered = useSharedValue(false);

  // mount, then slide in once the sheet knows its height; reduced motion crossfades in place
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    entered.set(false);
    const finish = () => setMounted(false);
    if (reduced) {
      fadeIn.set(withTiming(0, timing('exit'), (f) => f && scheduleOnRN(finish)));
    } else {
      y.set(withSpring(height.get(), spring('sheetDismiss', 0), (f) => f && scheduleOnRN(finish)));
    }
  }, [open, mounted, reduced, y, height, fadeIn, entered]);

  const onLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    height.set(h);
    if (open && !entered.get()) {
      entered.set(true);
      if (reduced) {
        y.set(0);
        fadeIn.set(withTiming(1, timing('enter')));
      } else {
        fadeIn.set(1);
        y.set(h);
        y.set(withTiming(0, timing('sheet', 'sheet')));
      }
    }
  };

  const close = () => onClose();

  const pan = usePanGesture({
    activeOffsetY: [-10, 10],
    onActivate: () => {
      'worklet';
      start.set(y.get());
    },
    onUpdate: (e) => {
      'worklet';
      const next = start.get() + e.translationY;
      y.set(next >= 0 ? next : rubberband(next, height.get()));
    },
    onDeactivate: (e) => {
      'worklet';
      const projected = y.get() + project(e.velocityY);
      if (projected > height.get() * 0.4) {
        y.set(withSpring(height.get(), spring('sheetDismiss', e.velocityY), (f) => f && scheduleOnRN(close)));
      } else {
        y.set(withSpring(0, spring('sheet', e.velocityY)));
        scheduleOnRN(haptic, 'snap');
      }
    },
  });

  const sheetStyle = useAnimatedStyle(() => ({
    opacity: fadeIn.get(),
    transform: [{ translateY: y.get() }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(y.get(), [0, height.get()], [1, 0], Extrapolation.CLAMP) * fadeIn.get(),
  }));

  if (!mounted) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" accessibilityViewIsModal>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.backdrop }, backdropStyle]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" onPress={close} style={styles.flex} />
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View
          onLayout={onLayout}
          accessibilityRole={Platform.OS === 'web' ? undefined : 'summary'}
          accessibilityLabel={accessibilityLabel ?? title}
          style={[
            styles.sheet,
            {
              backgroundColor: colors.surfaceElevated,
              paddingBottom: Math.max(insets.bottom, space.lg),
              shadowColor: colors.shadow,
            },
            sheetStyle,
          ]}
        >
          <View style={styles.grabberWrap} accessible={false}>
            <View style={[styles.grabber, { backgroundColor: colors.tertiary }]} />
          </View>
          {title ? (
            <Text variant="headline" align="center" style={styles.title} accessibilityRole="header">
              {title}
            </Text>
          ) : null}
          <View style={styles.body}>{children}</View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingTop: space.sm,
    shadowOpacity: 0.2,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -4 },
    elevation: 12,
  },
  grabberWrap: { alignItems: 'center', paddingBottom: space.sm },
  grabber: { width: 36, height: 5, borderRadius: 3, opacity: 0.5 },
  title: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  body: { paddingHorizontal: space.lg, gap: space.md },
});

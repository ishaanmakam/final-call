import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';
import { haptics as map, type HapticName } from './tokens';

const impact: Record<'light' | 'medium' | 'heavy' | 'soft' | 'rigid', Haptics.ImpactFeedbackStyle> = {
  light: Haptics.ImpactFeedbackStyle.Light,
  medium: Haptics.ImpactFeedbackStyle.Medium,
  heavy: Haptics.ImpactFeedbackStyle.Heavy,
  soft: Haptics.ImpactFeedbackStyle.Soft,
  rigid: Haptics.ImpactFeedbackStyle.Rigid,
};

const notification: Record<'success' | 'warning' | 'error', Haptics.NotificationFeedbackType> = {
  success: Haptics.NotificationFeedbackType.Success,
  warning: Haptics.NotificationFeedbackType.Warning,
  error: Haptics.NotificationFeedbackType.Error,
};

/**
 * Fire the haptic for a named moment (see `haptics` in tokens.ts). Fire-and-forget: it never
 * throws, never awaits, and is a no-op on web and in tests. Call it in the same frame as the
 * visual change it accompanies. From a worklet, `scheduleOnRN(haptic, 'snap')`.
 */
export function haptic(name: HapticName): void {
  if (Platform.OS === 'web') return;
  const call = map[name];
  let p: Promise<void>;
  if (call.kind === 'selection') p = Haptics.selectionAsync();
  else if (call.kind === 'impact') p = Haptics.impactAsync(impact[call.style]);
  else p = Haptics.notificationAsync(notification[call.type]);
  p.catch(() => undefined);
}

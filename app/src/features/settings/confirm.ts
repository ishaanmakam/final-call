import { Alert, Platform } from 'react-native';

/**
 * A destructive confirmation: the platform alert on iOS/Android (the one place `Alert.alert` is
 * allowed), the browser's confirm on web, where RN's Alert is a no-op and would silently drop the
 * action.
 */
export function confirmDestructive(opts: { title: string; message: string; confirmLabel: string }): Promise<boolean> {
  if (Platform.OS === 'web') {
    const c = (globalThis as { confirm?: (msg: string) => boolean }).confirm;
    return Promise.resolve(c ? c(`${opts.title}\n\n${opts.message}`) : true);
  }
  return new Promise((resolve) => {
    Alert.alert(opts.title, opts.message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: opts.confirmLabel, style: 'destructive', onPress: () => resolve(true) },
    ]);
  });
}

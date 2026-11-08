/**
 * Web build of lib/openVenmo.ts: a browser cannot open the Venmo app (react-native-web's
 * `canOpenURL` says yes to everything and `venmo://` then does nothing), so the web pay link
 * opens venmo.com in a new tab. Same export as the native file.
 */
import * as Linking from 'expo-linking';
import { buildVenmoPayLinks, type VenmoPayRequest } from './venmo';

export async function openVenmoPayment(request: VenmoPayRequest): Promise<'app' | 'web'> {
  const { web } = buildVenmoPayLinks(request);
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(web, '_blank', 'noopener,noreferrer');
  } else {
    await Linking.openURL(web);
  }
  return 'web';
}

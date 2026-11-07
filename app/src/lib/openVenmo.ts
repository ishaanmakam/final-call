import * as Linking from 'expo-linking';
import { buildVenmoPayLinks, type VenmoPayRequest } from './venmo';

/** Opens the Venmo app (needs LSApplicationQueriesSchemes 'venmo'), else venmo.com. */
export async function openVenmoPayment(request: VenmoPayRequest): Promise<'app' | 'web'> {
  const { app, web } = buildVenmoPayLinks(request);
  try {
    if (await Linking.canOpenURL(app)) {
      await Linking.openURL(app);
      return 'app';
    }
  } catch {
    // fall through to the web link
  }
  await Linking.openURL(web);
  return 'web';
}

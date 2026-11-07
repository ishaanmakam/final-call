import type { ConfigContext, ExpoConfig } from 'expo/config';

const BUNDLE_ID = process.env.IOS_BUNDLE_ID ?? 'com.ishaanmakam.showup';
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID || undefined;

const LOCATION_WHEN_IN_USE =
  'Show Up reads your location once, only when you tap Check In during a pact window, to confirm you made it to your place. It never tracks you in the background.';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Show Up',
  slug: 'showup',
  scheme: 'showup',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  ios: {
    bundleIdentifier: BUNDLE_ID,
    supportsTablet: false,
    usesAppleSignIn: true,
    infoPlist: {
      NSLocationWhenInUseUsageDescription: LOCATION_WHEN_IN_USE,
      // lets Linking.canOpenURL detect the Venmo app for "Pay on Venmo"
      LSApplicationQueriesSchemes: ['venmo'],
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: BUNDLE_ID,
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
  },
  web: { favicon: './assets/favicon.png' },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-apple-authentication',
    [
      'expo-location',
      {
        locationWhenInUsePermission: LOCATION_WHEN_IN_USE,
        // foreground only: no "Always" prompt, no background modes
        locationAlwaysAndWhenInUsePermission: false,
        locationAlwaysPermission: false,
        isIosBackgroundLocationEnabled: false,
        isAndroidBackgroundLocationEnabled: false,
      },
    ],
    ['expo-notifications', { color: '#1F6FEB' }],
    [
      'expo-image-picker',
      {
        photosPermission: 'Choose a photo to attach as evidence when you appeal a result.',
        cameraPermission: false,
        microphonePermission: false,
      },
    ],
  ],
  extra: {
    ...(EAS_PROJECT_ID ? { eas: { projectId: EAS_PROJECT_ID } } : {}),
  },
});

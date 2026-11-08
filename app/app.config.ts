import type { ConfigContext, ExpoConfig } from 'expo/config';

const BUNDLE_ID = process.env.IOS_BUNDLE_ID ?? 'com.ishaanmakam.finalcall';
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID || undefined;

// Sentry is opt-in: the runtime needs EXPO_PUBLIC_SENTRY_DSN (src/lib/sentry.ts); the config
// plugin (native init + source-map upload at build time) additionally needs the org and project.
// SENTRY_AUTH_TOKEN is read by the plugin from the environment (an EAS secret), never written here.
const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN || undefined;
const SENTRY_ORG = process.env.SENTRY_ORG || undefined;
const SENTRY_PROJECT = process.env.SENTRY_PROJECT || undefined;
const SENTRY_URL = process.env.SENTRY_URL || 'https://sentry.io/';

const LOCATION_WHEN_IN_USE =
  'Final Call reads your location once, only when you tap Check In during a pact window, to confirm you made it to your place. Keep Precise Location on: an approximate location cannot be judged. It never tracks you in the background.';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Final Call',
  slug: 'final-call',
  scheme: 'finalcall',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  // expo-updates: one runtime per app version (a native change always ships with a version bump),
  // so an OTA update never reaches a binary that lacks its native modules. The update URL needs
  // the EAS project id; without it (local web export, screenshots) updates are simply not configured.
  runtimeVersion: { policy: 'appVersion' },
  ...(EAS_PROJECT_ID ? { updates: { url: `https://u.expo.dev/${EAS_PROJECT_ID}` } } : {}),
  ios: {
    bundleIdentifier: BUNDLE_ID,
    supportsTablet: false,
    usesAppleSignIn: true,
    infoPlist: {
      NSLocationWhenInUseUsageDescription: LOCATION_WHEN_IN_USE,
      // lets Linking.canOpenURL detect the Venmo app for "Pay on Venmo"
      LSApplicationQueriesSchemes: ['venmo'],
      ITSAppUsesNonExemptEncryption: false,
      // lets Reanimated animations run at 120 Hz on ProMotion iPhones
      CADisableMinimumFrameDurationOnPhone: true,
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
  // web exists only for the screenshot harness and demos (single-page output, SPA fallback)
  web: { favicon: './assets/favicon.png', bundler: 'metro', output: 'single' },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-apple-authentication',
    '@react-native-community/datetimepicker',
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
    ...(SENTRY_DSN && SENTRY_ORG && SENTRY_PROJECT
      ? [['@sentry/react-native/expo', { organization: SENTRY_ORG, project: SENTRY_PROJECT, url: SENTRY_URL }] as [string, object]]
      : []),
  ],
  extra: {
    ...(EAS_PROJECT_ID ? { eas: { projectId: EAS_PROJECT_ID } } : {}),
  },
});

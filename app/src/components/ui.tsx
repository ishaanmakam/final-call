/**
 * Compatibility layer: the names the phase-1 screens import, implemented on the new primitives.
 * New code imports from `@/components` directly; phase 2 migrates the screens and deletes this.
 */
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { userMessage } from '../lib/errors';
import { haptic } from '../theme/haptics';
import { useTheme } from '../theme/ThemeProvider';
import { TOUCH_TARGET, radius, space } from '../theme/tokens';
import { Button as NewButton, type ButtonVariant } from './Button';
import { Card as NewCard } from './Card';
import { Screen as NewScreen } from './Screen';
import { Pill } from './StatusPill';
import { Text } from './Text';
import { TextField } from './TextField';
import type { BadgeTone } from './status';

export type { BadgeTone } from './status';

export function Screen({
  children,
  refreshing,
  onRefresh,
  scroll = true,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  scroll?: boolean;
}) {
  return (
    <NewScreen scroll={scroll} refreshing={refreshing} onRefresh={onRefresh}>
      {children}
    </NewScreen>
  );
}

type LegacyVariant = ButtonVariant | 'danger' | 'ghost';

const variantMap: Record<LegacyVariant, ButtonVariant> = {
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  destructive: 'destructive',
  danger: 'destructive',
  ghost: 'tertiary',
};

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
  accessibilityHint,
}: {
  title: string;
  onPress: () => void;
  variant?: LegacyVariant;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}) {
  return (
    <NewButton
      title={title}
      onPress={onPress}
      variant={variantMap[variant]}
      disabled={disabled}
      loading={loading}
      style={style}
      accessibilityHint={accessibilityHint}
    />
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <NewCard style={style}>{children}</NewCard>;
}

export function Title({ children }: { children: ReactNode }) {
  return (
    <Text variant="title1" accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return (
    <Text variant="headline" accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <Text variant="subheadline" color={muted ? 'secondary' : 'label'}>
      {children}
    </Text>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <Text variant="footnote" color="forfeit" accessibilityRole="alert" accessibilityLiveRegion="assertive">
      {userMessage(error)}
    </Text>
  );
}

export function Field({ label, hint, value, onChangeText, ...input }: TextInputProps & { label: string; hint?: string }) {
  return <TextField label={label} helper={hint} value={value ?? ''} onChangeText={onChangeText ?? (() => undefined)} {...input} />;
}

export function Loading() {
  const { colors } = useTheme();
  return (
    <View style={[styles.center, { backgroundColor: colors.bg }]} accessibilityLabel="Loading" accessibilityState={{ busy: true }}>
      <ActivityIndicator size="large" color={colors.secondary} />
    </View>
  );
}

export function QueryState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Screen>
      <ErrorText error={error} />
      <Button title="Try again" variant="secondary" onPress={onRetry} />
    </Screen>
  );
}

export function Badge({ label, tone }: { label: string; tone: BadgeTone }) {
  return <Pill label={label} tone={tone} size="compact" />;
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
      hitSlop={6}
      onPress={() => {
        haptic('selection');
        onPress();
      }}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: selected ? colors.tint : colors.surface, borderColor: selected ? colors.tint : colors.separator },
        pressed && { opacity: 0.8 },
      ]}
    >
      <Text variant="subheadline" emphasis style={{ color: selected ? colors.onTint : colors.label }}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  chip: {
    minHeight: TOUCH_TARGET - 8,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    justifyContent: 'center',
  },
});

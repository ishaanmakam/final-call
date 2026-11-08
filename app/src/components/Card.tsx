import type { ReactNode } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { radius, space } from '../theme/tokens';

export interface CardProps {
  children: ReactNode;
  /**
   * One elevation declaration. `flat` (default) is a hairline border on `surface`; `raised` is a
   * soft offset shadow with no border, reserved for things that float (the toast, a sheet).
   * Never both. Never a card inside a card: use a ListGroup or plain spacing instead.
   */
  elevation?: 'flat' | 'raised';
  padding?: keyof typeof space | 0;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

export function Card({ children, elevation = 'flat', padding = 'lg', style, accessibilityLabel }: CardProps) {
  const { colors } = useTheme();
  const pad = padding === 0 ? 0 : space[padding];
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.base,
        { padding: pad },
        elevation === 'flat'
          ? { backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator }
          : [styles.raised, { backgroundColor: colors.surfaceElevated, shadowColor: colors.shadow }],
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: radius.lg, gap: space.sm, overflow: Platform.OS === 'android' ? 'hidden' : 'visible' },
  raised: {
    shadowOpacity: 0.16,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
});

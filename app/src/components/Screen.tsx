import type { ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';
import { gutter, space } from '../theme/tokens';

export interface ScreenProps {
  children: ReactNode;
  /** scrolling content with pull-to-refresh (default); false for screens that lay out themselves */
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** horizontal gutter and vertical rhythm (default true) */
  padded?: boolean;
  /** pinned under the content, above the home indicator: the screen's one primary action */
  footer?: ReactNode;
  /** extra space at the bottom of the scroll (e.g. above a floating button) */
  bottomInset?: number;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Safe-area aware screen root. Under a native stack header the top inset is handled by
 * `contentInsetAdjustmentBehavior="automatic"`; the bottom respects the home indicator.
 */
export function Screen({
  children,
  scroll = true,
  refreshing,
  onRefresh,
  padded = true,
  footer,
  bottomInset = 0,
  contentStyle,
  testID,
}: ScreenProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const paddingBottom = (footer ? space.md : Math.max(insets.bottom, space.lg)) + bottomInset;
  const inner = [padded && styles.padded, { paddingBottom }, contentStyle];

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]} testID={testID}>
      {scroll ? (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.grow, inner]}
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          refreshControl={
            onRefresh ? (
              <RefreshControl refreshing={refreshing ?? false} onRefresh={onRefresh} tintColor={colors.secondary} />
            ) : undefined
          }
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.flex, inner]}>{children}</View>
      )}
      {footer ? (
        <View
          style={[
            styles.footer,
            { paddingBottom: Math.max(insets.bottom, space.lg), paddingLeft: gutter + insets.left, paddingRight: gutter + insets.right },
          ]}
        >
          {footer}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  grow: { flexGrow: 1 },
  padded: { paddingHorizontal: gutter, paddingTop: space.lg, gap: space.md },
  footer: { paddingTop: space.sm },
});

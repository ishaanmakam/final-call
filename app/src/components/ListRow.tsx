import { Children, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { transition } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { TOUCH_TARGET, radius, space } from '../theme/tokens';
import { Icon } from './Icon';
import { Text } from './Text';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  /** avatar, icon, status dot */
  leading?: ReactNode;
  /** value text, pill, switch */
  trailing?: ReactNode;
  /** show a disclosure chevron (implies navigation) */
  chevron?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  /** a destructive action row (Sign out, Leave group): title in the forfeit tone, centered when alone */
  destructive?: boolean;
  /** drawn by ListGroup; a lone row keeps its own corners */
  position?: 'only' | 'first' | 'middle' | 'last';
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Inset-grouped iOS row: 44pt minimum, leading / title + subtitle / trailing / chevron. */
export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  chevron,
  onPress,
  disabled,
  destructive,
  position = 'only',
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: ListRowProps) {
  const { colors } = useTheme();
  const [pressed, setPressed] = useState(false);
  const corners = cornerStyle(position);
  const body = (
    <Animated.View
      style={[
        styles.row,
        rowTransition,
        corners,
        { backgroundColor: pressed ? colors.fill : colors.surface },
        position !== 'only' && position !== 'last' && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
        disabled && styles.disabled,
        style,
      ]}
    >
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.text}>
        <Text
          variant="body"
          color={destructive ? 'forfeit' : 'label'}
          align={destructive && !leading && !trailing && !chevron ? 'center' : undefined}
          numberOfLines={2}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text variant="subheadline" color="secondary" numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
      {chevron ? <Icon name="chevron.right" size={16} color="tertiary" /> : null}
    </Animated.View>
  );
  if (!onPress) return <View accessibilityLabel={accessibilityLabel}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}, ${subtitle}` : title)}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      pressRetentionOffset={16}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}

function cornerStyle(position: NonNullable<ListRowProps['position']>): ViewStyle {
  switch (position) {
    case 'only':
      return { borderRadius: radius.lg };
    case 'first':
      return { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg };
    case 'last':
      return { borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg };
    default:
      return {};
  }
}

export interface ListGroupProps {
  children: ReactNode;
  /** small caps-free header above the group, like iOS Settings */
  header?: string;
  footer?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Wraps ListRows into one inset-grouped block: gives each child its `position` so corners and
 * separators are right. Children that are not ListRows are rendered as-is (dividers, custom rows).
 */
export function ListGroup({ children, header, footer, style }: ListGroupProps) {
  const { colors } = useTheme();
  const items = Children.toArray(children).filter(Boolean);
  const n = items.length;
  return (
    <View style={[styles.group, style]}>
      {header ? (
        <Text variant="footnote" color="secondary" style={styles.header}>
          {header}
        </Text>
      ) : null}
      <View style={[styles.block, { borderColor: colors.separator }]}>
        {items.map((child, i) => {
          const position = n === 1 ? 'only' : i === 0 ? 'first' : i === n - 1 ? 'last' : 'middle';
          if (typeof child === 'object' && child !== null && 'type' in child && child.type === ListRow) {
            const el = child as React.ReactElement<ListRowProps>;
            return <ListRow key={el.key ?? i} {...el.props} position={position} />;
          }
          return child;
        })}
      </View>
      {footer ? (
        <Text variant="footnote" color="secondary" style={styles.footer}>
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

const rowTransition = transition('backgroundColor', 'press');

const styles = StyleSheet.create({
  row: {
    minHeight: TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 2,
  },
  leading: { alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, gap: 1 },
  trailing: { alignItems: 'flex-end', justifyContent: 'center' },
  disabled: { opacity: 0.45 },
  group: { gap: space.xs },
  header: { paddingHorizontal: space.lg, paddingBottom: space.xs },
  footer: { paddingHorizontal: space.lg, paddingTop: space.xs },
  block: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
});

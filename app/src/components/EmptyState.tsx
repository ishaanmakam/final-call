import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { space } from '../theme/tokens';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export interface EmptyStateProps {
  title: string;
  /** says what will appear here and how to make it appear; never just "nothing here" */
  body: string;
  icon?: IconName;
  action?: { label: string; onPress: () => void; variant?: 'primary' | 'secondary'; loading?: boolean };
  secondaryAction?: { label: string; onPress: () => void };
  /** `inline` sits in a list; `screen` centers itself with room above */
  layout?: 'inline' | 'screen';
  style?: StyleProp<ViewStyle>;
}

/** Teaches the interface: what this area is for and the one tap that fills it. */
export function EmptyState({ title, body, icon, action, secondaryAction, layout = 'inline', style }: EmptyStateProps) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityRole="summary"
      accessibilityLabel={`${title}. ${body}`}
      style={[styles.wrap, layout === 'screen' && styles.screen, style]}
    >
      {icon ? (
        <View style={[styles.iconWell, { backgroundColor: colors.fill }]}>
          <Icon name={icon} size={24} color="secondary" />
        </View>
      ) : null}
      <Text variant="title3" align="center">
        {title}
      </Text>
      <Text variant="subheadline" color="secondary" align="center" style={styles.body}>
        {body}
      </Text>
      {action ? (
        <View style={styles.actions}>
          <Button title={action.label} onPress={action.onPress} variant={action.variant ?? 'primary'} size="small" loading={action.loading} />
          {secondaryAction ? (
            <Button title={secondaryAction.label} onPress={secondaryAction.onPress} variant="tertiary" size="small" />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: space.sm, paddingVertical: space.xxl, paddingHorizontal: space.lg },
  screen: { flex: 1, justifyContent: 'center', paddingBottom: space.giant },
  iconWell: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: space.xs },
  body: { maxWidth: 300 },
  actions: { marginTop: space.md, alignItems: 'center', gap: space.xs },
});

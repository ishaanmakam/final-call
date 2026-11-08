import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { radius, space } from '../theme/tokens';
import { Text } from './Text';
import { dayStateLabel, resolveTone, type BadgeTone, type DayState } from './status';

export interface PillProps {
  label: string;
  tone: BadgeTone;
  /** compact pills sit inside rows; regular pills sit on cards */
  size?: 'compact' | 'regular';
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

/** Any label on a tone-colored soft background. Prefer StatusPill when the thing is a state. */
export function Pill({ label, tone, size = 'regular', style, accessibilityLabel }: PillProps) {
  const { colors } = useTheme();
  const t = resolveTone(tone);
  const fg = t === 'tint' ? colors.tint : colors.state[t].fg;
  const bg = t === 'tint' ? colors.tintSoft : colors.state[t].soft;
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel ?? label}
      style={[styles.pill, size === 'compact' && styles.compact, { backgroundColor: bg }, style]}
    >
      <Text variant={size === 'compact' ? 'caption1' : 'footnote'} emphasis style={{ color: fg }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export interface StatusPillProps {
  /** a result status or a live day state */
  state: DayState;
  size?: PillProps['size'];
  style?: StyleProp<ViewStyle>;
  /** prefix for VoiceOver, e.g. the person's name */
  who?: string;
}

/** The one way a result or day state appears: glossary label + state tone from the palette. */
export function StatusPill({ state, size, style, who }: StatusPillProps) {
  const { label, tone } = dayStateLabel[state];
  return <Pill label={label} tone={tone} size={size} style={style} accessibilityLabel={who ? `${who}: ${label}` : label} />;
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: space.sm + 2,
    paddingVertical: space.xs,
  },
  compact: { paddingHorizontal: space.sm, paddingVertical: space.xxs },
});

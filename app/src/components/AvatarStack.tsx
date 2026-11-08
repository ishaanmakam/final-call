import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { Text } from './Text';

export interface Person {
  id: string;
  name: string;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]!.charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : '';
  return (first + last).toUpperCase();
}

/** Stable palette slot for a person so the same friend keeps the same color on every screen. */
export function avatarSlot(id: string, slots: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % slots;
}

/** Below this size two letters no longer fit a circle (with its ring) at any system font; one does. */
export const SINGLE_INITIAL_BELOW = 28;

/**
 * Initials sized from the circle, not from the type scale: two letters need about 36% of the
 * diameter each to clear the ring; when less than 28 pt of the circle is visible (a small avatar,
 * or one partly covered by its neighbour in a stack) only the first initial is drawn.
 */
export function avatarInitials(name: string, size: number, visibleWidth = size): { text: string; fontSize: number } {
  const text = visibleWidth < SINGLE_INITIAL_BELOW ? initials(name).charAt(0) : initials(name);
  return { text, fontSize: Math.max(9, Math.round(size * 0.36)) };
}

export interface AvatarProps {
  person: Person;
  size?: number;
  /** a ring in the tint marks "you" */
  highlighted?: boolean;
  /** how much of the circle is uncovered (a stack overlaps its neighbours); defaults to the size */
  visibleWidth?: number;
  style?: StyleProp<ViewStyle>;
}

export function Avatar({ person, size = 32, highlighted, visibleWidth, style }: AvatarProps) {
  const { colors } = useTheme();
  const slot = colors.avatar[avatarSlot(person.id, colors.avatar.length)]!;
  const { text, fontSize } = avatarInitials(person.name, size, visibleWidth);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={person.name}
      style={[
        styles.circle,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: slot.bg },
        highlighted && { borderWidth: 2, borderColor: colors.tint },
        style,
      ]}
    >
      <Text
        variant="caption1"
        emphasis
        numberOfLines={1}
        // the circle is a fixed-size glyph, like an SF Symbol: it does not grow with Dynamic Type
        maxFontSizeMultiplier={1}
        style={{ color: slot.fg, fontSize, lineHeight: fontSize * 1.2, letterSpacing: -0.2 }}
      >
        {text}
      </Text>
    </View>
  );
}

export interface AvatarStackProps {
  people: Person[];
  /** how many circles to show before "+n" */
  max?: number;
  size?: number;
  /** ids to ring in the tint (usually the current user) */
  highlightIds?: ReadonlySet<string> | string[];
  style?: StyleProp<ViewStyle>;
}

/** Overlapping initials circles with a "+n" tail. Reads as one group to VoiceOver. */
export function AvatarStack({ people, max = 4, size = 28, highlightIds, style }: AvatarStackProps) {
  const { colors } = useTheme();
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  const highlight = highlightIds instanceof Set ? highlightIds : new Set(highlightIds ?? []);
  const overlap = Math.round(size * 0.3);
  const tail = avatarInitials('+', size).fontSize;
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={people.map((p) => p.name).join(', ')}
      style={[styles.stack, style]}
    >
      {shown.map((p, i) => (
        <View key={p.id} style={[i > 0 && { marginLeft: -overlap }, { zIndex: shown.length - i }]}>
          <Avatar
            person={p}
            size={size}
            // the circle to its left sits on top (higher zIndex), so only the uncovered part holds letters
            visibleWidth={i > 0 ? size - overlap : size}
            highlighted={highlight.has(p.id)}
            style={{ borderWidth: 2, borderColor: highlight.has(p.id) ? colors.tint : colors.bg }}
          />
        </View>
      ))}
      {extra > 0 ? (
        <View
          style={[
            styles.circle,
            { width: size, height: size, borderRadius: size / 2, marginLeft: -overlap, backgroundColor: colors.fill, borderWidth: 2, borderColor: colors.bg },
          ]}
        >
          <Text
            variant="caption1"
            emphasis
            color="secondary"
            numberOfLines={1}
            maxFontSizeMultiplier={1}
            style={{ fontSize: tail, lineHeight: tail * 1.2 }}
          >
            +{extra}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  stack: { flexDirection: 'row', alignItems: 'center' },
});

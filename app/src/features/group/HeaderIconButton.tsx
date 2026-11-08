import { Platform, Pressable, StyleSheet } from 'react-native';
import { Icon, type IconName } from '../../components';
import { TOUCH_TARGET } from '../../theme';

export interface HeaderIconButtonProps {
  name: IconName;
  /** VoiceOver name; the icon alone never carries meaning */
  label: string;
  onPress: () => void;
  hint?: string;
}

/** An SF Symbol in the navigation bar: 44 pt target, tint colour, pressed opacity like UIBarButtonItem. */
export function HeaderIconButton({ name, label, onPress, hint }: HeaderIconButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Icon name={name} size={22} color="tint" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: Platform.OS === 'web' ? 4 : 0,
  },
  pressed: { opacity: 0.4 },
});

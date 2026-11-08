import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { transition } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { TOUCH_TARGET, radius, space, type as typeScale } from '../theme/tokens';
import { Icon } from './Icon';
import { Text } from './Text';

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  /** shown under the field in the forfeit tone; also sets accessibilityState invalid */
  error?: string | null;
  /** shown under the field when there is no error */
  helper?: string;
  /** show the clear (x) button while there is text (default true for single-line) */
  clearable?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * Label above, 44pt input on surface with a hairline border that turns tint on focus and
 * forfeit on error (color transitions only). Placeholder uses `secondary` (4.5:1).
 */
export function TextField({
  label,
  value,
  onChangeText,
  error,
  helper,
  clearable,
  style,
  multiline,
  editable = true,
  ...input
}: TextFieldProps) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  const showClear = (clearable ?? !multiline) && value.length > 0 && editable;
  const borderColor = error ? colors.state.forfeit.fg : focused ? colors.tint : colors.separator;
  const body = typeScale.body;
  return (
    <View style={[styles.wrap, style]}>
      <Text variant="subheadline" emphasis nativeID={`${label}-label`}>
        {label}
      </Text>
      <Animated.View
        style={[
          styles.box,
          boxTransition,
          multiline && styles.multiline,
          { backgroundColor: colors.surface, borderColor, borderWidth: focused || error ? 1.5 : StyleSheet.hairlineWidth },
          !editable && styles.disabled,
        ]}
      >
        <TextInput
          value={value}
          onChangeText={onChangeText}
          editable={editable}
          multiline={multiline}
          placeholderTextColor={colors.secondary}
          accessibilityLabel={label}
          accessibilityLabelledBy={`${label}-label`}
          accessibilityState={{ disabled: !editable }}
          accessibilityHint={error ?? helper}
          maxFontSizeMultiplier={body.maxFontSizeMultiplier}
          onFocus={(e) => {
            setFocused(true);
            input.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            input.onBlur?.(e);
          }}
          {...input}
          style={[
            styles.input,
            { color: colors.label, fontSize: body.fontSize, letterSpacing: body.letterSpacing },
            multiline && styles.inputMultiline,
          ]}
        />
        {showClear ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Clear ${label}`}
            hitSlop={10}
            onPress={() => onChangeText('')}
            style={styles.clear}
          >
            <Icon name="xmark.circle.fill" size={18} color="tertiary" />
          </Pressable>
        ) : null}
      </Animated.View>
      {error ? (
        <Text variant="footnote" color="forfeit" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : helper ? (
        <Text variant="footnote" color="secondary">
          {helper}
        </Text>
      ) : null}
    </View>
  );
}

const boxTransition = transition(['borderColor', 'borderWidth'], 'state');

const styles = StyleSheet.create({
  wrap: { gap: space.xs + 2 },
  box: {
    minHeight: TOUCH_TARGET,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.md,
  },
  multiline: { alignItems: 'flex-start', minHeight: 96 },
  input: { flex: 1, paddingVertical: space.sm + 2, paddingRight: space.md, minHeight: TOUCH_TARGET },
  inputMultiline: { textAlignVertical: 'top', paddingTop: space.md },
  clear: { paddingHorizontal: space.md, alignSelf: 'stretch', justifyContent: 'center' },
  disabled: { opacity: 0.5 },
});

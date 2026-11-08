import type { CSSProperties } from 'react';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space, type as typeScale } from '../../theme/tokens';
import type { DatePickerProps } from './DatePicker';

export { dateToLocalDate, localDateToDate } from './DatePicker';

/** Web fallback for the screenshot harness: the browser's own date input, themed from the palette. */
export function DatePicker({ value, onChange, accessibilityLabel, minimum }: DatePickerProps) {
  const { colors, scheme } = useTheme();
  const body = typeScale.body;
  const style: CSSProperties = {
    fontFamily: 'inherit',
    fontSize: body.fontSize,
    lineHeight: `${body.lineHeight}px`,
    letterSpacing: body.letterSpacing,
    fontVariantNumeric: 'tabular-nums',
    color: colors.label,
    backgroundColor: colors.fill,
    border: 'none',
    borderRadius: radius.sm,
    padding: `${space.xs + 2}px ${space.md}px`,
    minHeight: 36,
    colorScheme: scheme,
    outline: 'none',
  };
  return (
    <input
      type="date"
      aria-label={accessibilityLabel}
      value={value}
      min={minimum}
      style={style}
      onChange={(e) => {
        if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) onChange(e.target.value);
      }}
    />
  );
}

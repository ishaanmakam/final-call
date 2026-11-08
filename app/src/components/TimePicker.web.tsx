import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeProvider';
import { radius, space, type as typeScale } from '../theme/tokens';
import type { TimePickerProps } from './TimePicker';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Web fallback for the screenshot harness: the browser's own time input, themed from the palette. */
export function TimePicker({ minutes, onChange, accessibilityLabel, minuteInterval = 5 }: TimePickerProps) {
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
      type="time"
      aria-label={accessibilityLabel}
      value={`${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`}
      step={minuteInterval * 60}
      style={style}
      onChange={(e) => {
        const [h, m] = e.target.value.split(':').map(Number);
        if (h !== undefined && m !== undefined && Number.isFinite(h) && Number.isFinite(m)) onChange(h * 60 + m);
      }}
    />
  );
}

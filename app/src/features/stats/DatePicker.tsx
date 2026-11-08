import DateTimePicker from '@react-native-community/datetimepicker';
import { useTheme } from '../../theme/ThemeProvider';

export interface DatePickerProps {
  /** 'YYYY-MM-DD' (a calendar day; no zone) */
  value: string;
  onChange: (localDate: string) => void;
  accessibilityLabel: string;
  /** earliest selectable day, 'YYYY-MM-DD' */
  minimum?: string;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** The picker speaks Date in the device zone; noon keeps the calendar day stable across zones. */
export function localDateToDate(localDate: string): Date {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

export const dateToLocalDate = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/**
 * The platform date picker in its compact iOS form (a tappable value that opens the calendar in a
 * popover), like `components/TimePicker`. Web has its own file (an <input type="date">).
 */
export function DatePicker({ value, onChange, accessibilityLabel, minimum }: DatePickerProps) {
  const { colors, scheme } = useTheme();
  return (
    <DateTimePicker
      value={localDateToDate(value)}
      mode="date"
      display="compact"
      minimumDate={minimum ? localDateToDate(minimum) : undefined}
      accentColor={colors.tint}
      themeVariant={scheme}
      accessibilityLabel={accessibilityLabel}
      onChange={(_event, date) => {
        if (date) onChange(dateToLocalDate(date));
      }}
    />
  );
}

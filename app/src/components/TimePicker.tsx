import DateTimePicker from '@react-native-community/datetimepicker';
import { dateToMinutes, minutesToDate } from '../features/pact/wizard';
import { useTheme } from '../theme/ThemeProvider';

export interface TimePickerProps {
  /** minutes after midnight */
  minutes: number;
  onChange: (minutes: number) => void;
  accessibilityLabel: string;
  /** picker granularity in minutes (must divide 60) */
  minuteInterval?: 1 | 5 | 10 | 15;
}

/**
 * The platform time picker in its compact iOS form: a tappable value that opens the wheel in a
 * popover. Sits in a ListRow's trailing slot. Web has its own file (an <input type="time">).
 */
export function TimePicker({ minutes, onChange, accessibilityLabel, minuteInterval = 5 }: TimePickerProps) {
  const { colors, scheme } = useTheme();
  return (
    <DateTimePicker
      value={minutesToDate(minutes)}
      mode="time"
      display="compact"
      minuteInterval={minuteInterval}
      accentColor={colors.tint}
      themeVariant={scheme}
      accessibilityLabel={accessibilityLabel}
      onChange={(_event, date) => {
        if (date) onChange(dateToMinutes(date));
      }}
    />
  );
}

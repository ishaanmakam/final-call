import { StyleSheet, View } from 'react-native';
import { displayMinutes } from '../lib/time';
import { haptic } from '../theme/haptics';
import { space } from '../theme/tokens';
import { Button } from './Button';
import { Text } from './Text';

const DAY = 24 * 60;

/** Minutes-after-midnight picker without a native date picker. */
export function TimeStepper({
  label,
  minutes,
  onChange,
  step = 15,
}: {
  label: string;
  minutes: number;
  onChange: (m: number) => void;
  step?: number;
}) {
  const shift = (delta: number) => {
    haptic('selection');
    onChange((((minutes + delta) % DAY) + DAY) % DAY);
  };
  return (
    <View style={styles.wrap} accessible accessibilityLabel={`${label}: ${displayMinutes(minutes)}`}>
      <Text variant="subheadline" emphasis>
        {label}
      </Text>
      <View style={styles.row}>
        <Button title="-1h" variant="secondary" size="small" onPress={() => shift(-60)} accessibilityLabel="One hour earlier" />
        <Button title={`-${step}`} variant="secondary" size="small" onPress={() => shift(-step)} accessibilityLabel={`${step} minutes earlier`} />
        <Text variant="title3" tabular style={styles.time}>
          {displayMinutes(minutes)}
        </Text>
        <Button title={`+${step}`} variant="secondary" size="small" onPress={() => shift(step)} accessibilityLabel={`${step} minutes later`} />
        <Button title="+1h" variant="secondary" size="small" onPress={() => shift(60)} accessibilityLabel="One hour later" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.xs },
  time: { minWidth: 96, textAlign: 'center' },
});

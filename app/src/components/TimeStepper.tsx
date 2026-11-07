import { StyleSheet, Text, View } from 'react-native';
import { displayMinutes } from '../lib/time';
import { colors, space } from './theme';
import { Button } from './ui';

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
  const shift = (delta: number) => onChange((((minutes + delta) % DAY) + DAY) % DAY);
  return (
    <View style={styles.wrap} accessible accessibilityLabel={`${label}: ${displayMinutes(minutes)}`}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        <Button title="-1h" variant="secondary" onPress={() => shift(-60)} style={styles.btn} />
        <Button title={`-${step}`} variant="secondary" onPress={() => shift(-step)} style={styles.btn} />
        <Text style={styles.time}>{displayMinutes(minutes)}</Text>
        <Button title={`+${step}`} variant="secondary" onPress={() => shift(step)} style={styles.btn} />
        <Button title="+1h" variant="secondary" onPress={() => shift(60)} style={styles.btn} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs },
  label: { fontSize: 14, fontWeight: '600', color: colors.text },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.xs },
  btn: { minHeight: 40, paddingHorizontal: space.sm },
  time: { fontSize: 20, fontWeight: '700', color: colors.text, minWidth: 90, textAlign: 'center' },
});

import { StyleSheet, View } from 'react-native';
import { Countdown, Text } from '../../components';
import { formatTimeInZone, msUntil, type WindowState } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { space } from '../../theme';
import { clockA11yLabel, clockCopy } from './copy';

export interface WindowClockProps {
  phase: WindowState;
  windowOpenAt: string;
  deadlineAt: string;
  tz: string;
}

/**
 * The big line of the check-in screen. Owns the only per-second clock in its subtree, so the rest
 * of the screen is left alone. VoiceOver reads one label that changes per minute; it is not a live
 * region (the Countdown primitive announces once at 5 and 1 minutes).
 */
export function WindowClock({ phase, windowOpenAt, deadlineAt, tz }: WindowClockProps) {
  const now = useNow(1000);
  const remaining = msUntil(phase === 'before' ? windowOpenAt : deadlineAt, now);
  const openText = formatTimeInZone(windowOpenAt, tz);
  const deadlineText = formatTimeInZone(deadlineAt, tz);
  const c = clockCopy(phase, remaining, openText, deadlineText);

  return (
    <View accessible accessibilityLabel={clockA11yLabel(phase, remaining, openText, deadlineText)} style={styles.wrap}>
      {c.showCountdown ? (
        <View style={styles.line}>
          {c.prefix ? <Text variant="title1">{c.prefix} </Text> : null}
          <Countdown
            ms={remaining}
            variant="title1"
            suffix={phase === 'before' ? 'until it opens' : 'left'}
            urgentColor={phase === 'open'}
            announceAtMinutes={phase === 'open' ? [5, 1] : []}
          />
        </View>
      ) : (
        <Text variant="title1">{c.big}</Text>
      )}
      <Text variant="footnote" color={c.urgent ? 'forfeit' : 'secondary'} align="center" tabular>
        {c.footnote}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: space.xxs },
  line: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center' },
});

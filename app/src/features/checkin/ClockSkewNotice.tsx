import { useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { DEMO, getDemoSettings } from '../../api/demo/settings';
import { Icon, Text } from '../../components';
import { clockSkewCopy, serverDeadlineLine, serverNow, serverOffsetMs, subscribeServerOffset } from '../../lib/serverTime';
import { formatTimeInZone } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { space } from '../../theme';

/** The live `server - device` estimate (lib/serverTime); re-renders when a new sample moves it. */
export function useServerOffset(): number {
  return useSyncExternalStore(subscribeServerOffset, serverOffsetMs, serverOffsetMs);
}

export interface ClockSkewNoticeProps {
  deadlineAt: string;
  tz: string;
}

/**
 * Shown under the clock when the phone's clock is more than two minutes off the server's. A fact,
 * not an alarm: secondary tone, footnote size. The second line puts the deadline on the server's
 * clock, since that is the clock the tap is judged by.
 */
export function ClockSkewNotice({ deadlineAt, tz }: ClockSkewNoticeProps) {
  const live = useServerOffset();
  const offset = DEMO ? getDemoSettings().skew * 1000 : live;
  const now = useNow(1000);
  const copy = clockSkewCopy(offset);
  if (!copy) return null;
  const deadlineText = formatTimeInZone(deadlineAt, tz);
  const remaining = Date.parse(deadlineAt) - (DEMO ? now + offset : serverNow(now));
  const second = serverDeadlineLine(deadlineText, remaining);
  return (
    <View style={styles.wrap} accessible accessibilityRole="text" accessibilityLabel={`${copy} ${second}`}>
      <Icon name="clock" size={16} color="secondary" />
      <View style={styles.lines}>
        <Text variant="footnote" color="secondary">
          {copy}
        </Text>
        <Text variant="footnote" color="secondary" tabular>
          {second}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: space.xs,
    marginTop: space.sm,
    paddingHorizontal: space.lg,
  },
  lines: { flexShrink: 1, gap: space.xxs },
});

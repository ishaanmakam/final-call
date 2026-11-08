import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, ListGroup, ListRow, SegmentedControl, Sheet, Text } from '../../components';
import { localDateInZone } from '../../lib/time';
import { nowMs } from '../../lib/useNow';
import { haptic, space, useTheme } from '../../theme';
import { DatePicker } from './DatePicker';
import { DEFAULT_SEASON_WEEKS, SEASON_WEEK_OPTIONS, formatLocalDay, nextMonday, seasonSummary, type Season } from './season';

export interface SeasonSheetProps {
  open: boolean;
  onClose: () => void;
  pactTitle: string;
  /** the pact's zone: "today" and the default Monday are read in it */
  tz: string;
  /** resolves when the season is saved; the sheet closes itself */
  onStart: (season: Season) => Promise<void>;
}

/**
 * Start a season: a start day (the coming Monday by default) and a length. Weeks run from the start
 * day, so a Monday start finishes on a Sunday, the same rhythm as the weekly settle-up.
 */
export function SeasonSheet({ open, onClose, pactTitle, tz, onStart }: SeasonSheetProps) {
  const { colors } = useTheme();
  const today = localDateInZone(nowMs(), tz);
  const [start, setStart] = useState(() => nextMonday(today));
  const [weeksIndex, setWeeksIndex] = useState(Math.max(0, SEASON_WEEK_OPTIONS.indexOf(DEFAULT_SEASON_WEEKS)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStart(nextMonday(localDateInZone(nowMs(), tz)));
      setWeeksIndex(Math.max(0, SEASON_WEEK_OPTIONS.indexOf(DEFAULT_SEASON_WEEKS)));
      setError(null);
    }
  }, [open, tz]);

  const season: Season = { start, weeks: SEASON_WEEK_OPTIONS[weeksIndex] ?? DEFAULT_SEASON_WEEKS };
  const startsToday = start === today;
  const inPast = start < today;

  const submit = async () => {
    setBusy(true);
    setError(null);
    haptic('commit');
    try {
      await onStart(season);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      haptic('error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Start a season">
      <Text variant="subheadline" color="secondary">
        A season gives {pactTitle} a finish line. At the end everyone sees who showed up most, who had the longest streak and who came out
        ahead. Days before the start are not counted.
      </Text>
      <ListGroup
        footer={
          inPast
            ? `Starts in the past: days since ${formatLocalDay(start)} count.`
            : startsToday
              ? 'Starts today. Weeks run from the start day, so a Monday start finishes on a Sunday.'
              : 'Defaults to the coming Monday. Weeks run from the start day, so a Monday start finishes on a Sunday.'
        }
      >
        <ListRow
          title="Starts"
          trailing={<DatePicker value={start} onChange={setStart} accessibilityLabel="Season start" />}
          accessibilityLabel={`Starts ${formatLocalDay(start)}`}
        />
        <View style={[styles.segment, { backgroundColor: colors.surface }]}>
          <SegmentedControl
            segments={SEASON_WEEK_OPTIONS.map((w) => `${w} weeks`)}
            index={weeksIndex}
            onChange={setWeeksIndex}
            accessibilityLabel="Season length"
          />
        </View>
      </ListGroup>
      <Text variant="footnote" color="secondary" align="center">
        {seasonSummary(season)}
      </Text>
      {error ? (
        <Text variant="footnote" color="forfeit" accessibilityRole="alert" accessibilityLiveRegion="assertive">
          {error}
        </Text>
      ) : null}
      <Button title="Start season" onPress={() => void submit()} loading={busy} accessibilityHint="Saves the season for everyone in the pact" />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  segment: { paddingHorizontal: space.lg, paddingVertical: space.md },
});

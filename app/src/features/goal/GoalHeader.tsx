import { StyleSheet, View } from 'react-native';
import type { PactInstanceRow, PactRow } from '../../api/types';
import { Button, Card, Pill, ProgressRing, StatusPill, Text } from '../../components';
import type { DayState } from '../../components/status';
import { space } from '../../theme';
import { formatGoalValue, goalLabel, progressFraction, remainingText, timeLeftText, type DistanceUnit } from './goal';
import { weekTimingLine } from './progress';

export interface GoalHeaderProps {
  pact: PactRow;
  instance: PactInstanceRow | null;
  /** my accepted total in the pact unit (metres / count / steps); null when I am not in the pact */
  myValue: number | null;
  /** in the pact but not on this round's roster (joined after it opened; CA-9): in from the next one */
  notOnRoster?: boolean;
  myReached: boolean;
  /** my posted result for this instance, once the gate closed */
  myResult: DayState | null;
  unit: DistanceUnit;
  nowMs: number;
  /** not in the pact yet */
  onJoin?: () => void;
  joining?: boolean;
  /** custom kind: mark the day or week done */
  onMarkDone?: () => void;
  marking?: boolean;
}

/**
 * The pact screen's head for a goal kind: your progress ring with the percentage inside, the value
 * line ("11.2 / 15.0 mi"), what is left and how long ("3.8 mi to go · 2 days left") and the week's
 * timing in the airport voice. Not in the pact: the goal and a Join button instead of the ring.
 */
export function GoalHeader({ pact, instance, myValue, notOnRoster, myReached, myResult, unit, nowMs, onJoin, joining, onMarkDone, marking }: GoalHeaderProps) {
  const goal = goalLabel(pact, unit);
  const timing = instance ? (pact.period === 'daily' ? `Today · ${timeLeftText(instance.deadline_at, nowMs)}` : weekTimingLine(instance, pact.tz, nowMs).text) : 'No week open yet';

  if (myValue !== null && notOnRoster) {
    const next = pact.period === 'weekly' ? 'Monday' : pact.period === 'daily' ? 'tomorrow' : 'the start';
    return (
      <Card accessibilityLabel={`${goal}. ${timing}. You joined after this round opened; you are in from ${next}.`}>
        <Text variant="headline">{goal}</Text>
        <Text variant="subheadline" color="secondary">
          {timing}
        </Text>
        <Text variant="footnote" color="secondary">
          You joined after this round opened, so it doesn't count for or against you. You're in from {next}. Sync your runs any time; they count from then.
        </Text>
      </Card>
    );
  }

  if (myValue === null) {
    return (
      <Card accessibilityLabel={`${goal}. ${timing}. You are not in this challenge yet.`}>
        <Text variant="headline">{goal}</Text>
        <Text variant="subheadline" color="secondary">
          {timing}
        </Text>
        <Text variant="footnote" color="secondary">
          Join and your runs sync from Apple Health or Strava. Miss the goal and your pledge goes to the pool for the friends who made it.
        </Text>
        {onJoin ? <Button title="Join this challenge" onPress={onJoin} loading={joining} style={styles.action} accessibilityHint="Joins without a place; asks to read your workouts" /> : null}
      </Card>
    );
  }

  const goalNumber = Number(pact.goal_value ?? 0);
  const fraction = progressFraction(myValue, goalNumber);
  const closed = instance ? Date.parse(instance.deadline_at) <= nowMs : false;
  const left = remainingText(pact, myValue, unit);
  // the timing line below carries the time left, so this line is only the distance to the goal
  const detail = left === null ? (closed ? 'Reached' : `Reached · nothing more to do this ${pact.period === 'weekly' ? 'week' : pact.period === 'once' ? 'race' : 'day'}`) : closed ? `${left} short` : `${left} to go`;
  const ringColor = myReached || left === null ? 'success' : closed ? 'forfeit' : 'tint';
  const a11y = `${formatGoalValue(pact, myValue, unit)}. ${detail}. ${timing}`;

  return (
    <Card accessibilityLabel={a11y}>
      <View style={styles.row}>
        <ProgressRing size={96} strokeWidth={8} progress={fraction} color={ringColor} accessibilityLabel={`${Math.round(fraction * 100)} percent of the goal`}>
          <Text variant="title3" tabular>
            {Math.round(fraction * 100)}%
          </Text>
        </ProgressRing>
        <View style={styles.text}>
          <Text variant="title3" tabular>
            {formatGoalValue(pact, myValue, unit)}
          </Text>
          <Text variant="subheadline" color={closed && left !== null ? 'forfeit' : 'secondary'} tabular>
            {detail}
          </Text>
          <Text variant="footnote" color="secondary">
            {timing}
          </Text>
          {myResult ? <StatusPill state={myResult} who="Your result" size="compact" style={styles.pill} /> : left === null && !closed ? <Pill label="Reached" tone="success" size="compact" style={styles.pill} /> : null}
        </View>
      </View>
      {pact.kind === 'custom' && onMarkDone && !closed && left !== null ? (
        <Button
          title={`${pact.period === 'weekly' ? 'Mark this week done' : 'Mark today done'}${pact.proof_required ? ' with a photo' : ''}`}
          onPress={onMarkDone}
          loading={marking}
          style={styles.action}
          accessibilityHint={pact.proof_required ? 'Picks a photo from your library, then counts as done; friends can challenge it' : 'Counts as done; friends can challenge it'}
        />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  text: { flex: 1, gap: space.xxs },
  pill: { alignSelf: 'flex-start', marginTop: space.xs },
  action: { marginTop: space.xs },
});

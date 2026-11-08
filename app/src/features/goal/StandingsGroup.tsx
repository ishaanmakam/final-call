import { StyleSheet, View } from 'react-native';
import { toNumber, type InstanceStandingRow, type PactRow, type ResultRow } from '../../api/types';
import { Avatar, ListGroup, ListRow, Pill, StatusPill, Text } from '../../components';
import { space } from '../../theme';
import { formatGoalValue, formatValue, ordinal, progressFraction, rankLine, remainingText, type DistanceUnit } from './goal';
import { ProgressBar } from './ProgressBar';

export interface StandingsGroupProps {
  pact: PactRow;
  standings: readonly InstanceStandingRow[];
  /** participants with no progress row yet (nothing logged) */
  participantIds: readonly string[];
  /** posted results, once the gate closed */
  results: readonly ResultRow[];
  userId: string;
  nameOf: (id: string) => string;
  unit: DistanceUnit;
  /** per person, a trailing streak line ("3 wk streak") when known */
  streakLine?: (id: string) => string | null;
  closed: boolean;
  header?: string;
  footer?: string;
}

/**
 * The ranked list: avatar, name, "1st · 3 runs · reached Thu" under it, the value and a thin
 * progress bar on the right, a Reached pill once over the line. After the gate closes the posted
 * result replaces the pill.
 */
export function StandingsGroup({ pact, standings, participantIds, results, userId, nameOf, unit, streakLine, closed, header, footer }: StandingsGroupProps) {
  const ranked = [...standings].sort((a, b) => a.rank - b.rank);
  const missing = participantIds.filter((id) => !ranked.some((s) => s.user_id === id));
  const total = ranked.length + missing.length;
  const mine = ranked.find((s) => s.user_id === userId);
  const title = header ?? (mine ? `Standings · ${rankLine(mine.rank, total)}` : 'Standings');
  const resultFor = (id: string) => results.find((r) => r.user_id === id)?.status ?? null;

  return (
    <ListGroup header={title} footer={footer}>
      {ranked.map((s) => {
        const value = toNumber(s.value);
        const goal = toNumber(s.goal);
        const reached = s.reached_at !== null || (goal > 0 && value >= goal);
        const left = remainingText(pact, value, unit);
        const result = resultFor(s.user_id);
        const name = nameOf(s.user_id);
        const streak = streakLine?.(s.user_id) ?? null;
        // once the gate closed there is nothing left "to go": the gap is what they were short by
        const gap = left ? (closed ? `${left} short` : `${left} to go`) : null;
        const subtitle = [ordinal(s.rank), reached ? 'reached' : gap, streak].filter(Boolean).join(' · ');
        return (
          <ListRow
            key={s.user_id}
            leading={<Avatar person={{ id: s.user_id, name }} highlighted={s.user_id === userId} />}
            title={name}
            subtitle={subtitle}
            trailing={
              <View style={styles.trailing}>
                <View style={styles.valueRow}>
                  {result && closed ? (
                    result === 'success' ? (
                      <Pill label="Made it" tone="success" size="compact" />
                    ) : (
                      <StatusPill state={result} size="compact" />
                    )
                  ) : reached ? (
                    <Pill label="Reached" tone="success" size="compact" />
                  ) : null}
                  <Text variant="subheadline" emphasis tabular color={reached ? 'success' : 'label'}>
                    {formatValue(pact, value, unit)}
                  </Text>
                </View>
                <ProgressBar fraction={progressFraction(value, goal)} color={reached ? 'success' : closed ? 'forfeit' : 'tint'} />
              </View>
            }
            accessibilityLabel={`${name}, ${ordinal(s.rank)}, ${formatGoalValue(pact, value, unit)}${reached ? ', reached' : gap ? `, ${gap}` : ''}${result ? `, ${result}` : ''}`}
          />
        );
      })}
      {missing.map((id) => {
        // the view has a row for every roster member, so a participant without one joined after this round opened (CA-9)
        const name = nameOf(id);
        const result = resultFor(id);
        return (
          <ListRow
            key={id}
            leading={<Avatar person={{ id, name }} highlighted={id === userId} />}
            title={name}
            subtitle={result === 'frozen' ? 'Frozen this round' : closed ? 'Not in this round' : 'In from the next round'}
            trailing={result && closed ? result === 'success' ? <Pill label="Made it" tone="success" size="compact" /> : <StatusPill state={result} size="compact" /> : undefined}
            disabled={!result}
          />
        );
      })}
      {total === 0 ? <ListRow title="Nobody is in this challenge yet" subtitle="Friends join from the group." disabled /> : null}
    </ListGroup>
  );
}

const styles = StyleSheet.create({
  trailing: { alignItems: 'flex-end', gap: space.xs },
  valueRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});

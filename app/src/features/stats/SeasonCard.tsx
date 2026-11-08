import { StyleSheet, View } from 'react-native';
import type { PactRow, PactSeasonRecapRow, PactStreakRow } from '../../api/types';
import { Avatar, ListGroup, ListRow, ProgressRing, Text } from '../../components';
import { formatCents } from '../../lib/money';
import { localDateInZone } from '../../lib/time';
import { nowMs } from '../../lib/useNow';
import { space, useTheme } from '../../theme';
import { longestStreak, memberRecapLine, netTone, recapSentence, sortRecaps } from './recap';
import { seasonOf, seasonProgress, seasonProgressLine, seasonShortLabel } from './season';

export interface SeasonCardProps {
  pact: PactRow;
  recaps: readonly PactSeasonRecapRow[];
  streaks: readonly PactStreakRow[];
  userId: string;
  nameOf: (id: string) => string;
  /** current members only; recap rows of people who left are kept but listed last */
  memberIds?: ReadonlySet<string>;
}

/**
 * One pact's season: the ring and the finish line on top, a row per member (days showed up, net),
 * and the recap sentence as the footer. Renders nothing when the pact has no season.
 */
export function SeasonCard({ pact, recaps, streaks, userId, nameOf, memberIds }: SeasonCardProps) {
  const { colors } = useTheme();
  const season = seasonOf(pact);
  if (!season) return null;
  const progress = seasonProgress(season, localDateInZone(nowMs(), pact.tz));
  const finished = progress.phase === 'finished';
  const rows = sortRecaps(
    recaps.filter((r) => r.pact_id === pact.id),
    nameOf,
  ).sort((a, b) => Number(memberIds ? !memberIds.has(a.user_id) : false) - Number(memberIds ? !memberIds.has(b.user_id) : false));
  const mine = rows.find((r) => r.user_id === userId) ?? null;
  const longest = longestStreak(
    streaks.filter((s) => s.pact_id === pact.id),
    nameOf,
  );
  const label = seasonShortLabel(progress, season.start);
  const line = seasonProgressLine(progress, season.start);

  return (
    <ListGroup footer={rows.length > 0 ? recapSentence(mine, longest, finished, userId) : 'The recap fills in as days close.'}>
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={`${pact.title}, ${label}, ${line}`}
        style={[styles.head, { backgroundColor: colors.surface, borderBottomColor: colors.separator }]}
      >
        <ProgressRing progress={progress.fraction} size={44} strokeWidth={4} animate="step" color={finished ? 'success' : 'tint'}>
          <Text variant="caption1" emphasis tabular maxFontSizeMultiplier={1}>
            {progress.phase === 'upcoming' ? '0' : `${progress.week}`}/{progress.weeks}
          </Text>
        </ProgressRing>
        <View style={styles.headText}>
          <Text variant="headline" numberOfLines={1}>
            {pact.title}
          </Text>
          <Text variant="subheadline" color="secondary" numberOfLines={2}>
            {line}
          </Text>
        </View>
      </View>
      {rows.map((r) => {
        const name = nameOf(r.user_id);
        const net = formatCents(r.net_cents, { signed: true });
        return (
          <ListRow
            key={r.user_id}
            leading={<Avatar person={{ id: r.user_id, name }} size={32} highlighted={r.user_id === userId} />}
            title={name}
            subtitle={memberRecapLine(r)}
            trailing={
              <Text variant="body" color={netTone(r.net_cents)} tabular emphasis={r.net_cents !== 0}>
                {r.net_cents === 0 ? 'even' : net}
              </Text>
            }
            accessibilityLabel={`${name}, ${memberRecapLine(r)}, ${r.net_cents === 0 ? 'even' : net}`}
          />
        );
      })}
    </ListGroup>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headText: { flex: 1, gap: 1 },
});

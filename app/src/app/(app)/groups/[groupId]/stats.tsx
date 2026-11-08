import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { displayName } from '@/api/queries';
import { useGroupStats } from '@/api/statsQueries';
import { Avatar, EmptyState, ListGroup, ListRow, Screen, SkeletonCard, Text } from '@/components';
import { COMPLETION_FOOTNOTE, completionHeadline, completionLine, completionTone, weeksLine } from '@/features/stats/completion';
import { SeasonCard } from '@/features/stats/SeasonCard';
import { seasonOf } from '@/features/stats/season';
import { sortStreaks, streakAccessibilityLabel } from '@/features/stats/streak';
import { useUserId } from '@/lib/auth';
import { classifyRpcError, userMessage } from '@/lib/errors';
import { space, useTheme } from '@/theme';

export default function GroupStats() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const userId = useUserId();
  const stats = useGroupStats(groupId);
  const { colors } = useTheme();

  if (stats.isPending) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Stats' }} />
        <SkeletonCard lines={2} />
        <SkeletonCard lines={4} />
        <SkeletonCard lines={3} />
      </Screen>
    );
  }
  if (stats.isError) {
    const offline = classifyRpcError(stats.error) === 'network';
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Stats' }} />
        <EmptyState
          layout="screen"
          icon={offline ? 'wifi.slash' : 'exclamationmark.triangle'}
          title={offline ? "You're offline" : "Couldn't load stats"}
          body={offline ? 'Stats appear once you have a connection.' : userMessage(stats.error)}
          action={{ label: 'Try again', onPress: () => void stats.refetch(), loading: stats.isFetching }}
        />
      </Screen>
    );
  }

  const { stats: completion, pacts, members, profiles, recaps, streaks, hasClosedDays } = stats.data;
  const nameOf = (id: string) => (id === userId ? 'You' : displayName(profiles, id));
  const memberIds = new Set(members.map((m) => m.user_id));
  const seasonPacts = pacts.filter((p) => seasonOf(p) !== null);
  const streakPacts = pacts
    .map((pact) => ({ pact, rows: sortStreaks(streaks.filter((s) => s.pact_id === pact.id && memberIds.has(s.user_id)), nameOf) }))
    .filter((x) => x.rows.length > 0);
  const tone = completion ? completionTone(completion) : 'pending';

  return (
    <Screen refreshing={stats.isRefetching} onRefresh={() => void stats.refetch()}>
      <Stack.Screen options={{ title: 'Stats' }} />

      <ListGroup header="Settle-up completion" footer={COMPLETION_FOOTNOTE}>
        <View
          accessible
          accessibilityRole="summary"
          accessibilityLabel={completion ? `Settle-up completion ${completionHeadline(completion)}. ${completionLine(completion)}. ${weeksLine(completion)}` : 'Settle-up completion unavailable'}
          style={[styles.hero, { backgroundColor: colors.surface }]}
        >
          <Text variant="largeTitle" color={tone === 'pending' ? 'secondary' : tone} tabular>
            {completion ? completionHeadline(completion) : '—'}
          </Text>
          <View style={styles.heroText}>
            <Text variant="body">{completion ? completionLine(completion) : 'Stats are for members only'}</Text>
            {completion ? (
              <Text variant="subheadline" color="secondary">
                {weeksLine(completion)}
              </Text>
            ) : null}
          </View>
        </View>
      </ListGroup>

      {!hasClosedDays ? (
        <EmptyState
          icon="chart.bar"
          title="No closed days yet"
          body="Streaks and season recaps appear after the first deadline passes. Settle-up completion fills in after the first Monday settle-up."
        />
      ) : null}

      {seasonPacts.length > 0 ? <SectionHeader title={seasonPacts.length === 1 ? 'Season' : 'Seasons'} /> : null}
      {seasonPacts.map((pact) => (
        <SeasonCard key={pact.id} pact={pact} recaps={recaps} streaks={streaks} userId={userId} nameOf={nameOf} memberIds={memberIds} />
      ))}

      {streakPacts.length > 0 ? <SectionHeader title="Streaks" /> : null}
      {streakPacts.map(({ pact, rows }) => (
        <ListGroup key={pact.id} header={pact.title}>
          {rows.map((r) => {
            const name = nameOf(r.user_id);
            return (
              <ListRow
                key={r.user_id}
                leading={<Avatar person={{ id: r.user_id, name }} size={32} highlighted={r.user_id === userId} />}
                title={name}
                subtitle={r.best_streak > r.current_streak ? `Best ${r.best_streak}` : undefined}
                trailing={
                  <Text variant="body" color={r.current_streak > 0 ? 'label' : 'secondary'} tabular emphasis={r.current_streak >= 3}>
                    {r.current_streak > 0 ? `${r.current_streak} in a row` : 'No streak'}
                  </Text>
                }
                accessibilityLabel={streakAccessibilityLabel(name, r.current_streak, r.best_streak)}
              />
            );
          })}
        </ListGroup>
      ))}
      {hasClosedDays && streakPacts.length > 0 ? (
        <Text variant="footnote" color="secondary" style={styles.note}>
          A streak is days in a row showed up. A frozen day leaves it where it is; a missed or unverified day ends it.
        </Text>
      ) : null}
    </Screen>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <Text variant="footnote" color="secondary" style={styles.sectionHeader}>
      {title}
    </Text>
  );
}

const styles = StyleSheet.create({
  hero: { flexDirection: 'row', alignItems: 'center', gap: space.lg, paddingHorizontal: space.lg, paddingVertical: space.lg },
  heroText: { flex: 1, gap: space.xxs },
  sectionHeader: { paddingHorizontal: space.lg, marginTop: space.md, marginBottom: -space.sm },
  note: { paddingHorizontal: space.lg },
});

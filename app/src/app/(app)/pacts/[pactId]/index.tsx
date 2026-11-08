import { useQueryClient } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Platform, StyleSheet, Switch, View } from 'react-native';
import { displayName, useGroupHome, usePactDetail } from '@/api/queries';
import { declareFreeze, setPactPaused, setPactSeason } from '@/api/rpc';
import { seasonInvalidationKeys, usePactStats } from '@/api/statsQueries';
import type { PactInstanceRow } from '@/api/types';
import {
  Avatar,
  Button,
  EmptyState,
  Icon,
  ListGroup,
  ListRow,
  Pill,
  ProgressRing,
  Screen,
  SkeletonCard,
  StatusPill,
  Text,
  useToast,
} from '@/components';
import { ObjectionSheet, PlaceStatusBlock, type ObjectionTarget } from '@/features/place/PlaceGate';
import { PLACE_RULE_CHANGE, placeLine, placePill, placeStatusLine } from '@/features/place/placeCopy';
import { timeZoneDisplayName } from '@/features/shared/timeZones';
import { longestStreak, recapSentence } from '@/features/stats/recap';
import { formatLocalDay, seasonDetailLine, seasonOf, seasonProgress, seasonProgressLine, seasonShortLabel, type Season } from '@/features/stats/season';
import { SeasonSheet } from '@/features/stats/SeasonSheet';
import { streakFor, streakLine } from '@/features/stats/streak';
import { useUserId } from '@/lib/auth';
import { userMessage } from '@/lib/errors';
import { formatCents } from '@/lib/money';
import { memberPlaces, nearestOtherM } from '@/lib/places';
import { describeDays, deviceTimeZone, displayTimeOfDay, formatDateInZone, formatTimeInZone, localDateInZone, windowState } from '@/lib/time';
import { useNow } from '@/lib/useNow';
import { haptic, useTheme } from '@/theme';

export default function PactDetail() {
  const { pactId } = useLocalSearchParams<{ pactId: string }>();
  const userId = useUserId();
  const detail = usePactDetail(pactId, userId);
  const qc = useQueryClient();
  const toast = useToast();
  const { colors } = useTheme();
  const now = useNow(30_000);
  const [pausing, setPausing] = useState(false);
  const [freezing, setFreezing] = useState<string | null>(null);
  const [objecting, setObjecting] = useState<ObjectionTarget | null>(null);
  const [objectOpen, setObjectOpen] = useState(false);
  const [seasonOpen, setSeasonOpen] = useState(false);
  const [endingSeason, setEndingSeason] = useState(false);
  const pactStats = usePactStats(pactId);

  const groupId = detail.data?.pact.group_id ?? '';
  const home = useGroupHome(groupId, userId, groupId.length > 0);
  const amIn = detail.data?.participants.some((p) => p.user_id === userId) ?? false;

  if (detail.isPending) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Pact' }} />
        <SkeletonCard lines={3} />
        <SkeletonCard lines={4} />
        <SkeletonCard lines={3} />
      </Screen>
    );
  }
  if (detail.isError) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Pact' }} />
        <EmptyState
          layout="screen"
          icon="exclamationmark.triangle"
          title="Couldn't load this pact"
          body={userMessage(detail.error)}
          action={{ label: 'Try again', onPress: () => void detail.refetch() }}
        />
      </Screen>
    );
  }

  const { pact, participants, profiles, upcoming, myFreezes, places, distances } = detail.data;
  const frozenIds = new Set(myFreezes.map((f) => f.instance_id));
  const mine = participants.find((p) => p.user_id === userId);
  const members = home.data?.members ?? [];
  const memberProfiles = home.data?.profiles ?? profiles;
  const myRole = members.find((m) => m.user_id === userId)?.role;
  const canPause = pact.created_by === userId || myRole === 'owner';
  const deviceZone = deviceTimeZone();
  const nameOf = (id: string) => (id === userId ? 'You' : displayName(memberProfiles, id));
  const namer = { userId, nameOf };
  const notJoined = members.filter((m) => !participants.some((p) => p.user_id === m.user_id));
  const myPlaces = memberPlaces(places, userId);
  const myStatus = placeStatusLine(myPlaces, namer, pact.tz, myPlaces.pending ? nearestOtherM(distances, myPlaces.pending.place_id) : null);

  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: ['pact', pactId] }), qc.invalidateQueries({ queryKey: ['group', pact.group_id] })]);

  const togglePause = async (paused: boolean) => {
    setPausing(true);
    haptic('commit');
    try {
      await setPactPaused(pactId, paused);
      await refresh();
      toast.show({ message: paused ? 'Pact paused. Upcoming days are skipped until you resume.' : 'Pact resumed.', tone: 'neutral', icon: paused ? 'minus.circle' : 'checkmark' });
    } catch (e) {
      toast.show({ message: userMessage(e), tone: 'forfeit', icon: 'exclamationmark.triangle' });
      haptic('error');
    } finally {
      setPausing(false);
    }
  };

  const freeze = (inst: PactInstanceRow) => {
    const day = formatDateInZone(inst.deadline_at, pact.tz);
    Alert.alert(`Freeze ${day}?`, "That day won't count for or against you. You have one freeze per week for this pact.", [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Freeze',
        onPress: () => {
          setFreezing(inst.id);
          haptic('commit');
          declareFreeze(inst.id)
            .then(async () => {
              await Promise.all([refresh(), qc.invalidateQueries({ queryKey: ['instance', inst.id] })]);
              toast.show({ message: `${day} is frozen. It counts for nothing either way.`, tone: 'frozen', icon: 'snowflake' });
            })
            .catch((e: unknown) => {
              toast.show({ message: userMessage(e), tone: 'forfeit', icon: 'exclamationmark.triangle' });
              haptic('error');
            })
            .finally(() => setFreezing(null));
        },
      },
    ]);
  };

  const openObjection = (t: ObjectionTarget) => {
    setObjecting(t);
    setObjectOpen(true);
  };

  const window = `${displayTimeOfDay(pact.window_open_local)} to ${displayTimeOfDay(pact.deadline_local)}`;
  const myCurrent = myPlaces.current;

  // Season (Q2): owner or creator starts / ends it; everyone sees the progress and the recap line.
  const season = seasonOf(pact);
  const progress = season ? seasonProgress(season, localDateInZone(now, pact.tz)) : null;
  const streaks = pactStats.data?.streaks ?? [];
  const recaps = pactStats.data?.recaps ?? [];
  const seasonFooter =
    season && progress
      ? recaps.length > 0
        ? recapSentence(recaps.find((r) => r.user_id === userId) ?? null, longestStreak(streaks, nameOf), progress.phase === 'finished', userId)
        : progress.phase === 'upcoming'
          ? `Days from ${formatLocalDay(season.start)} count. At the finish line everyone sees who showed up most and who came out ahead.`
          : 'The recap fills in as days close.'
      : 'Four weeks with a finish line: at the end everyone sees who showed up most, who had the longest streak and who came out ahead.';
  const refreshSeason = () => Promise.all(seasonInvalidationKeys(pactId, pact.group_id).map((queryKey) => qc.invalidateQueries({ queryKey })));
  const startSeason = async (s: Season) => {
    await setPactSeason(pactId, s.start, s.weeks);
    await refreshSeason();
    toast.show({ message: `Season on. Finish line ${formatLocalDay(seasonProgress(s, s.start).finishLine)}.`, tone: 'success', icon: 'flag.checkered' });
  };
  const confirmEndSeason = () =>
    Alert.alert('End this season?', 'The recap so far stays in Stats until a new season starts. Days keep counting as usual.', [
      { text: 'Keep going', style: 'cancel' },
      {
        text: 'End season',
        style: 'destructive',
        onPress: () => {
          setEndingSeason(true);
          haptic('commit');
          setPactSeason(pactId, null, null)
            .then(refreshSeason)
            .then(() => toast.show({ message: 'Season ended.', tone: 'neutral', icon: 'flag.checkered' }))
            .catch((e: unknown) => {
              toast.show({ message: userMessage(e), tone: 'forfeit', icon: 'exclamationmark.triangle' });
              haptic('error');
            })
            .finally(() => setEndingSeason(false));
        },
      },
    ]);

  return (
    <View style={styles.root}>
      <Screen refreshing={detail.isRefetching} onRefresh={() => void detail.refetch()}>
        <Stack.Screen options={{ title: pact.title }} />

        <ListGroup header="Schedule" footer={pact.tz !== deviceZone ? `Times follow ${timeZoneDisplayName(pact.tz)}.` : undefined}>
          <ListRow title="Days" trailing={<Value>{describeDays(pact.days_of_week)}</Value>} />
          <ListRow title="Check-in window" trailing={<Value tabular>{window}</Value>} />
          {pact.tz !== deviceZone ? <ListRow title="Time zone" trailing={<Value>{timeZoneDisplayName(pact.tz)}</Value>} /> : null}
        </ListGroup>

        <ListGroup
          header="Pledge"
          footer="Forfeited to the pool on a day you miss; show up and you split the pool with the others who did. Unverified days never cost anything."
        >
          <ListRow title="Per missed day" trailing={<Value tabular>{formatCents(pact.stake_cents)}</Value>} />
        </ListGroup>

        {season && progress ? (
          <ListGroup header="Season" footer={seasonFooter}>
            <ListRow
              leading={
                <ProgressRing progress={progress.fraction} size={32} strokeWidth={3} animate="step" color={progress.phase === 'finished' ? 'success' : 'tint'} />
              }
              title={seasonShortLabel(progress, season.start)}
              subtitle={seasonDetailLine(progress)}
              chevron
              onPress={() => router.push(`/groups/${pact.group_id}/stats`)}
              accessibilityLabel={`Season: ${seasonShortLabel(progress, season.start)}, ${seasonProgressLine(progress, season.start)}`}
              accessibilityHint="Opens the group's stats"
            />
            {canPause ? (
              <ListRow
                title="End season"
                trailing={<Value color="tint">{endingSeason ? 'Ending' : 'End'}</Value>}
                disabled={endingSeason}
                onPress={confirmEndSeason}
                accessibilityHint="Asks you to confirm"
              />
            ) : null}
          </ListGroup>
        ) : canPause ? (
          <ListGroup header="Season" footer={seasonFooter}>
            <ListRow
              leading={<Icon name="flag.checkered" size={20} color="tint" />}
              title="Start a 4-week season"
              chevron
              onPress={() => setSeasonOpen(true)}
              accessibilityHint="Opens the season sheet"
            />
          </ListGroup>
        ) : null}

        {canPause || pact.paused ? (
          <ListGroup footer="Paused pacts skip their days until resumed. Days already in progress still count.">
            {canPause ? (
              <ListRow
                title="Paused"
                trailing={
                  <Switch
                    value={pact.paused}
                    disabled={pausing}
                    onValueChange={(v) => void togglePause(v)}
                    accessibilityLabel="Pause this pact"
                    trackColor={{ true: colors.tint }}
                    ios_backgroundColor={colors.fillStrong}
                    // iOS keeps its white thumb; react-native-web paints its active thumb teal
                    {...(Platform.OS === 'web' ? { thumbColor: colors.surfaceElevated, activeThumbColor: colors.surfaceElevated } : {})}
                  />
                }
              />
            ) : (
              <ListRow title="Paused" trailing={<Pill label="Paused" tone="void" size="compact" />} />
            )}
          </ListGroup>
        ) : null}

        {mine ? (
          <ListGroup header="Your place" footer={myStatus ?? PLACE_RULE_CHANGE}>
            <ListRow
              title={myCurrent?.label ?? mine.place_label ?? 'Your place'}
              subtitle={
                myCurrent
                  ? `${myCurrent.radius_m} m circle${nearestOtherM(distances, myCurrent.place_id) !== null ? ` · ${placeLine(myCurrent, nearestOtherM(distances, myCurrent.place_id)).split(' · ').slice(2).join(' · ')}` : ''}`
                  : 'No place counts right now'
              }
              trailing={<Value>Change</Value>}
              chevron
              onPress={() => router.push(`/pacts/${pactId}/place`)}
              accessibilityLabel={`Your place: ${myCurrent?.label ?? mine.place_label ?? 'set'}, ${myCurrent?.radius_m ?? mine.place_radius_m} metre circle`}
              accessibilityHint="Opens the place picker"
            />
          </ListGroup>
        ) : (
          <ListGroup footer="You're not in this pact yet. Each person sets their own place; yours can be a different building. Your friends see it and how far it is from theirs.">
            <ListRow
              title="Set my place and join"
              trailing={<Value color="tint">Join</Value>}
              chevron
              onPress={() => router.push(`/pacts/${pactId}/place`)}
              accessibilityHint="Opens the place picker"
            />
          </ListGroup>
        )}

        <ListGroup
          header={members.length > 0 ? `Who's in · ${participants.length} of ${members.length}` : "Who's in"}
          footer={
            notJoined.length > 0
              ? `${notJoined.length === 1 ? '1 person has' : `${notJoined.length} people have`} not set a place yet.`
              : participants.length > 1
                ? 'Everyone sees every place. A moved place counts once a friend confirms it, or after 24 hours if nobody objects.'
                : undefined
          }
        >
          {participants.flatMap((p, index) => {
            const mp = memberPlaces(places, p.user_id);
            const nearest = mp.current ? nearestOtherM(distances, mp.current.place_id) : null;
            const pill = placePill(mp);
            const status = placeStatusLine(mp, namer, pact.tz, mp.pending ? nearestOtherM(distances, mp.pending.place_id) : null);
            const line = placeLine(mp.current, nearest);
            const streak = streakFor(streaks, p.user_id);
            const streakText = streakLine(streak.current_streak, streak.best_streak);
            const lastPerson = index === participants.length - 1 && notJoined.length === 0;
            const rows = [
              <ListRow
                key={p.user_id}
                title={nameOf(p.user_id)}
                subtitle={line}
                leading={<Avatar person={{ id: p.user_id, name: nameOf(p.user_id) }} highlighted={p.user_id === userId} />}
                trailing={
                  streakText ? (
                    <Text variant="subheadline" color={streak.current_streak > 0 ? 'label' : 'secondary'} tabular numberOfLines={1}>
                      {streakText}
                    </Text>
                  ) : undefined
                }
                accessibilityLabel={`${nameOf(p.user_id)}, ${line}${streakText ? `, ${streakText}` : ''}`}
              />,
            ];
            if (status) {
              rows.push(
                <PlaceStatusBlock
                  key={`${p.user_id}-status`}
                  text={status}
                  pill={pill}
                  place={mp.pending}
                  userId={userId}
                  ownerName={displayName(memberProfiles, p.user_id)}
                  onObject={openObjection}
                  onChanged={refresh}
                  last={lastPerson}
                />,
              );
            }
            return rows;
          })}
          {notJoined.map((m) => (
            <ListRow
              key={m.user_id}
              title={nameOf(m.user_id)}
              subtitle="No place yet"
              leading={<Avatar person={{ id: m.user_id, name: nameOf(m.user_id) }} />}
              disabled
            />
          ))}
          {participants.length === 0 && notJoined.length === 0 ? (
            <ListRow title="Nobody has set a place yet" subtitle="Each person joins by setting their own place." />
          ) : null}
        </ListGroup>

        <ListGroup
          header="Upcoming"
          footer={
            amIn
              ? "A freeze means a day doesn't count for or against you. One per week per pact, declared before the window opens."
              : undefined
          }
        >
          {upcoming.length === 0 ? (
            <View style={{ backgroundColor: colors.surface }}>
              <EmptyState icon="clock" title="Nothing scheduled yet" body="Days appear here up to a week ahead." />
            </View>
          ) : null}
          {upcoming.map((inst) => {
            const state = windowState(now, inst.window_open_at, inst.deadline_at);
            const frozen = frozenIds.has(inst.id);
            const voided = inst.status === 'voided';
            const open = state === 'open' && !voided;
            const canFreeze = amIn && state === 'before' && !frozen && inst.status === 'scheduled';
            const day = formatDateInZone(inst.deadline_at, pact.tz);
            return (
              <ListRow
                key={inst.id}
                title={day}
                subtitle={`by ${formatTimeInZone(inst.deadline_at, pact.tz)}`}
                trailing={
                  frozen ? (
                    <StatusPill state="frozen" size="compact" />
                  ) : voided ? (
                    <StatusPill state="void" size="compact" />
                  ) : state === 'closed' ? (
                    <Pill label="Closed" tone="pending" size="compact" />
                  ) : open ? (
                    <Pill label="Open now" tone="tint" size="compact" />
                  ) : canFreeze ? (
                    <Button
                      title="Freeze"
                      variant="tertiary"
                      size="small"
                      onPress={() => freeze(inst)}
                      loading={freezing === inst.id}
                      accessibilityLabel={`Freeze ${day}`}
                      accessibilityHint="That day won't count for or against you"
                    />
                  ) : undefined
                }
                chevron={open && amIn}
                onPress={open && amIn ? () => router.push(`/checkin/${inst.id}`) : undefined}
                accessibilityLabel={`${day}, by ${formatTimeInZone(inst.deadline_at, pact.tz)}${frozen ? ', frozen' : voided ? ", didn't count" : open ? ', open now' : ''}`}
                accessibilityHint={open && amIn ? 'Opens check-in' : undefined}
              />
            );
          })}
        </ListGroup>
      </Screen>
      <SeasonSheet open={seasonOpen} onClose={() => setSeasonOpen(false)} pactTitle={pact.title} tz={pact.tz} onStart={startSeason} />
      <ObjectionSheet
        target={objecting}
        open={objectOpen}
        onClose={() => setObjectOpen(false)}
        onDone={(t) => {
          setObjectOpen(false);
          void refresh();
          toast.show({ message: `Objection sent. ${t.ownerName} has to set a new place.`, icon: 'location' });
        }}
      />
    </View>
  );
}

function Value({ children, tabular, color = 'secondary' }: { children: string; tabular?: boolean; color?: 'secondary' | 'tint' }) {
  return (
    <Text variant="body" color={color} tabular={tabular} numberOfLines={1}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});

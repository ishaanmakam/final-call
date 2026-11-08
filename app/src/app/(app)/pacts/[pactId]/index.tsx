import { useQueryClient } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Platform, StyleSheet, Switch, View } from 'react-native';
import { DEMO } from '@/api/demo/settings';
import { displayName, useGroupHome, usePactDetail } from '@/api/queries';
import { declareFreeze, joinPact, markDone, setPactPaused, setPactSeason } from '@/api/rpc';
import { seasonInvalidationKeys, usePactStats } from '@/api/statsQueries';
import { toNumber, type PactActivityRow, type PactInstanceRow } from '@/api/types';
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
import { gateClose } from '@/features/checkin/gateClose';
import { GateCloseCard } from '@/features/checkin/GateCloseCard';
import { ReviewSheet, type ReviewSheetTarget } from '@/features/feed/ReviewSheet';
import { ActivityGroup } from '@/features/goal/ActivityGroup';
import { activityTypeLabel, goalLabel, isGoalKind } from '@/features/goal/goal';
import { GoalHeader } from '@/features/goal/GoalHeader';
import { StandingsGroup } from '@/features/goal/StandingsGroup';
import { useDistanceUnit } from '@/features/goal/useDistanceUnit';
import { syncToast } from '@/features/health/health';
import { ensureHealthPermission, healthStatus, lastHealthSyncAt, lastHealthSyncCount, syncHealth, syncRowSubtitle } from '@/features/health/healthRuntime';
import { startStravaConnect, stravaReturnMessage, useStravaStatus } from '@/features/integrations/strava';
import { ObjectionSheet, PlaceStatusBlock, type ObjectionTarget } from '@/features/place/PlaceGate';
import { PLACE_RULE_CHANGE, placeLine, placePill, placeStatusLine } from '@/features/place/placeCopy';
import { timeZoneDisplayName } from '@/features/shared/timeZones';
import { longestStreak, recapSentence } from '@/features/stats/recap';
import { formatLocalDay, seasonDetailLine, seasonOf, seasonProgress, seasonProgressLine, seasonShortLabel, type Season } from '@/features/stats/season';
import { SeasonSheet } from '@/features/stats/SeasonSheet';
import { streakFor, streakLine } from '@/features/stats/streak';
import { useUserId } from '@/lib/auth';
import { userMessage } from '@/lib/errors';
import { pickEvidencePhoto, uploadEvidencePhoto } from '@/lib/reviewPhoto';
import { formatCents } from '@/lib/money';
import { memberPlaces, nearestOtherM } from '@/lib/places';
import { describeDays, deviceTimeZone, displayTimeOfDay, formatDateInZone, formatLocalDateShort, formatTimeInZone, localDateInZone, windowState } from '@/lib/time';
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
  const unit = useDistanceUnit();
  const [pausing, setPausing] = useState(false);
  const [freezing, setFreezing] = useState<string | null>(null);
  const [objecting, setObjecting] = useState<ObjectionTarget | null>(null);
  const [objectOpen, setObjectOpen] = useState(false);
  const [seasonOpen, setSeasonOpen] = useState(false);
  const [endingSeason, setEndingSeason] = useState(false);
  // goal kinds (CB)
  const [joining, setJoining] = useState(false);
  const [marking, setMarking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<{ at: number | null; count: number | null }>({ at: null, count: null });
  const strava = useStravaStatus();
  const [reviewTarget, setReviewTarget] = useState<ReviewSheetTarget | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const pactStats = usePactStats(pactId);

  const groupId = detail.data?.pact.group_id ?? '';
  const home = useGroupHome(groupId, userId, groupId.length > 0);
  const amIn = detail.data?.participants.some((p) => p.user_id === userId) ?? false;
  const goalKind = detail.data ? isGoalKind(detail.data.pact.kind) : false;

  useEffect(() => {
    if (!goalKind) return;
    let live = true;
    void Promise.all([lastHealthSyncAt(), lastHealthSyncCount()]).then(([at, count]) => live && setLastSync({ at, count }));
    return () => {
      live = false;
    };
  }, [goalKind]);

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

  const { pact, participants, profiles, upcoming, myFreezes, places, distances, goal } = detail.data;
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

  // ---------- goal kinds (CB): progress, standings, evidence ----------

  const current = goal?.current ?? null;
  const currentProgress = goal && current ? goal.progress.filter((p) => p.instance_id === current.id) : [];
  const currentStandings = goal && current ? goal.standings.filter((s) => s.instance_id === current.id) : [];
  const currentResults = goal && current ? goal.results.filter((r) => r.instance_id === current.id) : [];
  const myProgress = currentProgress.find((p) => p.user_id === userId) ?? null;
  const myValue = amIn ? toNumber(myProgress?.value ?? 0) : null;
  // the view has a row per roster member: in the pact without one means joined after this round opened (CA-9)
  const notOnRoster = amIn && current !== null && myProgress === null && !currentResults.some((r) => r.user_id === userId);
  const myReached = myProgress ? myProgress.reached_at !== null || toNumber(myProgress.value) >= toNumber(myProgress.goal) : false;
  const currentClosed = current ? windowState(now, current.window_open_at, current.deadline_at) === 'closed' || ['closed', 'settled', 'voided'].includes(current.status) : false;
  const myResultRow = currentResults.find((r) => r.user_id === userId) ?? null;
  const gate =
    goal && current && amIn && currentClosed
      ? gateClose({
          userId,
          instanceStatus: current.status,
          myResult: myResultRow,
          results: currentResults,
          nets: goal.nets.filter((n) => n.instance_id === current.id),
          profiles: memberProfiles,
          stakeCents: pact.stake_cents,
          carryInCents: current.carry_in_cents,
          frozen: frozenIds.has(current.id),
          sinceDeadlineMs: now - Date.parse(current.deadline_at),
          goal: goalKind,
          period: pact.period,
        })
      : null;
  const last = goal?.last ?? null;
  const lastGate =
    goal && last && amIn
      ? gateClose({
          userId,
          instanceStatus: last.status,
          myResult: goal.results.find((r) => r.instance_id === last.id && r.user_id === userId) ?? null,
          results: goal.results.filter((r) => r.instance_id === last.id),
          nets: goal.nets.filter((n) => n.instance_id === last.id),
          profiles: memberProfiles,
          stakeCents: pact.stake_cents,
          carryInCents: last.carry_in_cents,
          frozen: frozenIds.has(last.id),
          sinceDeadlineMs: now - Date.parse(last.deadline_at),
          goal: goalKind,
          period: pact.period,
        })
      : null;
  const weekLabel = (inst: PactInstanceRow) => (pact.period === 'weekly' ? `week of ${formatLocalDateShort(inst.local_date)}` : pact.period === 'once' ? 'the race' : formatDateInZone(inst.deadline_at, pact.tz));
  const periodWord = pact.period === 'weekly' ? 'week' : pact.period === 'once' ? 'race' : 'day';
  const countsLine =
    pact.kind === 'steps'
      ? 'Daily step total from your phone or watch'
      : pact.kind === 'custom'
        ? pact.proof_required
          ? 'Your own mark, with a photo'
          : 'Your own mark, with a photo if you like'
        : pact.activity_types && pact.activity_types.length < 9
          ? pact.activity_types.map((t) => `${activityTypeLabel(t)}s`).join(' and ')
          : 'Any workout of ten minutes or more';
  const status = healthStatus();
  const stravaConnected = strava.status === 'connected';
  const syncSubtitle = syncRowSubtitle(status, lastSync.at, lastSync.count, now);

  const join = async () => {
    setJoining(true);
    haptic('commit');
    try {
      await joinPact({ pactId });
      if (pact.kind !== 'custom') await ensureHealthPermission();
      await refresh();
      toast.show({ message: pact.kind === 'custom' ? "You're in. Mark each day done before midnight." : "You're in. Sync your runs from Apple Health below.", tone: 'success', icon: 'checkmark' });
    } catch (e) {
      toast.show({ message: userMessage(e), tone: 'forfeit', icon: 'exclamationmark.triangle' });
      haptic('error');
    } finally {
      setJoining(false);
    }
  };

  const sync = async () => {
    if (status === 'web') {
      toast.show({ message: 'Runs sync from your iPhone. Strava works here.', tone: 'neutral', icon: 'heart' });
      return;
    }
    setSyncing(true);
    haptic('commit');
    const outcome = await syncHealth({ tz: pact.tz, includeWorkouts: pact.kind !== 'steps', includeSteps: pact.kind === 'steps' });
    setSyncing(false);
    if (!outcome) {
      toast.show({ message: 'Apple Health is not available on this device.', tone: 'neutral', icon: 'heart' });
      return;
    }
    setLastSync({ at: outcome.syncedAt, count: outcome.activities });
    const t = syncToast(outcome);
    toast.show({ message: t.message, tone: t.tone, icon: t.tone === 'unverified' ? 'exclamationmark.triangle' : 'heart' });
    if (outcome.written > 0) await refresh();
  };

  const connectStrava = async () => {
    haptic('commit');
    try {
      await startStravaConnect(userId);
      // on a phone the browser comes back to Settings with ?strava=…; the demo connects on the spot
      if (DEMO) {
        await strava.invalidate();
        toast.show({ message: stravaReturnMessage({ status: 'connected' }), tone: 'success', icon: 'arrow.triangle.2.circlepath' });
      }
    } catch (e) {
      toast.show({ message: userMessage(e), tone: 'forfeit', icon: 'exclamationmark.triangle' });
    }
  };

  const mark = async () => {
    if (!current) return;
    let photoPath: string | null = null;
    if (pact.proof_required) {
      // the server refuses a bare mark on a proof pact (23514): pick the photo first, upload like an appeal's evidence
      const asset = await pickEvidencePhoto().catch(() => null);
      if (!asset) return;
      setMarking(true);
      try {
        photoPath = DEMO ? `${pact.group_id}/${userId}/proof.jpg` : await uploadEvidencePhoto(asset, pact.group_id, userId);
      } catch (e) {
        setMarking(false);
        toast.show({ message: userMessage(e), tone: 'forfeit', icon: 'exclamationmark.triangle' });
        return;
      }
    }
    setMarking(true);
    haptic('commit');
    try {
      await markDone(current.id, photoPath);
      await refresh();
      toast.show({ message: photoPath ? 'Marked done with your photo. Friends can challenge it until the gate closes.' : 'Marked done. Friends can challenge it until the gate closes.', tone: 'success', icon: 'checkmark' });
    } catch (e) {
      toast.show({ message: userMessage(e), tone: 'forfeit', icon: 'exclamationmark.triangle' });
      haptic('error');
    } finally {
      setMarking(false);
    }
  };

  // a friend's accepted entry in a closed, unsettled week with a posted success can be challenged
  const canChallenge = (a: PactActivityRow): boolean => {
    if (!goal || !amIn || a.user_id === userId) return false;
    const inst = [goal.current, goal.last].find((i) => i?.id === a.instance_id);
    if (!inst || inst.status === 'settled' || inst.status === 'voided') return false;
    if (windowState(now, inst.window_open_at, inst.deadline_at) !== 'closed') return false;
    return goal.results.some((r) => r.instance_id === a.instance_id && r.user_id === a.user_id && r.status === 'success');
  };
  const challenge = (a: PactActivityRow) => {
    const inst = [goal?.current, goal?.last].find((i) => i?.id === a.instance_id);
    if (!inst) return;
    const full = displayName(memberProfiles, a.user_id);
    setReviewTarget({
      instanceId: a.instance_id,
      subjectUserId: a.user_id,
      subjectShortName: full.split(/\s+/)[0] ?? full,
      dayLabel: weekLabel(inst),
      pactTitle: pact.title,
      groupId: pact.group_id,
      kind: 'challenge',
    });
    setReviewOpen(true);
  };

  const dailyGoal = goalKind && pact.period === 'daily';

  return (
    <View style={styles.root}>
      <Screen refreshing={detail.isRefetching} onRefresh={() => void detail.refetch()}>
        <Stack.Screen options={{ title: pact.title }} />

        {goalKind ? (
          <>
            <GoalHeader
              pact={pact}
              instance={current}
              myValue={myValue}
              notOnRoster={notOnRoster}
              myReached={myReached}
              myResult={myResultRow && currentClosed && !gate ? myResultRow.status : null}
              unit={unit}
              nowMs={now}
              onJoin={!amIn && members.some((m) => m.user_id === userId) ? () => void join() : undefined}
              joining={joining}
              onMarkDone={pact.kind === 'custom' && amIn ? () => void mark() : undefined}
              marking={marking}
            />
            {gate ? (
              <View key={`gate-${gate.state}`}>
                <GateCloseCard gate={gate} />
              </View>
            ) : null}

            <StandingsGroup
              pact={pact}
              standings={currentStandings}
              participantIds={participants.map((p) => p.user_id)}
              results={currentResults}
              userId={userId}
              nameOf={nameOf}
              unit={unit}
              streakLine={dailyGoal ? (id) => { const s = streakFor(streaks, id); return streakLine(s.current_streak, s.best_streak); } : undefined}
              closed={currentClosed}
              footer={
                currentClosed
                  ? 'Results are posted. Anything that synced late shows here and is recomputed within a day.'
                  : `Standings move as everyone's activities sync. Reaching the goal is what counts; the order is for bragging rights and leftover cents.`
              }
            />

            {amIn && pact.kind !== 'custom' ? (
              <ListGroup header="Evidence" footer="Only workouts and steps are read, never your location. Entries typed into Apple Health by hand don't count, and anyone in the pact can challenge an entry.">
                <ListRow
                  leading={<Icon name="heart" size={20} color="tint" />}
                  title="Sync Apple Health"
                  subtitle={syncSubtitle}
                  trailing={<Value color="tint">{syncing ? 'Syncing' : 'Sync'}</Value>}
                  disabled={syncing}
                  onPress={() => void sync()}
                  accessibilityHint="Reads new workouts from Apple Health and sends them"
                />
                <ListRow
                  leading={<Icon name="arrow.triangle.2.circlepath" size={20} color="tint" />}
                  title={stravaConnected ? 'Strava connected' : 'Connect Strava'}
                  subtitle={
                    stravaConnected
                      ? `Connected as Strava athlete ${strava.athleteId}. New activities arrive on their own; manage it in Settings.`
                      : 'Runs recorded with Strava or a Garmin count too.'
                  }
                  trailing={stravaConnected ? <Pill label="Connected" tone="success" size="compact" /> : <Value color="tint">Connect</Value>}
                  chevron={!stravaConnected}
                  onPress={stravaConnected ? undefined : () => void connectStrava()}
                  disabled={strava.status === 'loading'}
                  accessibilityHint={stravaConnected ? undefined : 'Opens Strava to allow Final Call to read your activities'}
                />
              </ListGroup>
            ) : null}

            {current ? (
              <ActivityGroup
                activities={goal?.activities.filter((a) => a.instance_id === current.id) ?? []}
                userId={userId}
                nameOf={nameOf}
                tz={pact.tz}
                unit={unit}
                canChallenge={canChallenge}
                onChallenge={challenge}
                header={pact.period === 'daily' ? "Today's activities" : `This ${periodWord}'s activities`}
                emptyBody={pact.kind === 'custom' ? 'Marks appear here as people mark the day done.' : 'Runs appear here as they sync from Apple Health or Strava.'}
              />
            ) : null}

            {last ? (
              <StandingsGroup
                pact={pact}
                standings={goal?.standings.filter((s) => s.instance_id === last.id) ?? []}
                participantIds={participants.map((p) => p.user_id)}
                results={goal?.results.filter((r) => r.instance_id === last.id) ?? []}
                userId={userId}
                nameOf={nameOf}
                unit={unit}
                closed
                header={`Last ${periodWord} · ${weekLabel(last)}`}
                footer={lastGate && lastGate.state === 'posted' ? `${lastGate.compact}.` : undefined}
              />
            ) : null}

            <ListGroup header="Goal" footer={pact.tz !== deviceZone ? `Weeks follow ${timeZoneDisplayName(pact.tz)}.` : undefined}>
              <ListRow title="Goal" trailing={<Value tabular>{goalLabel(pact, unit)}</Value>} />
              <ListRow title="Counts" trailing={<Value>{countsLine}</Value>} />
              {pact.period === 'weekly' ? (
                <ListRow title="Week" trailing={<Value>Monday to Sunday</Value>} />
              ) : pact.period === 'once' && pact.race_start && pact.race_end ? (
                <ListRow title="Race" trailing={<Value tabular>{`${formatLocalDateShort(pact.race_start)} to ${formatLocalDateShort(pact.race_end)}`}</Value>} />
              ) : (
                <ListRow title="Days" trailing={<Value>{describeDays(pact.days_of_week ?? [])}</Value>} />
              )}
              {pact.tz !== deviceZone ? <ListRow title="Time zone" trailing={<Value>{timeZoneDisplayName(pact.tz)}</Value>} /> : null}
            </ListGroup>

            <ListGroup
              header="Pledge"
              footer={`Fall short of the goal and it's forfeited to the pool, split among the friends who made it. Evidence lives on your phone: a ${periodWord} that couldn't sync in time is recomputed when it does.`}
            >
              <ListRow title={pact.period === 'once' ? 'If you fall short' : `Per missed ${periodWord}`} trailing={<Value tabular>{formatCents(pact.stake_cents)}</Value>} />
            </ListGroup>
          </>
        ) : (
          <>
            <ListGroup header="Schedule" footer={pact.tz !== deviceZone ? `Times follow ${timeZoneDisplayName(pact.tz)}.` : undefined}>
              <ListRow title="Days" trailing={<Value>{describeDays(pact.days_of_week ?? [])}</Value>} />
              <ListRow title="Check-in window" trailing={<Value tabular>{window}</Value>} />
              {pact.tz !== deviceZone ? <ListRow title="Time zone" trailing={<Value>{timeZoneDisplayName(pact.tz)}</Value>} /> : null}
            </ListGroup>

            <ListGroup
              header="Pledge"
              footer="Forfeited to the pool on a day you miss; show up and you split the pool with the others who did. Unverified days never cost anything."
            >
              <ListRow title="Per missed day" trailing={<Value tabular>{formatCents(pact.stake_cents)}</Value>} />
            </ListGroup>
          </>
        )}

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

        {goalKind ? null : mine ? (
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
              accessibilityLabel={`Your place: ${myCurrent?.label ?? mine.place_label ?? 'set'}, ${myCurrent?.radius_m ?? mine.place_radius_m ?? 0} metre circle`}
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

        {goalKind ? (
          notJoined.length > 0 ? (
            <ListGroup header="Not in yet" footer="Anyone in the group can join from the pact; nothing is needed but their phone.">
              {notJoined.map((m) => (
                <ListRow key={m.user_id} title={nameOf(m.user_id)} subtitle="Not in this challenge" leading={<Avatar person={{ id: m.user_id, name: nameOf(m.user_id) }} />} disabled />
              ))}
            </ListGroup>
          ) : null
        ) : (
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
        )}

        {goalKind && pact.period === 'once' ? null : (
          <ListGroup
            header={pact.period === 'weekly' ? 'Next week' : 'Upcoming'}
            footer={
              amIn
                ? pact.period === 'weekly'
                  ? "A freeze means a week doesn't count for or against you. One per month for a weekly pact, declared before Monday."
                  : "A freeze means a day doesn't count for or against you. One per week per pact, declared before the window opens."
                : undefined
            }
          >
            {upcoming.filter((inst) => pact.period !== 'weekly' || Date.parse(inst.window_open_at) > now).length === 0 ? (
              <View style={{ backgroundColor: colors.surface }}>
                <EmptyState icon="clock" title="Nothing scheduled yet" body={pact.period === 'weekly' ? 'Next week appears here a few days before Monday.' : 'Days appear here up to a week ahead.'} />
              </View>
            ) : null}
            {upcoming.filter((inst) => pact.period !== 'weekly' || Date.parse(inst.window_open_at) > now).map((inst) => {
              const state = windowState(now, inst.window_open_at, inst.deadline_at);
              const frozen = frozenIds.has(inst.id);
              const voided = inst.status === 'voided';
              const open = state === 'open' && !voided;
              const canFreeze = amIn && state === 'before' && !frozen && inst.status === 'scheduled';
              const day = pact.period === 'weekly' ? `Week of ${formatLocalDateShort(inst.local_date)}` : formatDateInZone(inst.deadline_at, pact.tz);
              const tappable = open && amIn && !goalKind;
              return (
                <ListRow
                  key={inst.id}
                  title={day}
                  subtitle={pact.period === 'weekly' ? 'Monday to Sunday night' : `by ${formatTimeInZone(inst.deadline_at, pact.tz)}`}
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
                  chevron={tappable}
                  onPress={tappable ? () => router.push(`/checkin/${inst.id}`) : undefined}
                  accessibilityLabel={`${day}, by ${formatTimeInZone(inst.deadline_at, pact.tz)}${frozen ? ', frozen' : voided ? ", didn't count" : open ? ', open now' : ''}`}
                  accessibilityHint={tappable ? 'Opens check-in' : undefined}
                />
              );
            })}
          </ListGroup>
        )}
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
      <ReviewSheet
        target={reviewTarget}
        open={reviewOpen}
        userId={userId}
        onClose={() => setReviewOpen(false)}
        onDone={() => {
          setReviewOpen(false);
          void refresh();
          void qc.invalidateQueries({ queryKey: ['group', pact.group_id, 'feed'] });
          toast.show({ message: 'Challenge sent. The others can vote until Monday noon.', icon: 'bubble.left' });
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

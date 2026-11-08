import { useQueryClient } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AppState, Linking, StyleSheet, View } from 'react-native';
import { usePactDetail, usePlaceSchedule, type PlaceSchedule } from '@/api/queries';
import { joinPact } from '@/api/rpc';
import { Button, Card, EmptyState, ListGroup, ListRow, Screen, SkeletonCard, Text, TextField } from '@/components';
import { RadiusSlider } from '@/components/RadiusSlider';
import { APPROXIMATE_LOCATION_HEADLINE, approximateLocationBody } from '@/features/checkin/copy';
import { PLACE_RULE_CHANGE, PLACE_RULE_CHANGE_MIN, PLACE_RULE_JOIN } from '@/features/place/placeCopy';
import { placeSaveState } from '@/features/place/placeRules';
import { RADIUS_DEFAULT, accuracyLine, isRoughFix } from '@/features/place/radius';
import { useUserId } from '@/lib/auth';
import { userMessage } from '@/lib/errors';
import { FixTimeoutError, ensurePreciseForegroundPermission, takeHighAccuracyFix, type PreciseOutcome } from '@/lib/location';
import { formatDateInZone, formatTimeInZone } from '@/lib/time';
import { useNow } from '@/lib/useNow';
import { haptic, space, useTheme } from '@/theme';

interface Spot {
  lat: number;
  lng: number;
  /** null when the spot came from a saved place rather than a fresh fix */
  accuracy: number | null;
}

type Problem = { kind: 'permission'; outcome: Exclude<PreciseOutcome, 'granted'> } | { kind: 'nofix' } | { kind: 'other'; message: string };

/** The place screen's version of the check-in refusal: an Approximate fix cannot draw a circle either (N2-5, NI-3). */
const APPROXIMATE_PLACE_BODY = approximateLocationBody({
  consequence: "can't place your circle, so nothing was captured",
  next: 'capture your place',
});

const at = (iso: string, tz: string) => `${formatDateInZone(iso, tz)} at ${formatTimeInZone(iso, tz)}`;

/** Per-person place picker: current location + radius. No map SDK (address search is v1.1). */
export default function PlacePicker() {
  const { pactId } = useLocalSearchParams<{ pactId: string }>();
  const userId = useUserId();
  const detail = usePactDetail(pactId, userId);
  const qc = useQueryClient();
  const { colors } = useTheme();
  const now = useNow(30_000);

  const [spot, setSpot] = useState<Spot | null>(null);
  const [radius, setRadius] = useState(RADIUS_DEFAULT);
  const [label, setLabel] = useState('');
  const [labelTouched, setLabelTouched] = useState(false);
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saved, setSaved] = useState(false);
  const savingRef = useRef(false);
  const schedule = usePlaceSchedule(pactId, userId, saved);

  const mine = detail.data?.participants.find((p) => p.user_id === userId);
  // remember whether a place existed before this save, so the copy doesn't flip after joining
  const [hadPlace, setHadPlace] = useState<boolean | null>(null);
  useEffect(() => {
    if (detail.data && hadPlace === null) setHadPlace(mine !== undefined);
  }, [detail.data, mine, hadPlace]);
  useEffect(() => {
    if (mine && !spot) {
      setSpot({ lat: mine.place_lat, lng: mine.place_lng, accuracy: null });
      setRadius(mine.place_radius_m);
      setLabel(mine.place_label ?? '');
    }
  }, [mine, spot]);

  // a blocked permission or Approximate Location re-checks itself when the person comes back from Settings
  const settingsProblem = problem?.kind === 'permission' && (problem.outcome === 'blocked' || problem.outcome === 'approximate');
  useEffect(() => {
    if (!settingsProblem) return;
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      void ensurePreciseForegroundPermission().then((p) => {
        if (p === 'granted') setProblem(null);
      });
    });
    return () => sub.remove();
  }, [settingsProblem]);

  const captureLocation = async () => {
    setProblem(null);
    setLocating(true);
    try {
      // precise accuracy is required: a kilometre-level fix cannot set a circle (same rule as the check-in tap)
      const permission = await ensurePreciseForegroundPermission();
      if (permission !== 'granted') {
        setProblem({ kind: 'permission', outcome: permission });
        haptic('error');
        return;
      }
      const fix = await takeHighAccuracyFix();
      setSpot({ lat: fix.coords.latitude, lng: fix.coords.longitude, accuracy: fix.coords.accuracy ?? null });
      haptic(isRoughFix(fix.coords.accuracy ?? null) ? 'warning' : 'snap');
    } catch (e) {
      if (e instanceof FixTimeoutError) setProblem({ kind: 'nofix' });
      else setProblem({ kind: 'other', message: userMessage(e) });
      haptic('warning');
    } finally {
      setLocating(false);
    }
  };

  if (detail.isPending) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Your place' }} />
        <SkeletonCard lines={3} />
        <SkeletonCard lines={2} />
      </Screen>
    );
  }
  if (detail.isError) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Your place' }} />
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

  const { pact, upcoming } = detail.data;
  const hasPlace = hadPlace ?? mine !== undefined;
  const rules = placeSaveState({ hasPlace, upcoming, nowMs: now });
  const labelError = labelTouched && label.trim().length === 0 ? 'Name this place, like "Kane Hall 120".' : undefined;
  const canSave = spot !== null && !rules.locked && !saving;

  const save = async () => {
    if (!spot || savingRef.current) return;
    if (label.trim().length === 0) {
      setLabelTouched(true);
      haptic('error');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setProblem(null);
    try {
      await joinPact({ pactId, lat: spot.lat, lng: spot.lng, radiusM: radius, label: label.trim() });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['pact', pactId] }),
        qc.invalidateQueries({ queryKey: ['group', pact.group_id] }),
      ]);
      setSaved(true);
      haptic('success');
      await schedule.refetch();
    } catch (e) {
      setProblem({ kind: 'other', message: userMessage(e) });
      haptic('error');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const done = () => router.replace(`/pacts/${pactId}`);

  return (
    <Screen
      footer={
        saved ? (
          <Button title="Done" onPress={done} />
        ) : (
          <View style={styles.footer}>
            {rules.locked && rules.lockedUntil ? (
              <Text variant="footnote" color="secondary" align="center" accessibilityLiveRegion="polite">
                You can't change your place while today's check-in window is open. Try again after{' '}
                {formatTimeInZone(rules.lockedUntil, pact.tz)}.
              </Text>
            ) : null}
            <Button
              title={rules.mode === 'join' ? 'Join with this place' : 'Save place'}
              onPress={() => void save()}
              disabled={!canSave}
              loading={saving}
              accessibilityHint={rules.locked ? 'Unavailable while a check-in window is open' : spot ? undefined : 'Capture your location first'}
            />
          </View>
        )
      }
    >
      {/* a pushed screen: the one Done is the footer button, never doubled in the nav bar */}
      <Stack.Screen options={{ title: 'Your place' }} />

      <View style={styles.intro}>
        <Text variant="headline">{pact.title}</Text>
        <Text variant="subheadline" color="secondary">
          Everyone sets their own place and everyone sees everyone's. Stand where you need to be, then capture it.
          You're in when your GPS fix lands inside this circle.
        </Text>
      </View>

      {saved && schedule.data ? (
        <SavedSummary schedule={schedule.data} tz={pact.tz} label={label.trim()} radius={radius} />
      ) : saved && schedule.isError ? (
        <ListGroup footer={userMessage(schedule.error)}>
          <ListRow title="Saved" subtitle={`${label.trim()} · ${radius} m`} />
        </ListGroup>
      ) : saved ? (
        <SkeletonCard lines={2} />
      ) : null}

      {!saved ? (
        <>
          {problem?.kind === 'permission' ? (
            <Card>
              <EmptyState
                icon="location"
                title={problem.outcome === 'approximate' ? APPROXIMATE_LOCATION_HEADLINE : 'Location is off for Show Up'}
                body={
                  problem.outcome === 'approximate'
                    ? APPROXIMATE_PLACE_BODY
                    : problem.outcome === 'blocked'
                      ? 'Location is turned off for Show Up in iOS Settings. Turn it on, then come back and capture your place.'
                      : 'Setting a place needs your location once. Allow "While Using the App".'
                }
                action={
                  problem.outcome === 'blocked' || problem.outcome === 'approximate'
                    ? { label: 'Open Settings', onPress: () => void Linking.openSettings() }
                    : { label: 'Allow location', onPress: () => void captureLocation() }
                }
                style={styles.inlineEmpty}
              />
            </Card>
          ) : (
            <Button
              title={spot && spot.accuracy !== null ? 'Re-capture' : 'Use my current location'}
              variant={spot && spot.accuracy !== null ? 'secondary' : 'primary'}
              onPress={() => void captureLocation()}
              loading={locating}
              disabled={rules.locked}
              accessibilityHint="Reads your location once, right now"
            />
          )}
          {locating ? (
            <Text variant="footnote" color="secondary" align="center" accessibilityLiveRegion="polite">
              Finding you… Your location is read once, right now, and nowhere else.
            </Text>
          ) : null}

          {problem?.kind === 'nofix' ? (
            <Card>
              <Text variant="headline">No GPS fix</Text>
              <Text variant="subheadline" color="secondary">
                Nothing landed in 25 seconds. Try again near a window or just outside the entrance.
              </Text>
              <Button title="Try again" variant="secondary" size="small" onPress={() => void captureLocation()} />
            </Card>
          ) : null}
          {problem?.kind === 'other' ? (
            <Text variant="footnote" color="forfeit" accessibilityRole="alert" accessibilityLiveRegion="assertive">
              {problem.message}
            </Text>
          ) : null}

          {spot ? (
            <>
              <ListGroup
                header="Captured"
                footer={isRoughFix(spot.accuracy) ? "That's a rough fix. Try again near a window or just outside the entrance." : undefined}
              >
                <ListRow
                  title={spot.accuracy === null ? 'Your saved place' : 'Current location'}
                  subtitle={accuracyLine(spot.accuracy)}
                  trailing={
                    spot.accuracy === null ? (
                      <Text variant="body" color="secondary" tabular>
                        {radius} m
                      </Text>
                    ) : undefined
                  }
                />
              </ListGroup>

              <ListGroup header="Circle" footer="Bigger circles forgive indoor GPS drift; smaller ones are stricter. Your fix counts if its uncertainty circle touches this one.">
                <View style={[styles.sliderBlock, { backgroundColor: colors.surface }]}>
                  <RadiusSlider value={radius} onChange={setRadius} />
                </View>
              </ListGroup>
            </>
          ) : null}

          <TextField
            label="Name"
            value={label}
            onChangeText={setLabel}
            onBlur={() => setLabelTouched(true)}
            placeholder="Kane Hall 120"
            maxLength={60}
            error={labelError}
            helper="Shown to the group next to your name."
            returnKeyType="done"
          />

          <ListGroup
            footer={
              rules.locked
                ? "Today's window is open, so you're judged against the place you already saved."
                : rules.mode === 'join'
                  ? PLACE_RULE_JOIN
                  : `${PLACE_RULE_CHANGE} ${PLACE_RULE_CHANGE_MIN} Until then you're judged against your current place.`
            }
          >
            <ListRow
              title="Next window"
              subtitle={rules.nextWindow ? at(rules.nextWindow.window_open_at, pact.tz) : 'Nothing scheduled in the next week'}
            />
          </ListGroup>
        </>
      ) : null}
    </Screen>
  );
}

function SavedSummary({ schedule, tz, label, radius }: { schedule: PlaceSchedule; tz: string; label: string; radius: number }) {
  const { nextInstance, nextPlace, latestSaved } = schedule;
  const deferred = latestSaved && latestSaved !== nextPlace && Date.parse(latestSaved.effective_from) > Date.now();
  return (
    <ListGroup
      header="Saved"
      footer={
        deferred && latestSaved
          ? latestSaved.requires_ack
            ? `${latestSaved.label ?? label} counts as soon as a friend confirms it (not before ${at(new Date(Date.parse(latestSaved.created_at) + 12 * 3_600_000).toISOString(), tz)}), or from ${at(latestSaved.effective_from, tz)} if nobody objects. Your friends have been told.`
            : `${latestSaved.label ?? label} applies from ${at(latestSaved.effective_from, tz)}.`
          : nextInstance
            ? 'Your place is set for the next window. Your friends see it and can object within 24 hours.'
            : 'Your place is saved. Days appear up to a week ahead.'
      }
    >
      <ListRow title={label} subtitle={`${radius} m circle`} />
      <ListRow
        title="Next window"
        subtitle={
          nextInstance
            ? `${at(nextInstance.window_open_at, tz)} · ${nextPlace ? `${nextPlace.label ?? 'your place'} (${nextPlace.radius_m} m)` : 'no place yet'}`
            : 'Nothing scheduled in the next week'
        }
      />
    </ListGroup>
  );
}

const styles = StyleSheet.create({
  intro: { gap: space.xs },
  inlineEmpty: { paddingVertical: space.sm },
  sliderBlock: { padding: space.lg },
  footer: { gap: space.sm },
});

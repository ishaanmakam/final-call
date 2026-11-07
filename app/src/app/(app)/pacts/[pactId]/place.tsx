import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking } from 'react-native';
import { usePactDetail, usePlaceSchedule, type PlaceSchedule } from '@/api/queries';
import { joinPact } from '@/api/rpc';
import { RadiusSlider } from '@/components/RadiusSlider';
import { Body, Button, Card, ErrorText, Field, Heading, Loading, QueryState, Screen } from '@/components/ui';
import { useUserId } from '@/lib/auth';
import { ensureForegroundPermission, takeHighAccuracyFix } from '@/lib/location';
import { PLACE_CHANGE_LEAD_HOURS } from '@/lib/places';
import { formatDateInZone, formatTimeInZone } from '@/lib/time';

interface Spot {
  lat: number;
  lng: number;
  accuracy: number | null;
}

function NextWindowPlace({ schedule, tz }: { schedule: PlaceSchedule; tz: string }) {
  const { nextInstance, nextPlace, latestSaved } = schedule;
  const at = (iso: string) => `${formatDateInZone(iso, tz)} at ${formatTimeInZone(iso, tz)}`;
  return (
    <Card>
      <Heading>Saved</Heading>
      {nextInstance ? (
        <Body>
          Next window ({at(nextInstance.window_open_at)}) uses{' '}
          {nextPlace ? `${nextPlace.label} (${nextPlace.radius_m} m)` : 'no place yet'}.
        </Body>
      ) : (
        <Body>No upcoming window is scheduled yet.</Body>
      )}
      {latestSaved && nextPlace && latestSaved !== nextPlace ? (
        <Body muted>
          {latestSaved.label} applies to windows opening from {at(latestSaved.effective_from)}.
        </Body>
      ) : null}
    </Card>
  );
}

/** Per-person place picker: current location + radius. No map SDK (address search is v1.1). */
export default function PlacePicker() {
  const { pactId } = useLocalSearchParams<{ pactId: string }>();
  const userId = useUserId();
  const detail = usePactDetail(pactId, userId);
  const qc = useQueryClient();

  const [spot, setSpot] = useState<Spot | null>(null);
  const [radius, setRadius] = useState(75);
  const [label, setLabel] = useState('');
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
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
      setLabel(mine.place_label);
    }
  }, [mine, spot]);

  if (detail.isPending) return <Loading />;
  if (detail.isError) return <QueryState error={detail.error} onRetry={() => void detail.refetch()} />;

  const captureLocation = async () => {
    setError(null);
    setBlocked(false);
    setLocating(true);
    try {
      const permission = await ensureForegroundPermission();
      if (permission !== 'granted') {
        setBlocked(permission === 'blocked');
        throw new Error('Location permission is needed to set your place.');
      }
      const fix = await takeHighAccuracyFix();
      setSpot({ lat: fix.coords.latitude, lng: fix.coords.longitude, accuracy: fix.coords.accuracy ?? null });
    } catch (e) {
      setError(e);
    } finally {
      setLocating(false);
    }
  };

  const save = async () => {
    if (!spot) return;
    if (label.trim().length === 0) {
      setError(new Error('Name this place, e.g. "Kane Hall".'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await joinPact({ pactId, lat: spot.lat, lng: spot.lng, radiusM: radius, label: label.trim() });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['pact', pactId] }),
        qc.invalidateQueries({ queryKey: ['group', detail.data.pact.group_id] }),
      ]);
      setSaved(true);
      await schedule.refetch();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <Heading>{detail.data.pact.title}</Heading>
      <Body muted>
        Stand at the place you need to be (your classroom, the gym) and capture it. You check in successfully when
        your GPS fix lands inside this circle.
      </Body>
      {hadPlace ?? mine ? (
        <Body muted>New places apply to check-in windows that open {PLACE_CHANGE_LEAD_HOURS}+ hours from now.</Body>
      ) : null}
      <Button
        title={spot ? 'Re-capture current location' : 'Use my current location'}
        onPress={() => void captureLocation()}
        loading={locating}
      />
      {blocked ? <Button title="Open Settings" variant="secondary" onPress={() => void Linking.openSettings()} /> : null}
      {spot ? (
        <Card>
          <Body>
            Center {spot.lat.toFixed(5)}, {spot.lng.toFixed(5)}
            {spot.accuracy !== null ? ` (±${Math.round(spot.accuracy)} m)` : ''}
          </Body>
          {spot.accuracy !== null && spot.accuracy > 50 ? (
            <Body muted>That fix is fuzzy. Try again near a window or outside the entrance for a better center.</Body>
          ) : null}
          <RadiusSlider value={radius} onChange={setRadius} />
          <Body muted>Bigger circles forgive indoor GPS drift; smaller ones are stricter.</Body>
        </Card>
      ) : null}
      <Field label="Label" value={label} onChangeText={setLabel} placeholder="Kane Hall 120" maxLength={60} />
      <ErrorText error={error} />
      {saved && schedule.data ? <NextWindowPlace schedule={schedule.data} tz={detail.data.pact.tz} /> : null}
      {saved && schedule.isError ? <ErrorText error={schedule.error} /> : null}
      {saved ? (
        <Button title="Done" onPress={() => router.replace(`/pacts/${pactId}`)} />
      ) : (
        <Button
          title={mine ? 'Update my place' : 'Join pact with this place'}
          onPress={() => void save()}
          disabled={!spot}
          loading={saving}
        />
      )}
    </Screen>
  );
}

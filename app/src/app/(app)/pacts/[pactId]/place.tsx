import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking } from 'react-native';
import { usePactDetail } from '@/api/queries';
import { joinPact } from '@/api/rpc';
import { RadiusSlider } from '@/components/RadiusSlider';
import { Body, Button, Card, ErrorText, Field, Heading, Loading, QueryState, Screen } from '@/components/ui';
import { useUserId } from '@/lib/auth';
import { ensureForegroundPermission, takeHighAccuracyFix } from '@/lib/location';

interface Spot {
  lat: number;
  lng: number;
  accuracy: number | null;
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

  const mine = detail.data?.participants.find((p) => p.user_id === userId);
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
      router.replace(`/pacts/${pactId}`);
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
      <Button title={mine ? 'Update my place' : 'Join pact with this place'} onPress={() => void save()} disabled={!spot} loading={saving} />
    </Screen>
  );
}

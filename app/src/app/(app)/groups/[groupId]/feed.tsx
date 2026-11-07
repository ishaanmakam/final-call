import { useQueryClient } from '@tanstack/react-query';
import type { ImagePickerAsset } from 'expo-image-picker';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking } from 'react-native';
import { displayName, useFeed, type Feed, type FeedItem } from '@/api/queries';
import { castVote, openReview } from '@/api/rpc';
import { REVIEW_PHOTO_BUCKET, supabase } from '@/api/supabase';
import type { ReviewKind } from '@/api/types';
import { resultLabel, reviewStatusLabel } from '@/components/status';
import { Badge, Body, Button, Card, ErrorText, Field, Heading, Loading, QueryState, Row, Screen } from '@/components/ui';
import { useUserId } from '@/lib/auth';
import { pickEvidencePhoto, uploadEvidencePhoto } from '@/lib/reviewPhoto';
import { formatDateInZone } from '@/lib/time';

const itemKey = (i: FeedItem) => `${i.result.instance_id}:${i.result.user_id}`;

async function openPhoto(path: string) {
  const { data, error } = await supabase.storage.from(REVIEW_PHOTO_BUCKET).createSignedUrl(path, 300);
  if (error) throw new Error(error.message);
  await Linking.openURL(data.signedUrl);
}

function ReviewForm({
  item,
  kind,
  userId,
  onDone,
  onCancel,
}: {
  item: FeedItem;
  kind: ReviewKind;
  userId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [photo, setPhoto] = useState<ImagePickerAsset | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    if (reason.trim().length < 3) {
      setError(new Error('Say briefly what happened.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const photoPath = photo ? await uploadEvidencePhoto(photo, item.result.instance_id, userId) : null;
      await openReview({
        instanceId: item.result.instance_id,
        subjectUserId: item.result.user_id,
        kind,
        reason: reason.trim(),
        photoPath,
      });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Field
        label={kind === 'appeal' ? 'Why should this count?' : 'Why are you challenging this?'}
        value={reason}
        onChangeText={setReason}
        multiline
        maxLength={500}
      />
      {kind === 'appeal' ? (
        <Button
          title={photo ? 'Change photo' : 'Add photo evidence (optional)'}
          variant="secondary"
          onPress={() => void pickEvidencePhoto().then((p) => p && setPhoto(p)).catch(setError)}
        />
      ) : null}
      {photo ? <Body muted>Photo attached</Body> : null}
      <ErrorText error={error} />
      <Row>
        <Button title="Cancel" variant="ghost" onPress={onCancel} style={{ flex: 1 }} />
        <Button title="Submit" onPress={() => void submit()} loading={busy} style={{ flex: 1 }} />
      </Row>
    </>
  );
}

function FeedCard({
  item,
  feed,
  userId,
  expanded,
  setExpanded,
  onChanged,
}: {
  item: FeedItem;
  feed: Feed;
  userId: string;
  expanded: { key: string; kind: ReviewKind } | null;
  setExpanded: (v: { key: string; kind: ReviewKind } | null) => void;
  onChanged: () => void;
}) {
  const [error, setError] = useState<unknown>(null);
  const [voting, setVoting] = useState<string | null>(null);
  const { result, pact, instance, reviews } = item;
  const isMine = result.user_id === userId;
  const who = isMine ? 'You' : displayName(feed.profiles, result.user_id);
  const label = resultLabel[result.status];
  const participants = feed.participantsByPact.get(pact.id) ?? [];
  const hasOpenReview = reviews.some((r) => r.review.status === 'open');
  const settled = instance.status === 'settled';
  const canAppeal = isMine && result.status === 'failed' && !hasOpenReview && !settled;
  const canChallenge =
    !isMine &&
    participants.includes(userId) &&
    (result.status === 'success' || result.status === 'unverified') &&
    !hasOpenReview &&
    !settled;
  const key = itemKey(item);
  const formOpen = expanded?.key === key;

  const vote = async (reviewId: string, supports: boolean) => {
    setVoting(reviewId);
    setError(null);
    try {
      await castVote(reviewId, supports);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setVoting(null);
    }
  };

  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}>
        <Body>
          {who} · {pact.title}
        </Body>
        <Badge label={label.label} tone={label.tone} />
      </Row>
      <Body muted>{formatDateInZone(instance.deadline_at, pact.tz)}</Body>

      {reviews.map(({ review, votes }) => {
        const agree = votes.filter((v) => v.supports).length;
        const disagree = votes.length - agree;
        const myVote = votes.find((v) => v.voter_id === userId);
        const canVote =
          review.status === 'open' &&
          review.subject_user_id !== userId &&
          participants.includes(userId) &&
          !myVote;
        const opener = review.opened_by === userId ? 'You' : displayName(feed.profiles, review.opened_by);
        return (
          <Card key={review.id}>
            <Body>
              {review.kind === 'appeal' ? `${opener} appealed` : `${opener} challenged`}: "{review.reason}"
            </Body>
            <Body muted>
              {reviewStatusLabel[review.status]} · {agree} agree, {disagree} disagree
              {myVote ? ` · you voted ${myVote.supports ? 'agree' : 'disagree'}` : ''}
            </Body>
            {review.photo_path ? (
              <Button
                title="View photo"
                variant="ghost"
                onPress={() => void openPhoto(review.photo_path!).catch(setError)}
              />
            ) : null}
            {canVote ? (
              <Row>
                <Button
                  title="Agree"
                  onPress={() => void vote(review.id, true)}
                  loading={voting === review.id}
                  style={{ flex: 1 }}
                />
                <Button
                  title="Disagree"
                  variant="secondary"
                  onPress={() => void vote(review.id, false)}
                  disabled={voting === review.id}
                  style={{ flex: 1 }}
                />
              </Row>
            ) : null}
          </Card>
        );
      })}

      {formOpen && expanded ? (
        <ReviewForm
          item={item}
          kind={expanded.kind}
          userId={userId}
          onCancel={() => setExpanded(null)}
          onDone={() => {
            setExpanded(null);
            onChanged();
          }}
        />
      ) : (
        <Row>
          {canAppeal ? (
            <Button title="Appeal" variant="secondary" onPress={() => setExpanded({ key, kind: 'appeal' })} />
          ) : null}
          {canChallenge ? (
            <Button title="Challenge" variant="ghost" onPress={() => setExpanded({ key, kind: 'challenge' })} />
          ) : null}
        </Row>
      )}
      <ErrorText error={error} />
    </Card>
  );
}

export default function FeedScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const userId = useUserId();
  const feed = useFeed(groupId);
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<{ key: string; kind: ReviewKind } | null>(null);

  if (feed.isPending) return <Loading />;
  if (feed.isError) return <QueryState error={feed.error} onRetry={() => void feed.refetch()} />;

  const onChanged = () => {
    void qc.invalidateQueries({ queryKey: ['group', groupId] });
  };

  const excluded = [...feed.data.excludedThisMonth.entries()];

  return (
    <Screen refreshing={feed.isRefetching} onRefresh={() => void feed.refetch()}>
      <Body muted>
        Results from the last few weeks. Missed a day you actually made? Appeal it. Something look off? Challenge it.
        The group votes before Monday's settle-up.
      </Body>
      {excluded.length > 0 ? (
        <Card>
          <Heading>Excluded this month</Heading>
          {excluded.map(([uid, n]) => (
            <Body key={uid}>
              {uid === userId ? 'You' : displayName(feed.data.profiles, uid)}: {n}
            </Body>
          ))}
        </Card>
      ) : null}
      {feed.data.items.length === 0 ? <Body muted>No results yet.</Body> : null}
      {feed.data.items.map((item) => (
        <FeedCard
          key={itemKey(item)}
          item={item}
          feed={feed.data}
          userId={userId}
          expanded={expanded}
          setExpanded={setExpanded}
          onChanged={onChanged}
        />
      ))}
    </Screen>
  );
}

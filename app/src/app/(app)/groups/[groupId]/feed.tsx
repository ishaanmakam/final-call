import { useQueryClient } from '@tanstack/react-query';
import type { ImagePickerAsset } from 'expo-image-picker';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  View,
  type SectionListRenderItemInfo,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DEMO } from '@/api/demo/settings';
import { useFeed, type Feed, type FeedItem, type ReviewWithVotes } from '@/api/queries';
import { castVote, openReview } from '@/api/rpc';
import { REVIEW_PHOTO_BUCKET, supabase } from '@/api/supabase';
import type { ReviewKind } from '@/api/types';
import {
  Avatar,
  Button,
  EmptyState,
  Icon,
  ListRow,
  Pill,
  Sheet,
  Skeleton,
  StatusPill,
  Text,
  TextField,
  reviewStatusTone,
  useToast,
} from '@/components';
import {
  carryNote,
  excludedFootnote,
  groupFeedByDay,
  instanceSubtitle,
  instanceSummary,
  nameOf,
  personDetail,
  shortName,
  type DaySection,
  type InstanceGroup,
  type Namer,
} from '@/features/feed/groupFeed';
import {
  REASON_ERROR,
  REASON_MIN_LENGTH,
  canVoteOn,
  defaultFootnote,
  kindLabel,
  myVoteText,
  openerLine,
  reviewOutcomeText,
  reviewSheetCopy,
  tally,
  tallyText,
  voteLabels,
} from '@/features/feed/reviewCopy';
import { useUserId } from '@/lib/auth';
import { classifyRpcError, userMessage } from '@/lib/errors';
import { pickEvidencePhoto, uploadEvidencePhoto } from '@/lib/reviewPhoto';
import { reviewActions } from '@/lib/reviews';
import { formatDateInZone } from '@/lib/time';
import { gutter, radius, space, useTheme } from '@/theme';

const FEED_RULE = "Missed a day you actually made? Appeal it. Something look off? Challenge it. The group votes before Monday's settle-up.";
const UNVERIFIED_RULE =
  "Unverified means the app couldn't judge a tap (weak GPS, no fix, or a late offline send). It never costs a pledge and never wins one.";
const OTHER_STATES_RULE =
  'Frozen: the day was called off in advance. Didn\'t count: fewer than two people were active. Excluded: the group\'s review took someone out of the day. None of these move money.';

interface ReviewTarget {
  item: FeedItem;
  kind: ReviewKind;
}

// ---------- photo evidence ----------

const PHOTO_SIZE = 64;

function ReviewPhoto({ path }: { path: string }) {
  const { colors } = useTheme();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (DEMO) return;
    let alive = true;
    supabase.storage
      .from(REVIEW_PHOTO_BUCKET)
      .createSignedUrl(path, 300)
      .then(({ data }) => {
        if (alive && data) setUrl(data.signedUrl);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [path]);

  const open = async () => {
    const target = url ?? (await supabase.storage.from(REVIEW_PHOTO_BUCKET).createSignedUrl(path, 300)).data?.signedUrl;
    if (target) await Linking.openURL(target);
  };

  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel="Photo evidence"
      accessibilityHint="Opens the photo"
      hitSlop={8}
      onPress={() => void open().catch(() => undefined)}
      style={[styles.photo, { backgroundColor: colors.fill }]}
    >
      {url ? <Image source={{ uri: url }} style={styles.photoImage} resizeMode="cover" /> : <Icon name="photo" size={22} color="secondary" />}
    </Pressable>
  );
}

// ---------- one review under a person's row ----------

function ReviewThread({
  review,
  votes,
  roster,
  namer,
  last,
  onChanged,
}: ReviewWithVotes & { roster: readonly string[]; namer: Namer; last: boolean; onChanged: () => void }) {
  const { colors } = useTheme();
  const [voting, setVoting] = useState<boolean | null>(null);
  const [error, setError] = useState<unknown>(null);
  const labels = voteLabels(review.kind);
  const counts = tally(votes);
  const myVote = votes.find((v) => v.voter_id === namer.userId);
  const eligible = canVoteOn({ review, userId: namer.userId, roster });
  const subject = nameOf(namer, review.subject_user_id);

  const vote = async (supports: boolean) => {
    if (voting !== null) return;
    if (myVote && myVote.supports === supports) return;
    setVoting(supports);
    setError(null);
    try {
      await castVote(review.id, supports);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setVoting(null);
    }
  };

  const voteButton = (supports: boolean, primaryByDefault: boolean) => {
    const chosen = myVote?.supports === supports;
    const variant = myVote ? (chosen ? 'primary' : 'secondary') : primaryByDefault ? 'primary' : 'secondary';
    return (
      <Button
        title={supports ? labels.yes : labels.no}
        size="small"
        variant={variant}
        leading={chosen ? <Icon name="checkmark" size={16} color={variant === 'primary' ? 'onTint' : 'label'} /> : undefined}
        loading={voting === supports}
        disabled={voting !== null && voting !== supports}
        onPress={() => void vote(supports)}
        accessibilityLabel={`${supports ? labels.yes : labels.no}${chosen ? ', your vote' : ''}`}
        accessibilityHint={`Votes on ${subject === 'You' ? 'your' : `${subject}'s`} ${kindLabel[review.kind].toLowerCase()}`}
        style={styles.flex}
      />
    );
  };

  return (
    <View
      style={[
        styles.thread,
        { backgroundColor: colors.surface },
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
      ]}
    >
      <View style={styles.threadIcon}>
        <Icon name="bubble.left" size={18} color="tint" />
      </View>
      <View style={styles.threadBody}>
        <View style={styles.threadHead}>
          <Text variant="subheadline" emphasis style={styles.flex}>
            {openerLine(review.kind, nameOf(namer, review.opened_by))}
          </Text>
          <Pill label={reviewOutcomeText(review)} tone={reviewStatusTone[review.status]} size="compact" />
        </View>
        {review.reason ? <Text variant="callout">“{review.reason}”</Text> : null}
        {review.photo_path ? <ReviewPhoto path={review.photo_path} /> : null}
        <Text variant="footnote" color="secondary">
          {tallyText(review.kind, counts.yes, counts.no)}
        </Text>
        {eligible ? (
          <>
            <View style={styles.buttons}>
              {voteButton(true, true)}
              {voteButton(false, false)}
            </View>
            <Text variant="footnote" color="secondary">
              {myVote ? `${myVoteText(review.kind, myVote.supports)}. Tap the other to change it.` : defaultFootnote(review.kind)}
            </Text>
          </>
        ) : review.status === 'open' ? (
          <Text variant="footnote" color="secondary">
            {defaultFootnote(review.kind)}
          </Text>
        ) : null}
        {error ? (
          <Text variant="footnote" color="forfeit" accessibilityRole="alert">
            {userMessage(error)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// ---------- one instance: title, a row per person, the money sentence ----------

function InstanceBlock({
  group,
  feed,
  namer,
  onReview,
  onChanged,
}: {
  group: InstanceGroup;
  feed: Feed;
  namer: Namer;
  onReview: (t: ReviewTarget) => void;
  onChanged: () => void;
}) {
  const { colors } = useTheme();
  const roster = feed.rosterByInstance.get(group.instance.id) ?? [];
  const carry = carryNote(group);

  return (
    <View style={[styles.block, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
      <View style={[styles.blockTitle, { borderBottomColor: colors.separator }]}>
        <Text variant="headline" accessibilityRole="header">
          {group.pact.title}
        </Text>
        <Text variant="subheadline" color="secondary">
          {instanceSubtitle(group)}
        </Text>
      </View>
      {group.items.map((item, index) => {
        const isMine = item.result.user_id === namer.userId;
        const name = nameOf(namer, item.result.user_id);
        const { canAppeal, canChallenge } = reviewActions({
          isMine,
          isParticipant: roster.includes(namer.userId),
          resultStatus: item.result.status,
          settled: group.instance.status === 'settled',
          reviews: item.reviews.map((r) => r.review),
        });
        const action: ReviewKind | null = canAppeal ? 'appeal' : canChallenge ? 'challenge' : null;
        const lastPerson = index === group.items.length - 1;
        const detail = personDetail(item, group);
        const status = item.result.status;
        return (
          <View key={`${item.result.instance_id}:${item.result.user_id}`}>
            <ListRow
              title={name}
              subtitle={detail}
              position={lastPerson && item.reviews.length === 0 ? 'last' : 'middle'}
              leading={<Avatar person={{ id: item.result.user_id, name: feed.profiles.get(item.result.user_id)?.display_name ?? name }} size={28} highlighted={isMine} />}
              trailing={
                <View style={styles.trailing}>
                  <StatusPill state={status} size="compact" who={name} />
                  {action ? (
                    <Text variant="footnote" color="tint" emphasis>
                      {kindLabel[action]}
                    </Text>
                  ) : null}
                </View>
              }
              onPress={action ? () => onReview({ item, kind: action }) : undefined}
              accessibilityLabel={`${name}, ${detail ?? ''}`}
              accessibilityHint={action === 'appeal' ? 'Opens an appeal for this day' : action === 'challenge' ? 'Opens a challenge for this result' : undefined}
            />
            {item.reviews.map((r, i) => (
              <ReviewThread
                key={r.review.id}
                review={r.review}
                votes={r.votes}
                roster={roster}
                namer={namer}
                last={lastPerson && i === item.reviews.length - 1}
                onChanged={onChanged}
              />
            ))}
          </View>
        );
      })}
      <View style={[styles.summary, { borderTopColor: colors.separator }]}>
        <Text variant="subheadline">{instanceSummary(group, namer)}</Text>
        {carry ? (
          <Text variant="footnote" color="secondary">
            {carry}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// ---------- the appeal / challenge sheet ----------

function ReviewSheet({
  target,
  open,
  namer,
  onClose,
  onDone,
}: {
  target: ReviewTarget | null;
  open: boolean;
  namer: Namer;
  onClose: () => void;
  onDone: (kind: ReviewKind) => void;
}) {
  const [reason, setReason] = useState('');
  const [photo, setPhoto] = useState<ImagePickerAsset | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setReason('');
      setPhoto(null);
      setError(null);
    }
  }, [open, target]);

  if (!target) return null;
  const { item, kind } = target;
  const copy = reviewSheetCopy(kind, formatDateInZone(item.instance.deadline_at, item.pact.tz), shortName(namer, item.result.user_id));

  const submit = async () => {
    if (busy) return;
    if (reason.trim().length < REASON_MIN_LENGTH) {
      setError(REASON_ERROR);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const photoPath = photo ? await uploadEvidencePhoto(photo, item.pact.group_id, namer.userId) : null;
      await openReview({
        instanceId: item.result.instance_id,
        subjectUserId: item.result.user_id,
        kind,
        reason: reason.trim(),
        photoPath,
      });
      onDone(kind);
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const sheet = (
    <Sheet open={open} onClose={onClose} title={copy.title}>
      <Text variant="subheadline" color="secondary">
        {item.pact.title}
      </Text>
      <TextField
        label={copy.fieldLabel}
        value={reason}
        onChangeText={(t) => {
          setReason(t);
          if (error) setError(null);
        }}
        placeholder={copy.placeholder}
        multiline
        maxLength={500}
        error={error}
        autoFocus={Platform.OS !== 'web'}
      />
      {kind === 'appeal' ? (
        <Button
          title={photo ? 'Photo attached · Change' : 'Add a photo'}
          variant="secondary"
          size="small"
          leading={<Icon name="photo" size={18} color="label" />}
          onPress={() =>
            void pickEvidencePhoto()
              .then((p) => p && setPhoto(p))
              .catch((e: unknown) => setError(userMessage(e)))
          }
          accessibilityHint="Optional. Picks a photo from your library as evidence."
        />
      ) : null}
      <Text variant="footnote" color="secondary">
        {copy.rule}
      </Text>
      <Button title="Send" onPress={() => void submit()} loading={busy} />
      <Button title="Cancel" variant="tertiary" onPress={onClose} disabled={busy} />
    </Sheet>
  );

  if (Platform.OS === 'ios') {
    return (
      <KeyboardAvoidingView behavior="padding" style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {sheet}
      </KeyboardAvoidingView>
    );
  }
  return sheet;
}

// ---------- loading / error / empty ----------

function FeedSkeleton() {
  const { colors } = useTheme();
  return (
    <View style={styles.skeleton} accessibilityLabel="Loading results" accessibilityState={{ busy: true }}>
      <Skeleton width={110} height={12} style={styles.skeletonHeader} />
      {[0, 1].map((b) => (
        <View key={b} style={[styles.block, styles.skeletonBlock, { backgroundColor: colors.surface, borderColor: colors.separator }]}>
          <Skeleton width="55%" height={16} />
          <Skeleton width="35%" height={12} />
          {[0, 1, 2].map((r) => (
            <View key={r} style={styles.skeletonRow}>
              <Skeleton width={28} height={28} radius={14} />
              <Skeleton width={`${45 + r * 10}%`} height={14} />
              <View style={styles.flex} />
              <Skeleton width={64} height={18} radius={radius.pill} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function DayHeader({ title }: { title: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.dayHeader, { backgroundColor: colors.bg }]}>
      <Text variant="footnote" color="secondary" emphasis accessibilityRole="header" style={styles.dayHeaderText}>
        {title.toUpperCase()}
      </Text>
    </View>
  );
}

// ---------- screen ----------

export default function FeedScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const userId = useUserId();
  const feed = useFeed(groupId);
  const qc = useQueryClient();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [target, setTarget] = useState<ReviewTarget | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const namer = useMemo<Namer>(() => ({ userId, profiles: feed.data?.profiles ?? new Map() }), [userId, feed.data?.profiles]);
  const sections = useMemo<DaySection[]>(() => (feed.data ? groupFeedByDay(feed.data.items, namer) : []), [feed.data, namer]);

  const onChanged = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['group', groupId] });
  }, [qc, groupId]);

  const openSheet = useCallback((t: ReviewTarget) => {
    setTarget(t);
    setSheetOpen(true);
  }, []);

  const renderItem = useCallback(
    ({ item }: SectionListRenderItemInfo<InstanceGroup, DaySection>) =>
      feed.data ? <InstanceBlock group={item} feed={feed.data} namer={namer} onReview={openSheet} onChanged={onChanged} /> : null,
    [feed.data, namer, openSheet, onChanged],
  );

  const excluded = feed.data ? excludedFootnote(feed.data.excludedThisMonth, namer) : null;

  let content: React.ReactNode;
  if (feed.isPending) {
    content = <FeedSkeleton />;
  } else if (feed.isError) {
    const offline = classifyRpcError(feed.error) === 'network';
    content = (
      <EmptyState
        layout="screen"
        icon={offline ? 'wifi.slash' : 'exclamationmark.triangle'}
        title={offline ? "You're offline" : "Couldn't load the feed"}
        body={offline ? 'Results are on the server and nothing here changes until you reconnect.' : userMessage(feed.error)}
        action={{ label: 'Try again', onPress: () => void feed.refetch(), variant: 'secondary' }}
      />
    );
  } else {
    content = (
      <SectionList
        sections={sections}
        keyExtractor={(g) => g.key}
        renderItem={renderItem}
        renderSectionHeader={({ section }) => <DayHeader title={section.title} />}
        stickySectionHeadersEnabled
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.list, { paddingBottom: Math.max(insets.bottom, space.lg) + space.lg }, sections.length === 0 && styles.grow]}
        refreshControl={<RefreshControl refreshing={feed.isRefetching} onRefresh={() => void feed.refetch()} />}
        ListEmptyComponent={
          <EmptyState
            layout="screen"
            icon="clock"
            title="No results yet"
            body="Results land here at each deadline: who showed up, who missed, and where the pool went."
          />
        }
        ListFooterComponent={
          sections.length > 0 ? (
            <View style={styles.footer}>
              <Text variant="footnote" color="secondary">
                {FEED_RULE}
              </Text>
              <Text variant="footnote" color="secondary">
                {UNVERIFIED_RULE}
              </Text>
              <Text variant="footnote" color="secondary">
                {OTHER_STATES_RULE}
              </Text>
              {excluded ? (
                <Text variant="footnote" color="secondary">
                  {excluded}
                </Text>
              ) : null}
            </View>
          ) : undefined
        }
        removeClippedSubviews={Platform.OS !== 'web'}
        initialNumToRender={6}
        windowSize={7}
      />
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: useTheme().colors.bg }]}>
      <Stack.Screen options={{ title: 'Feed' }} />
      {content}
      <ReviewSheet
        target={target}
        open={sheetOpen}
        namer={namer}
        onClose={() => setSheetOpen(false)}
        onDone={(kind) => {
          setSheetOpen(false);
          onChanged();
          toast.show({
            message: kind === 'appeal' ? 'Appeal sent. The others can vote until Monday noon.' : 'Challenge sent. The others can vote until Monday noon.',
            icon: 'bubble.left',
          });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  grow: { flexGrow: 1 },
  list: { paddingTop: space.xs },
  dayHeader: { paddingTop: space.xl, paddingBottom: space.xs, paddingHorizontal: gutter + space.lg },
  dayHeaderText: { letterSpacing: 0.4 },
  block: {
    marginHorizontal: gutter,
    marginBottom: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  blockTitle: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm + 2,
    gap: 1,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  trailing: { alignItems: 'flex-end', gap: space.xs },
  thread: {
    flexDirection: 'row',
    gap: space.md,
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingVertical: space.md,
  },
  threadIcon: { width: 28, alignItems: 'center', paddingTop: 1 },
  threadBody: { flex: 1, gap: space.sm },
  threadHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  buttons: { flexDirection: 'row', gap: space.sm },
  photo: { width: PHOTO_SIZE, height: PHOTO_SIZE, borderRadius: radius.sm, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  photoImage: { width: PHOTO_SIZE, height: PHOTO_SIZE },
  summary: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footer: { paddingHorizontal: gutter + space.lg, paddingTop: space.sm, gap: space.md },
  skeleton: { paddingTop: space.lg },
  skeletonHeader: { marginHorizontal: gutter + space.lg, marginBottom: space.sm },
  skeletonBlock: { padding: space.lg, gap: space.md },
  skeletonRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
});

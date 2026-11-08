import { useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Image,
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
import { castVote } from '@/api/rpc';
import { REVIEW_PHOTO_BUCKET, supabase } from '@/api/supabase';
import type { ReviewKind } from '@/api/types';
import {
  Avatar,
  Button,
  EmptyState,
  Icon,
  ListRow,
  Pill,
  Skeleton,
  StatusPill,
  Text,
  reviewStatusTone,
  useToast,
} from '@/components';
import {
  carryNote,
  feedSections,
  instanceSubtitle,
  instanceSummary,
  nameOf,
  personDetail,
  shortName,
  type FeedDaySection,
  type FeedEntry,
  type InstanceGroup,
  type Namer,
  type PlaceEventEntry,
} from '@/features/feed/groupFeed';
import { ObjectionSheet, PlaceActions, type ObjectionTarget } from '@/features/place/PlaceGate';
import { placeEventFootnote, placeEventLine } from '@/features/place/placeCopy';
import { ReviewSheet } from '@/features/feed/ReviewSheet';
import {
  canVoteOn,
  defaultFootnote,
  kindLabel,
  myVoteText,
  openerLine,
  reviewOutcomeText,
  tally,
  tallyText,
  voteLabels,
} from '@/features/feed/reviewCopy';
import { useUserId } from '@/lib/auth';
import { classifyRpcError, userMessage } from '@/lib/errors';
import { reviewActions } from '@/lib/reviews';
import { formatDateInZone, formatTimeInZone } from '@/lib/time';
import { gutter, radius, space, useTheme } from '@/theme';

const FEED_RULE = "Missed a day you actually made? Appeal it. Something look off? Challenge it. The group votes before Monday's settle-up.";
const PLACE_RULE = 'A moved place counts once a friend confirms it, or after 24 hours if nobody objects. Until then the old place is judged.';
const UNVERIFIED_RULE =
  "Unverified means the app couldn't judge a tap (weak GPS, no fix, or a late offline send). It never costs a pledge and never wins one.";
const OTHER_STATES_RULE = "Frozen, Didn't count and Excluded days move no money either.";

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
            {openerLine(review.kind, nameOf(namer, review.opened_by), review.system_opened)}
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

// ---------- one place event: who moved where, how far, confirm / object ----------

function PlaceEventBlock({
  entry,
  namer,
  onObject,
  onChanged,
}: {
  entry: PlaceEventEntry;
  namer: Namer;
  onObject: (t: ObjectionTarget) => void;
  onChanged: () => void;
}) {
  const { colors } = useTheme();
  const n = { userId: namer.userId, nameOf: (id: string) => nameOf(namer, id) };
  const line = placeEventLine(entry.event, entry.pact.title, n);
  const footnote = placeEventFootnote(entry.event, entry.place ?? undefined, n);
  const waiting = entry.event.kind === 'created' && entry.place?.state === 'pending' && !entry.place.acknowledged_at;
  return (
    <View style={[styles.block, { backgroundColor: colors.surface, borderColor: colors.separator }]} accessibilityLabel={line}>
      <View style={styles.placeEvent}>
        <View style={styles.threadIcon}>
          <Icon name="location" size={18} color={entry.event.kind === 'objected' ? 'secondary' : 'tint'} />
        </View>
        <View style={styles.threadBody}>
          <View style={styles.threadHead}>
            <Text variant="subheadline" emphasis style={styles.flex}>
              {line}
            </Text>
            {waiting ? <Pill label="Waiting" tone="unverified" size="compact" /> : null}
          </View>
          {entry.event.kind === 'objected' && entry.event.reason ? <Text variant="callout">“{entry.event.reason}”</Text> : null}
          <Text variant="footnote" color="secondary">
            {formatTimeInZone(entry.event.created_at, entry.pact.tz)}
            {footnote ? ` · ${footnote}` : ''}
          </Text>
          {entry.place && entry.event.kind === 'created' ? (
            <PlaceActions
              place={entry.place}
              userId={namer.userId}
              ownerName={namer.profiles.get(entry.event.user_id)?.display_name ?? 'Someone'}
              onObject={onObject}
              onChanged={onChanged}
            />
          ) : null}
        </View>
      </View>
    </View>
  );
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
  const [objecting, setObjecting] = useState<ObjectionTarget | null>(null);
  const [objectOpen, setObjectOpen] = useState(false);

  const namer = useMemo<Namer>(() => ({ userId, profiles: feed.data?.profiles ?? new Map() }), [userId, feed.data?.profiles]);
  const sections = useMemo<FeedDaySection[]>(
    () => (feed.data ? feedSections(feed.data.items, feed.data.placeEvents, feed.data.pacts, feed.data.placesById, namer) : []),
    [feed.data, namer],
  );

  const onChanged = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['group', groupId] });
    void qc.invalidateQueries({ queryKey: ['pact'] });
  }, [qc, groupId]);

  const openSheet = useCallback((t: ReviewTarget) => {
    setTarget(t);
    setSheetOpen(true);
  }, []);

  const openObjection = useCallback((t: ObjectionTarget) => {
    setObjecting(t);
    setObjectOpen(true);
  }, []);

  const renderItem = useCallback(
    ({ item }: SectionListRenderItemInfo<FeedEntry, FeedDaySection>) => {
      if (!feed.data) return null;
      if (item.kind === 'place') return <PlaceEventBlock entry={item} namer={namer} onObject={openObjection} onChanged={onChanged} />;
      return <InstanceBlock group={item.group} feed={feed.data} namer={namer} onReview={openSheet} onChanged={onChanged} />;
    },
    [feed.data, namer, openSheet, openObjection, onChanged],
  );

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
      <SectionList<FeedEntry, FeedDaySection>
        sections={sections}
        keyExtractor={(e) => e.key}
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
              <Text variant="footnote" color="secondary">
                {PLACE_RULE}
              </Text>
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
        target={
          target
            ? {
                instanceId: target.item.result.instance_id,
                subjectUserId: target.item.result.user_id,
                subjectShortName: shortName(namer, target.item.result.user_id),
                dayLabel: formatDateInZone(target.item.instance.deadline_at, target.item.pact.tz),
                pactTitle: target.item.pact.title,
                groupId: target.item.pact.group_id,
                kind: target.kind,
              }
            : null
        }
        open={sheetOpen}
        userId={userId}
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
      <ObjectionSheet
        target={objecting}
        open={objectOpen}
        onClose={() => setObjectOpen(false)}
        onDone={(t) => {
          setObjectOpen(false);
          onChanged();
          toast.show({ message: `Objection sent. ${t.ownerName} has to set a new place.`, icon: 'location' });
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
  placeEvent: { flexDirection: 'row', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
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

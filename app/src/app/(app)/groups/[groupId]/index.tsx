import { useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  View,
} from "react-native";
import { displayName, useFeed, useGroupHome } from "@/api/queries";
import { leaveGroup } from "@/api/rpc";
import type { ProfileRow } from "@/api/types";
import {
  Avatar,
  EmptyState,
  Icon,
  ListGroup,
  ListRow,
  Pill,
  Screen,
  Sheet,
  Skeleton,
  SkeletonCard,
  Text,
  useToast,
} from "@/components";
import { HeaderIconButton } from "@/features/group/HeaderIconButton";
import { TodayCard } from "@/features/group/TodayCard";
import { nothingTodayBody, pactDetailLine } from "@/features/group/today";
import { useUserId } from "@/lib/auth";
import { userMessage } from "@/lib/errors";
import { inviteLink } from "@/lib/links";
import { formatCents } from "@/lib/money";
import { describeDays } from "@/lib/time";
import { nowMs } from "@/lib/useNow";
import { TOUCH_TARGET, haptic, space } from "@/theme";

const MAX_MEMBERS = 8;

export default function GroupHome() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const userId = useUserId();
  const home = useGroupHome(groupId, userId);
  const feed = useFeed(groupId);
  const qc = useQueryClient();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);

  if (home.isPending) return <GroupSkeleton />;
  if (home.isError) {
    return (
      <Screen>
        <Stack.Screen options={{ title: "Group" }} />
        <EmptyState
          layout="screen"
          icon="wifi.slash"
          title="Couldn't load this group"
          body={userMessage(home.error)}
          action={{ label: "Try again", onPress: () => void home.refetch() }}
        />
      </Screen>
    );
  }
  const { group, members, profiles, pacts, today, unjoinedPactIds } = home.data;
  const excluded = feed.data?.excludedThisMonth;

  const share = () =>
    void Share.share({
      message: `Join "${group.name}" on Show Up: ${inviteLink(group.invite_code)}\nOr enter code ${group.invite_code} in the app.`,
    });

  const copyCode = () => {
    void Clipboard.setStringAsync(group.invite_code).then(() => {
      haptic("snap");
      toast.show({
        message: `Invite code ${group.invite_code} copied`,
        icon: "doc.on.doc",
      });
    });
  };

  const confirmLeave = () =>
    Alert.alert(
      `Leave ${group.name}?`,
      "You'll leave its pacts too. Anything you still owe or are owed stays visible in Settle up until it's paid.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Leave",
          style: "destructive",
          onPress: () => {
            haptic("commit");
            void leaveGroup(groupId)
              .then(() => qc.invalidateQueries({ queryKey: ["groups"] }))
              .then(() => router.replace("/groups"))
              .catch((e: unknown) =>
                toast.show({
                  message: userMessage(e),
                  tone: "forfeit",
                  icon: "exclamationmark.triangle",
                }),
              );
          },
        },
      ],
    );

  const goFeed = () => router.push(`/groups/${groupId}/feed`);
  const goSettle = () => router.push(`/groups/${groupId}/ledger`);

  const openMenu = () => {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Feed", "Settle up", "Leave group…", "Cancel"],
          destructiveButtonIndex: 2,
          cancelButtonIndex: 3,
        },
        (i) => {
          if (i === 0) goFeed();
          else if (i === 1) goSettle();
          else if (i === 2) confirmLeave();
        },
      );
      return;
    }
    setMenuOpen(true);
  };

  const excludedNote =
    excluded && excluded.size > 0
      ? ` Excluded this month: ${[...excluded.entries()].map(([id, n]) => `${id === userId ? "you" : displayName(profiles, id)} ${n}`).join(", ")}.`
      : "";

  return (
    <>
      <Screen
        refreshing={home.isRefetching}
        onRefresh={() => void home.refetch()}
      >
        <Stack.Screen
          options={{
            title: group.name,
            headerLargeTitle: true,
            headerRight: () => (
              <View style={styles.headerRight}>
                <HeaderIconButton
                  name="square.and.arrow.up"
                  label="Invite"
                  hint="Shares the invite link and code"
                  onPress={share}
                />
                <HeaderIconButton
                  name="ellipsis.circle"
                  label="More"
                  hint="Feed, Settle up, Leave group"
                  onPress={openMenu}
                />
              </View>
            ),
          }}
        />

        <SectionHeader title="Today" first />
        {today.length === 0 ? (
          <EmptyState
            icon="clock"
            title="Nothing today"
            body={nothingTodayBody(pacts, nowMs())}
          />
        ) : (
          today.map((item) => (
            <TodayCard
              key={item.instance.id}
              item={item}
              userId={userId}
              profiles={profiles}
            />
          ))
        )}

        <ListGroup style={styles.section}>
          <ListRow
            leading={<Icon name="bubble.left" size={20} color="tint" />}
            title="Feed"
            subtitle="Results, appeals and votes"
            chevron
            onPress={goFeed}
          />
          <ListRow
            leading={<Icon name="arrow.up.right" size={20} color="tint" />}
            title="Settle up"
            subtitle="Who owes whom, with Venmo links"
            chevron
            onPress={goSettle}
          />
        </ListGroup>

        {pacts.length === 0 ? (
          <>
            <SectionHeader title="Pacts" />
            <EmptyState
              icon="location"
              title="No pacts yet"
              body='A pact is a place, a deadline and a pledge, like "Kane Hall by 9:00, weekdays". Everyone sets their own place.'
              action={{
                label: "New pact",
                onPress: () => router.push(`/groups/${groupId}/new-pact`),
              }}
            />
          </>
        ) : (
          <ListGroup header="Pacts" style={styles.section}>
            {pacts.map((pact) => {
              const unjoined = unjoinedPactIds.has(pact.id);
              return (
                <ListRow
                  key={pact.id}
                  title={pact.title}
                  subtitle={pactDetailLine(
                    describeDays(pact.days_of_week),
                    pact.deadline_local,
                    formatCents(pact.stake_cents),
                  )}
                  trailing={
                    pact.paused ? (
                      <Pill label="Paused" tone="pending" size="compact" />
                    ) : unjoined ? (
                      <Pill label="Set your place" tone="tint" size="compact" />
                    ) : undefined
                  }
                  chevron
                  onPress={() =>
                    router.push(
                      unjoined
                        ? `/pacts/${pact.id}/place`
                        : `/pacts/${pact.id}`,
                    )
                  }
                  accessibilityHint={
                    unjoined
                      ? "Opens the place picker to join"
                      : "Opens the pact"
                  }
                />
              );
            })}
            <ListRow
              leading={<Icon name="plus" size={20} color="tint" />}
              title="New pact…"
              onPress={() => router.push(`/groups/${groupId}/new-pact`)}
              accessibilityLabel="New pact"
            />
          </ListGroup>
        )}

        <ListGroup
          header={`Members · ${members.length} of ${MAX_MEMBERS}`}
          footer={`Share the link or the code. Anyone with it can join until the group has ${MAX_MEMBERS} people.${excludedNote}`}
          style={styles.section}
        >
          {members.map((m) => (
            <MemberRow
              key={m.user_id}
              userId={m.user_id}
              me={m.user_id === userId}
              owner={m.role === "owner"}
              profiles={profiles}
            />
          ))}
          <ListRow
            title={`Invite code ${group.invite_code}`}
            trailing={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Copy invite code"
                hitSlop={8}
                onPress={copyCode}
                style={styles.copy}
              >
                <Icon name="doc.on.doc" size={20} color="tint" />
              </Pressable>
            }
            accessibilityLabel={`Invite code ${group.invite_code.split("").join(" ")}`}
          />
        </ListGroup>

        <ListGroup style={styles.section}>
          <ListRow
            title="Leave group"
            destructive
            onPress={confirmLeave}
            accessibilityHint="Asks you to confirm"
          />
        </ListGroup>
      </Screen>

      <Sheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title={group.name}
      >
        <ListGroup>
          <ListRow
            leading={<Icon name="bubble.left" size={20} color="tint" />}
            title="Feed"
            chevron
            onPress={() => {
              setMenuOpen(false);
              goFeed();
            }}
          />
          <ListRow
            leading={<Icon name="arrow.up.right" size={20} color="tint" />}
            title="Settle up"
            chevron
            onPress={() => {
              setMenuOpen(false);
              goSettle();
            }}
          />
        </ListGroup>
        <ListGroup>
          <ListRow
            title="Leave group…"
            destructive
            onPress={() => {
              setMenuOpen(false);
              confirmLeave();
            }}
          />
        </ListGroup>
      </Sheet>
    </>
  );
}

function MemberRow({
  userId,
  me,
  owner,
  profiles,
}: {
  userId: string;
  me: boolean;
  owner: boolean;
  profiles: Map<string, ProfileRow>;
}) {
  const name = displayName(profiles, userId);
  const detail = [me ? "you" : null, owner ? "owner" : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <ListRow
      leading={
        <Avatar person={{ id: userId, name }} size={32} highlighted={me} />
      }
      title={name}
      subtitle={detail || undefined}
      accessibilityLabel={detail ? `${name}, ${detail}` : name}
    />
  );
}

function SectionHeader({ title, first }: { title: string; first?: boolean }) {
  return (
    <Text
      variant="footnote"
      color="secondary"
      style={[styles.sectionHeader, first && styles.sectionHeaderFirst]}
    >
      {title}
    </Text>
  );
}

function GroupSkeleton() {
  return (
    <Screen>
      <Stack.Screen options={{ title: " ", headerLargeTitle: true }} />
      <View style={styles.skeletonHeader}>
        <Skeleton width="30%" height={14} />
      </View>
      <SkeletonCard lines={4} />
      <SkeletonCard lines={3} />
      <View style={styles.skeletonHeader}>
        <Skeleton width="40%" height={14} />
      </View>
      <SkeletonCard lines={2} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRight: { flexDirection: "row", alignItems: "center" },
  section: { marginTop: space.md },
  sectionHeader: {
    paddingHorizontal: space.lg,
    marginTop: space.md,
    marginBottom: -space.sm,
  },
  sectionHeaderFirst: { marginTop: 0 },
  copy: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    marginRight: -space.md,
  },
  skeletonHeader: { paddingHorizontal: space.lg, paddingTop: space.xs },
});

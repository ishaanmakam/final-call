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
import { displayName, useGroupHome } from "@/api/queries";
import { leaveGroup } from "@/api/rpc";
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
import { HeaderIconButton, HeaderItems } from "@/features/group/HeaderIconButton";
import { TodayCard } from "@/features/group/TodayCard";
import { nothingTodayBody, pactDetailLine } from "@/features/group/today";
import { useUserId } from "@/lib/auth";
import { classifyRpcError, userMessage } from "@/lib/errors";
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
  const qc = useQueryClient();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);

  if (home.isPending) return <GroupSkeleton />;
  if (home.isError) {
    const offline = classifyRpcError(home.error) === "network";
    return (
      <Screen>
        <Stack.Screen options={{ title: "Group" }} />
        <EmptyState
          layout="screen"
          icon={offline ? "wifi.slash" : "exclamationmark.triangle"}
          title={offline ? "You're offline" : "Couldn't load this group"}
          body={
            offline
              ? "Today's pacts will appear once you have a connection. Nothing about today is lost."
              : userMessage(home.error)
          }
          action={{
            label: "Try again",
            onPress: () => void home.refetch(),
            loading: home.isFetching,
          }}
        />
      </Screen>
    );
  }
  const { group, members, profiles, pacts, today, unjoinedPactIds } = home.data;

  const share = () =>
    void Share.share({
      message: `Join "${group.name}" on Final Call: ${inviteLink(group.invite_code)}\nOr enter code ${group.invite_code} in the app.`,
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
  const goStats = () => router.push(`/groups/${groupId}/stats`);

  const openMenu = () => {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Feed", "Settle up", "Stats", "Leave group…", "Cancel"],
          destructiveButtonIndex: 3,
          cancelButtonIndex: 4,
        },
        (i) => {
          if (i === 0) goFeed();
          else if (i === 1) goSettle();
          else if (i === 2) goStats();
          else if (i === 3) confirmLeave();
        },
      );
      return;
    }
    setMenuOpen(true);
  };

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
              <HeaderItems>
                <HeaderIconButton
                  name="square.and.arrow.up"
                  label="Invite"
                  hint="Shares the invite link and code"
                  onPress={share}
                />
                <HeaderIconButton
                  name="ellipsis.circle"
                  label="More"
                  hint="Feed, Settle up, Stats, Leave group"
                  onPress={openMenu}
                />
              </HeaderItems>
            ),
          }}
        />

        {/* No pacts: the Pacts empty state below teaches; a second illustration would compete with it.
            Pacts but nothing today: one quiet row that names the next day, not a full empty state. */}
        {pacts.length > 0 ? <SectionHeader title="Today" first /> : null}
        {pacts.length === 0 ? null : today.length === 0 ? (
          <ListGroup>
            <ListRow
              leading={<Icon name="clock" size={20} color="secondary" />}
              title="Nothing today"
              subtitle={nothingTodayBody(pacts, nowMs())}
            />
          </ListGroup>
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

        <ListGroup style={pacts.length > 0 ? styles.section : undefined}>
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
          <ListRow
            leading={<Icon name="chart.bar" size={20} color="tint" />}
            title="Stats"
            subtitle="Settle-up rate, seasons, streaks"
            chevron
            onPress={goStats}
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
          footer={`Share the link or the code. Anyone with it can join until the group has ${MAX_MEMBERS} people.`}
          style={styles.section}
        >
          {/* rows are direct ListRow children so ListGroup can give them corners and separators */}
          {members.map((m) => {
            const me = m.user_id === userId;
            const name = displayName(profiles, m.user_id);
            const detail = [me ? "you" : null, m.role === "owner" ? "owner" : null]
              .filter(Boolean)
              .join(" · ");
            return (
              <ListRow
                key={m.user_id}
                leading={
                  <Avatar
                    person={{ id: m.user_id, name }}
                    size={32}
                    highlighted={me}
                  />
                }
                title={name}
                subtitle={detail || undefined}
                accessibilityLabel={detail ? `${name}, ${detail}` : name}
              />
            );
          })}
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
          <ListRow
            leading={<Icon name="chart.bar" size={20} color="tint" />}
            title="Stats"
            chevron
            onPress={() => {
              setMenuOpen(false);
              goStats();
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

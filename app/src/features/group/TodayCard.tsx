import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { displayName, type TodayItem } from '../../api/queries';
import type { ProfileRow } from '../../api/types';
import { AvatarStack, Button, Card, Countdown, ProgressRing, StatusPill, Text } from '../../components';
import { formatTimeInZone, msUntil, type WindowState } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { PRESS_SCALE, space, transition, useReducedMotion } from '../../theme';
import { useWindowPhase } from '../checkin/useWindowPhase';
import { checkedInIds, myPillState, resultTally, todayStatusLine } from './today';

export interface TodayCardProps {
  item: TodayItem;
  userId: string;
  profiles: Map<string, ProfileRow>;
}

/** "14:32 left · by 9:00 AM": the only thing on a card that ticks, so only this line re-renders. */
function LiveTiming({ deadlineAt, tz }: { deadlineAt: string; tz: string }) {
  const now = useNow(1000);
  return (
    <View style={styles.timing}>
      <Countdown ms={msUntil(deadlineAt, now)} variant="subheadline" color="secondary" announceAtMinutes={[]} />
      <Text variant="subheadline" color="secondary" tabular>
        {` left · by ${formatTimeInZone(deadlineAt, tz)}`}
      </Text>
    </View>
  );
}

function timingText(phase: WindowState, item: TodayItem): string {
  const { instance, pact } = item;
  if (instance.status === 'voided') return "Didn't count today";
  if (phase === 'before') return `Opens ${formatTimeInZone(instance.window_open_at, pact.tz)} · by ${formatTimeInZone(instance.deadline_at, pact.tz)}`;
  return `Closed ${formatTimeInZone(instance.deadline_at, pact.tz)}`;
}

/**
 * One live object per instance today: title, timing, who's in (ring + avatars), your state, and the
 * one action. Tapping anywhere opens the check-in screen when you are in the pact.
 */
export function TodayCard({ item, userId, profiles }: TodayCardProps) {
  const { instance, pact, summary, participantIds, myState } = item;
  const reduced = useReducedMotion();
  const [pressed, setPressed] = useState(false);
  const phase = useWindowPhase(instance.window_open_at, instance.deadline_at);
  const closed = ['closed', 'settled', 'voided'].includes(instance.status) || phase === 'closed';
  const amIn = participantIds.includes(userId);
  const open = phase === 'open' && !closed;
  const inIds = checkedInIds(summary);
  const people = participantIds.map((id) => ({ id, name: id === userId ? 'You' : displayName(profiles, id) }));
  const pill = myPillState(myState, closed);
  const status = instance.status === 'voided' ? 'Fewer than two people were in it, so nothing counts.' : closed ? resultTally(summary) : todayStatusLine(summary, myState);
  const allIn = summary.total > 0 && summary.checkedIn === summary.total;
  const showCheckIn = amIn && open && myState !== 'checked_in' && !pill;
  const openCheckin = () => router.push(`/checkin/${instance.id}`);
  const timingLabel = open ? `${formatTimeInZone(instance.deadline_at, pact.tz)} deadline` : timingText(phase, item);

  const body = (
    <Card>
      <View style={styles.head}>
        <View style={styles.titles}>
          <Text variant="headline" numberOfLines={2}>
            {pact.title}
          </Text>
          {open ? (
            <LiveTiming deadlineAt={instance.deadline_at} tz={pact.tz} />
          ) : (
            <Text variant="subheadline" color="secondary">
              {timingText(phase, item)}
            </Text>
          )}
        </View>
        {instance.status !== 'voided' ? (
          <ProgressRing
            size={52}
            strokeWidth={4}
            progress={summary.total > 0 ? summary.checkedIn / summary.total : 0}
            color={allIn ? 'success' : 'tint'}
            accessibilityLabel={`${summary.checkedIn} of ${summary.total} checked in`}
          >
            <Text variant="caption1" emphasis tabular>
              {summary.checkedIn}/{summary.total}
            </Text>
          </ProgressRing>
        ) : null}
      </View>
      <View style={styles.row}>
        <AvatarStack people={people} max={5} size={32} highlightIds={inIds} />
        {pill ? <StatusPill state={pill} who="You" /> : instance.status === 'voided' ? <StatusPill state="void" /> : null}
      </View>
      <Text variant="subheadline" color="secondary">
        {status}
      </Text>
      {showCheckIn ? <Button title="Check in" onPress={openCheckin} style={styles.action} /> : null}
    </Card>
  );

  if (!amIn || instance.status === 'voided') return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${pact.title}, ${timingLabel}, ${status}`}
      accessibilityHint="Opens check-in"
      onPress={openCheckin}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      pressRetentionOffset={16}
    >
      {/* feedback on press-in (120 ms ease-out); reduced motion dims instead of scaling */}
      <Animated.View style={[styles.pressable, pressTransition, pressed && (reduced ? styles.pressedReduced : styles.pressed)]}>{body}</Animated.View>
    </Pressable>
  );
}

const pressTransition = transition(['transform', 'opacity'], 'press');

const styles = StyleSheet.create({
  pressable: { transform: [{ scale: 1 }], opacity: 1 },
  pressed: { transform: [{ scale: PRESS_SCALE }] },
  pressedReduced: { opacity: 0.85 },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  titles: { flex: 1, gap: space.xxs },
  timing: { flexDirection: 'row', alignItems: 'baseline' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  action: { marginTop: space.xs },
});

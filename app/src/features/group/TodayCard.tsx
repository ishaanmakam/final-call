import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { displayName, useInstanceNets, type TodayItem } from '../../api/queries';
import { toNumber, type ProfileRow, type ResultRow } from '../../api/types';
import { AvatarStack, Button, Card, Countdown, ProgressRing, StatusPill, Text } from '../../components';
import { formatTimeInZone, msUntil, type WindowState } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { PRESS_SCALE, space, transition, useReducedMotion } from '../../theme';
import { gateClose } from '../checkin/gateClose';
import { useWindowPhase } from '../checkin/useWindowPhase';
import { isGoalKind, progressFraction, standingsSummary, timeLeftText } from '../goal/goal';
import { weekTimingLine } from '../goal/progress';
import { useDistanceUnit } from '../goal/useDistanceUnit';
import { checkedInIds, closedTimingText, myPillState, openTimingPrefix, resultTally, todayStatusLine } from './today';

export interface TodayCardProps {
  item: TodayItem;
  userId: string;
  profiles: Map<string, ProfileRow>;
}

/**
 * "Boarding · 14:32 left · by 9:00 AM", "Final call · 14:59 left · by 9:00 AM" in the forfeit tone
 * for the last fifteen minutes: the only thing on a card that ticks, so only this line re-renders.
 */
function LiveTiming({ deadlineAt, tz }: { deadlineAt: string; tz: string }) {
  const now = useNow(1000);
  const remaining = msUntil(deadlineAt, now);
  const prefix = openTimingPrefix(remaining);
  const color = prefix === 'Final call' ? 'forfeit' : 'secondary';
  return (
    <View style={styles.timing}>
      <Text variant="subheadline" color={color}>
        {prefix} ·{' '}
      </Text>
      <Countdown ms={remaining} variant="subheadline" color={color} announceAtMinutes={[]} />
      <Text variant="subheadline" color={color} tabular>
        {` left · by ${formatTimeInZone(deadlineAt, tz)}`}
      </Text>
    </View>
  );
}

function timingText(phase: WindowState, item: TodayItem, nowMs: number): string {
  const { instance, pact } = item;
  if (instance.status === 'voided') return pact.period === 'daily' ? "Didn't count today" : "Didn't count this week";
  // weekly / race cards: "This week · Boarding · 2 days left" in the airport voice (features/goal/progress.ts)
  if (pact.period === 'weekly') return `This week · ${weekTimingLine(instance, pact.tz, nowMs).text}`;
  if (pact.period === 'once') return phase === 'closed' ? 'Gate closed · the race is over' : `Race · ${timeLeftText(instance.deadline_at, nowMs)}`;
  if (phase === 'before') return `Opens ${formatTimeInZone(instance.window_open_at, pact.tz)} · by ${formatTimeInZone(instance.deadline_at, pact.tz)}`;
  return closedTimingText(formatTimeInZone(instance.deadline_at, pact.tz));
}

/** The live member states folded back into result rows for the gate-close wording (names and tallies). */
function resultsFromSummary(item: TodayItem): ResultRow[] {
  const out: ResultRow[] = [];
  for (const [user_id, state] of Object.entries(item.summary.byUser)) {
    const status: ResultRow['status'] | null =
      state === 'success' || state === 'failed' || state === 'unverified' || state === 'frozen' || state === 'void' || state === 'excluded' ? state : null;
    if (status) out.push({ instance_id: item.instance.id, user_id, status, first_success_at: null, decided_at: null });
  }
  return out;
}

/**
 * One live object per instance today: title, timing, who's in (ring + avatars), your state, and the
 * one action. Tapping anywhere opens the check-in screen when you are in the pact. Once the gate is
 * closed and you were in it, the status line is the gate-close headline in its compact form
 * ("+$2.00 · Diego missed"), with the money read from the ledger.
 */
export function TodayCard({ item, userId, profiles }: TodayCardProps) {
  const { instance, pact, summary, participantIds, myState, goal } = item;
  const reduced = useReducedMotion();
  const unit = useDistanceUnit();
  const [pressed, setPressed] = useState(false);
  const phase = useWindowPhase(instance.window_open_at, instance.deadline_at);
  const closed = ['closed', 'settled', 'voided'].includes(instance.status) || phase === 'closed';
  const amIn = participantIds.includes(userId);
  const open = phase === 'open' && !closed;
  const inIds = checkedInIds(summary);
  const people = participantIds.map((id) => ({ id, name: id === userId ? 'You' : displayName(profiles, id) }));
  const pill = myPillState(myState, closed);
  const posted = ['closed', 'settled', 'voided'].includes(instance.status);
  const nets = useInstanceNets(instance.id, closed && amIn && posted);
  const allIn = summary.total > 0 && summary.checkedIn === summary.total;
  // goal kinds (CB): the ring is your own progress, the status line the standings, and tapping opens the pact
  const goalKind = isGoalKind(pact.kind);
  const myProgress = goal?.progress.find((p) => p.user_id === userId) ?? null;
  const myFraction = myProgress ? progressFraction(toNumber(myProgress.value), toNumber(myProgress.goal)) : null;
  const showCheckIn = amIn && open && myState !== 'checked_in' && !pill && !goalKind;
  const openCheckin = () => router.push(goalKind ? `/pacts/${pact.id}` : `/checkin/${instance.id}`);
  const nameOf = (id: string) => (id === userId ? 'You' : displayName(profiles, id));
  const timingLabel = open && !goalKind ? `${formatTimeInZone(instance.deadline_at, pact.tz)} deadline` : timingText(phase, item, Date.now());

  let status: string;
  let gateTone: 'success' | 'forfeit' | null = null;
  if (closed && amIn) {
    const results = resultsFromSummary(item);
    const myResult = results.find((r) => r.user_id === userId) ?? null;
    const gate = gateClose({
      userId,
      instanceStatus: instance.status,
      myResult,
      results,
      nets: nets.data ?? [],
      profiles,
      stakeCents: pact.stake_cents,
      carryInCents: instance.carry_in_cents,
      frozen: myState === 'frozen',
      sinceDeadlineMs: Date.now() - Date.parse(instance.deadline_at),
      goal: goalKind,
      period: pact.period,
    });
    // the money line waits for the ledger read; until then the plain tally
    status = posted && nets.isPending && gate.amount ? resultTally(summary) : gate.compact;
    if (gate.state === 'posted' && gate.amount) gateTone = gate.tone === 'forfeit' ? 'forfeit' : 'success';
  } else if (instance.status === 'voided') {
    status = 'Fewer than two people were in it, so nothing counts.';
  } else if (goalKind && goal) {
    status = standingsSummary(goal.standings, userId, nameOf, pact, unit);
  } else {
    status = closed ? resultTally(summary) : todayStatusLine(summary, myState);
  }

  const body = (
    <Card>
      <View style={styles.head}>
        <View style={styles.titles}>
          <Text variant="headline" numberOfLines={2}>
            {pact.title}
          </Text>
          {open && !goalKind ? (
            <LiveTiming deadlineAt={instance.deadline_at} tz={pact.tz} />
          ) : (
            <Text variant="subheadline" color={goalKind && timingLabel.startsWith('This week · Final call') ? 'forfeit' : 'secondary'}>
              {timingLabel}
            </Text>
          )}
        </View>
        {instance.status !== 'voided' ? (
          myFraction !== null ? (
            <ProgressRing
              size={52}
              strokeWidth={4}
              progress={myFraction}
              color={myFraction >= 1 ? 'success' : closed ? 'forfeit' : 'tint'}
              accessibilityLabel={`${Math.round(myFraction * 100)} percent of your goal`}
            >
              <Text variant="caption1" emphasis tabular>
                {Math.round(myFraction * 100)}%
              </Text>
            </ProgressRing>
          ) : (
            <ProgressRing
              size={52}
              strokeWidth={4}
              progress={summary.total > 0 ? summary.checkedIn / summary.total : 0}
              color={allIn ? 'success' : 'tint'}
              accessibilityLabel={goalKind ? `${summary.checkedIn} of ${summary.total} reached the goal` : `${summary.checkedIn} of ${summary.total} checked in`}
            >
              <Text variant="caption1" emphasis tabular>
                {summary.checkedIn}/{summary.total}
              </Text>
            </ProgressRing>
          )
        ) : null}
      </View>
      <View style={styles.row}>
        <AvatarStack people={people} max={5} size={32} highlightIds={inIds} />
        {pill ? <StatusPill state={pill} who="You" /> : instance.status === 'voided' ? <StatusPill state="void" /> : null}
      </View>
      <Text variant="subheadline" color={gateTone ?? 'secondary'} emphasis={gateTone !== null} tabular={gateTone !== null}>
        {status}
      </Text>
      {showCheckIn ? <Button title="Check in" onPress={openCheckin} style={styles.action} /> : null}
    </Card>
  );

  if ((!amIn && !goalKind) || instance.status === 'voided') return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${pact.title}, ${timingLabel}, ${status}`}
      accessibilityHint={goalKind ? 'Opens the challenge' : 'Opens check-in'}
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
  timing: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  action: { marginTop: space.xs },
});

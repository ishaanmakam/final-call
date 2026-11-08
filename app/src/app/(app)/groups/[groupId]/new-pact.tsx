import { useQueryClient } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { createPact, joinPact, setPactSeason } from '@/api/rpc';
import type { ActivityType } from '@/api/types';
import {
  Button,
  Card,
  Icon,
  ListGroup,
  ListRow,
  Screen,
  SegmentedControl,
  Sheet,
  Text,
  TextField,
  useToast,
} from '@/components';
import { TimePicker } from '@/components/TimePicker';
import { activityTypeLabel, metersToUnit, unitToMeters, type DistanceUnit } from '@/features/goal/goal';
import { deviceDistanceUnit } from '@/features/goal/useDistanceUnit';
import { ensureHealthPermission } from '@/features/health/healthRuntime';
import {
  ALL_WORKOUT_TYPES,
  CHALLENGE_OPTIONS,
  DAY_CELLS,
  DEFAULT_DRAFT,
  QUICK_AMOUNTS_CENTS,
  QUICK_PICKS,
  WINDOW_PRESETS,
  activeQuickPick,
  applyQuickPick,
  challengeOption,
  describeWindow,
  draftSeason,
  draftToCreateInput,
  draftWindowOpen,
  goalSummaryLine,
  isDraftDirty,
  offsetLabel,
  parseGoalNumber,
  pledgeFieldLabel,
  pledgeSentence,
  presetLabel,
  selectChoice,
  stepTitle,
  suggestedTitle,
  toggleDay,
  validateGoal,
  validatePledge,
  validateWhat,
  validateWhen,
  wizardSteps,
  type ChallengeChoice,
  type StepId,
  type WizardDraft,
} from '@/features/pact/wizard';
import { searchTimeZones, timeZoneDisplayName, timeZoneOffsetLabel, timeZoneOptions } from '@/features/shared/timeZones';
import { DatePicker } from '@/features/stats/DatePicker';
import { formatLocalDay, seasonSummary } from '@/features/stats/season';
import { userMessage } from '@/lib/errors';
import { centsToDecimalString, formatCents, parseDollarsToCents } from '@/lib/money';
import { describeDays, deviceTimeZone, displayMinutes, formatDateInZone, formatTimeInZone, localDateInZone, nextOccurrence, toPgTime } from '@/lib/time';
import { TOUCH_TARGET, haptic, radius, space, useTheme } from '@/theme';

export default function NewPactWizard() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const { colors } = useTheme();
  const [stepIndex, setStepIndex] = useState(0);
  const [draft, setDraft] = useState<WizardDraft>(() => ({ ...DEFAULT_DRAFT, tz: deviceTimeZone(), unit: deviceDistanceUnit() }));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [tzOpen, setTzOpen] = useState(false);
  const creating = useRef(false);
  const [leaving, setLeaving] = useState(false);
  const [destination, setDestination] = useState<string | null>(null);

  const patch = (p: Partial<WizardDraft>) => setDraft((d) => ({ ...d, ...p }));
  const windowOpen = draftWindowOpen(draft);
  const dirty = isDraftDirty(draft);
  const steps = wizardSteps(draft.choice);
  const step: StepId = steps[Math.min(stepIndex, steps.length - 1)] ?? 'kind';
  const lastStep = stepIndex === steps.length - 1;
  const option = challengeOption(draft.choice);
  const goalKind = option.kind !== 'show_up';
  const today = localDateInZone(Date.now(), draft.tz || deviceTimeZone());

  // Swipe-to-dismiss or Cancel with a dirty form asks first (native only; the web harness has no alerts).
  usePreventRemove(Platform.OS !== 'web' && dirty && !leaving, ({ repeat }) => {
    Alert.alert('Discard this pact?', "What you've entered so far won't be saved.", [
      { text: 'Keep editing', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => {
          setLeaving(true);
          repeat();
        },
      },
    ]);
  });

  useEffect(() => {
    if (destination) router.replace(destination);
  }, [destination]);

  const whatErrors = validateWhat(draft);
  const whenErrors = validateWhen({ windowOpen, deadline: draft.deadline, tz: draft.tz });
  const pledgeErrors = validatePledge(draft.dollars);
  const goalErrors = validateGoal(draft, today);
  const stepErrors: Record<StepId, object> = { kind: {}, what: whatErrors, when: whenErrors, goal: goalErrors, pledge: pledgeErrors };
  const stepValid = Object.values(stepErrors[step]).every((e) => !e);
  const show = touched;

  const preview = useMemo(() => {
    if (whenErrors.tz || draft.days.length === 0) return null;
    try {
      return nextOccurrence(Date.now(), draft.days, toPgTime(draft.deadline), draft.tz);
    } catch {
      return null;
    }
  }, [draft.days, draft.deadline, draft.tz, whenErrors.tz]);

  const stakeCents = parseDollarsToCents(draft.dollars);
  const season = goalKind ? null : draftSeason(draft, Date.now());

  const next = async () => {
    setTouched(true);
    if (!stepValid) {
      haptic('error');
      return;
    }
    if (!lastStep) {
      setTouched(false);
      setStepIndex(stepIndex + 1);
      return;
    }
    if (creating.current) return;
    creating.current = true;
    setBusy(true);
    setServerError(null);
    try {
      const input = draftToCreateInput(draft, groupId);
      const pactId = await createPact(input);
      let note = '';
      if (goalKind) {
        // the creator is in from the start: no place to set, so join now and ask Health once
        try {
          await joinPact({ pactId });
          if (option.kind !== 'custom') await ensureHealthPermission();
        } catch {
          note = ' Joining failed; you can join from the pact.';
        }
      } else if (season) {
        // the season is a second call: a failure there must not lose the pact that was just created
        try {
          await setPactSeason(pactId, season.start, season.weeks);
        } catch {
          note = " The season didn't start; you can start it from the pact.";
        }
      }
      await qc.invalidateQueries({ queryKey: ['group', groupId] });
      toast.show({
        message: goalKind
          ? `Challenge created.${note || (option.kind === 'custom' ? ' Mark each day done before midnight.' : ' Sync your runs from the pact.')}`
          : `Pact created. Now set your place.${note}`,
        tone: note ? 'neutral' : 'success',
        icon: 'checkmark',
      });
      // lift the dismiss guard first (usePreventRemove's effect runs before the one below), then leave
      setLeaving(true);
      setDestination(goalKind ? `/pacts/${pactId}` : `/pacts/${pactId}/place`);
    } catch (e) {
      const message = userMessage(e);
      setServerError(message);
      haptic('error');
    } finally {
      creating.current = false;
      setBusy(false);
    }
  };

  const back = () => {
    if (stepIndex === 0) {
      router.back();
      return;
    }
    setTouched(false);
    setStepIndex(stepIndex - 1);
  };

  const pick = (choice: ChallengeChoice) => {
    haptic('selection');
    setDraft((d) => selectChoice(d, choice, today));
  };

  const switchUnit = (unit: DistanceUnit) => {
    if (unit === draft.unit) return;
    haptic('selection');
    const n = parseGoalNumber(draft.goalText);
    const converted = n === null ? draft.goalText : String(Math.round(metersToUnit(unitToMeters(n, draft.unit), unit) * 10) / 10);
    patch({ unit, goalText: converted });
  };

  const toggleType = (t: ActivityType) => {
    haptic('selection');
    patch({ workoutTypes: draft.workoutTypes.includes(t) ? draft.workoutTypes.filter((x) => x !== t) : [...draft.workoutTypes, t] });
  };

  const titlePlaceholder = suggestedTitle(draft) || (option.kind === 'custom' ? 'Read 20 pages' : '9am class');
  const summaryTitle = draft.title.trim() || suggestedTitle(draft) || 'Your pact';

  return (
    <Screen
      footer={
        <Button
          title={lastStep ? (goalKind ? 'Create challenge' : 'Create pact') : 'Next'}
          onPress={() => void next()}
          loading={busy}
          accessibilityHint={lastStep ? (goalKind ? 'Creates the challenge and joins you to it' : 'Creates the pact, then asks for your place') : `Goes to step ${stepIndex + 2} of ${steps.length}`}
        />
      }
    >
      <Stack.Screen
        options={{
          title: stepTitle(step, draft.choice),
          headerBackVisible: false,
          gestureEnabled: !dirty,
          headerLeft: () => <HeaderButton label={stepIndex === 0 ? 'Cancel' : 'Back'} onPress={back} />,
        }}
      />
      <StepDots step={stepIndex} count={steps.length} />

      {step === 'kind' ? (
        <ListGroup footer="Everyone in the challenge plays the same game. The pledge, the pool and the weekly settle-up work the same way for every kind.">
          {CHALLENGE_OPTIONS.map((o) => {
            const selected = o.id === draft.choice;
            return (
              <ListRow
                key={o.id}
                leading={<Icon name={o.icon} size={22} color={selected ? 'tint' : 'secondary'} />}
                title={o.title}
                subtitle={o.gloss}
                trailing={selected ? <Icon name="checkmark" size={18} color="tint" accessibilityLabel="Selected" /> : undefined}
                onPress={() => pick(o.id)}
                accessibilityLabel={`${o.title}. ${o.gloss}${selected ? '. Selected' : ''}`}
                accessibilityHint="Picks this kind of challenge"
              />
            );
          })}
        </ListGroup>
      ) : null}

      {step === 'what' ? (
        <>
          <TextField
            label="Title"
            value={draft.title}
            onChangeText={(title) => patch({ title })}
            placeholder="9am class"
            helper={show && whatErrors.title ? undefined : 'Like "Gym before dinner" or "Sunrise run".'}
            error={show ? whatErrors.title : undefined}
            maxLength={60}
            autoFocus
            returnKeyType="next"
            onSubmitEditing={() => void next()}
          />
          <ListGroup header="Days" footer="Everyone picks their own place next, so one pact can cover different buildings.">
            <View style={[styles.daysBlock, { backgroundColor: colors.surface }]}>
              <DayStrip days={draft.days} onToggle={(iso) => patch({ days: toggleDay(draft.days, iso) })} />
              <QuickPicks days={draft.days} onPick={(days) => patch({ days })} />
              {show && whatErrors.days ? (
                <Text variant="footnote" color="forfeit" accessibilityLiveRegion="polite">
                  {whatErrors.days}
                </Text>
              ) : null}
            </View>
          </ListGroup>
        </>
      ) : null}

      {step === 'when' ? (
        <>
          <ListGroup
            footer={
              show && whenErrors.window
                ? undefined
                : `You can check in from ${displayMinutes(Math.max(0, windowOpen))} until ${displayMinutes(draft.deadline)}. Default is an hour before.`
            }
          >
            <ListRow
              title="Deadline"
              trailing={<TimePicker minutes={draft.deadline} onChange={(deadline) => patch({ deadline })} accessibilityLabel="Deadline" />}
              accessibilityLabel={`Deadline, ${displayMinutes(draft.deadline)}`}
            />
            <ListRow
              title="Check-in opens"
              subtitle={draft.windowOffset === null ? offsetLabel(windowOpen, draft.deadline) : `${presetLabel(draft.windowOffset)} before`}
              trailing={
                draft.windowOffset === null ? (
                  <TimePicker minutes={draft.customOpen} onChange={(customOpen) => patch({ customOpen })} accessibilityLabel="Check-in opens" />
                ) : (
                  <Text variant="body" color="secondary" tabular>
                    {displayMinutes(Math.max(0, windowOpen))}
                  </Text>
                )
              }
            />
            <View style={[styles.presetWrap, { backgroundColor: colors.surface }]}>
              <SegmentedControl
                segments={[...WINDOW_PRESETS.map(presetLabel), 'Other']}
                index={draft.windowOffset === null ? WINDOW_PRESETS.length : WINDOW_PRESETS.indexOf(draft.windowOffset)}
                onChange={(i) => {
                  const preset = WINDOW_PRESETS[i];
                  if (preset === undefined) patch({ windowOffset: null, customOpen: Math.max(0, windowOpen) });
                  else patch({ windowOffset: preset });
                }}
                accessibilityLabel="How long before the deadline check-in opens"
              />
              {show && whenErrors.window ? (
                <Text variant="footnote" color="forfeit" accessibilityLiveRegion="polite">
                  {whenErrors.window}
                </Text>
              ) : null}
            </View>
          </ListGroup>

          <ListGroup footer={`Times follow ${timeZoneDisplayName(draft.tz)}, including daylight-saving changes.`}>
            <ListRow
              title="Time zone"
              trailing={
                <Text variant="body" color="secondary">
                  {timeZoneDisplayName(draft.tz)}
                </Text>
              }
              chevron
              onPress={() => setTzOpen(true)}
              accessibilityLabel={`Time zone, ${timeZoneDisplayName(draft.tz)}`}
              accessibilityHint="Opens a list of time zones"
            />
            {preview ? (
              <ListRow
                title="First day"
                trailing={
                  <Text variant="body" emphasis tabular>
                    {formatDateInZone(preview.deadlineAt, draft.tz)} by {formatTimeInZone(preview.deadlineAt, draft.tz)}
                  </Text>
                }
              />
            ) : null}
          </ListGroup>
        </>
      ) : null}

      {step === 'goal' && option.kind === 'distance' ? (
        <>
          <TextField
            label={`Distance in ${draft.unit}`}
            value={draft.goalText}
            onChangeText={(goalText) => patch({ goalText })}
            keyboardType="decimal-pad"
            inputMode="decimal"
            placeholder={draft.unit === 'mi' ? '15' : '25'}
            error={show ? goalErrors.goal : undefined}
            clearable={false}
            selectTextOnFocus
            autoFocus
          />
          <View style={styles.segmentRow}>
            <SegmentedControl segments={['mi', 'km']} index={draft.unit === 'mi' ? 0 : 1} onChange={(i) => switchUnit(i === 0 ? 'mi' : 'km')} accessibilityLabel="Distance unit" style={styles.unitSegment} />
          </View>
          <Text variant="footnote" color="secondary" style={styles.unitHelper}>
            {`Accepted ${option.activityTypes?.map((t) => `${activityTypeLabel(t).toLowerCase()}s`).join(' and ')} from Apple Health or Strava add up. Manual entries don't count.`}
          </Text>
          <ListGroup
            header="When"
            footer={
              draft.goalPeriod === 'once'
                ? 'One race: everything from the first day to the end of the last counts. Fall short and the pledge is forfeited once.'
                : 'Weeks run Monday to Sunday night. Each week is its own round: reach the goal or forfeit that week.'
            }
          >
            <View style={[styles.presetWrap, { backgroundColor: colors.surface }]}>
              <SegmentedControl
                segments={['Every week', 'A race']}
                index={draft.goalPeriod === 'once' ? 1 : 0}
                onChange={(i) => {
                  haptic('selection');
                  patch({ goalPeriod: i === 1 ? 'once' : 'weekly' });
                }}
                accessibilityLabel="Every week or a one-off race"
              />
            </View>
            {draft.goalPeriod === 'once' ? (
              <ListRow
                title="Starts"
                trailing={<DatePicker value={draft.raceStart} onChange={(raceStart) => patch({ raceStart, raceEnd: draft.raceEnd < raceStart ? raceStart : draft.raceEnd })} accessibilityLabel="Race starts" minimum={today} />}
                accessibilityLabel={`Starts ${formatLocalDay(draft.raceStart)}`}
              />
            ) : null}
            {draft.goalPeriod === 'once' ? (
              <ListRow
                title="Ends"
                trailing={<DatePicker value={draft.raceEnd} onChange={(raceEnd) => patch({ raceEnd })} accessibilityLabel="Race ends" minimum={draft.raceStart || today} />}
                accessibilityLabel={`Ends ${formatLocalDay(draft.raceEnd)}`}
              />
            ) : null}
            {show && goalErrors.race ? (
              <View style={[styles.errorWrap, { backgroundColor: colors.surface }]}>
                <Text variant="footnote" color="forfeit" accessibilityLiveRegion="polite">
                  {goalErrors.race}
                </Text>
              </View>
            ) : null}
          </ListGroup>
          <TextField label="Title" value={draft.title} onChangeText={(title) => patch({ title })} placeholder={titlePlaceholder} helper={`Leave it empty for "${suggestedTitle(draft) || titlePlaceholder}".`} maxLength={60} />
        </>
      ) : null}

      {step === 'goal' && option.kind === 'workouts' ? (
        <>
          <TextField
            label="Workouts a week"
            value={draft.goalText}
            onChangeText={(goalText) => patch({ goalText })}
            keyboardType="number-pad"
            inputMode="numeric"
            placeholder="3"
            error={show ? goalErrors.goal : undefined}
            helper={show && goalErrors.goal ? undefined : 'A workout counts when it lasts ten minutes or more and was recorded, not typed in.'}
            clearable={false}
            selectTextOnFocus
            autoFocus
          />
          <ListGroup header="What counts" footer={show && goalErrors.types ? undefined : 'Pick the kinds that count. Monday to Sunday night, like every weekly challenge.'}>
            <View style={[styles.daysBlock, { backgroundColor: colors.surface }]}>
              <View style={styles.chipWrap} accessibilityRole="list">
                {ALL_WORKOUT_TYPES.map((t) => (
                  <ToggleChip key={t} label={activityTypeLabel(t)} selected={draft.workoutTypes.includes(t)} onPress={() => toggleType(t)} role="checkbox" accessibilityLabel={`${activityTypeLabel(t)}s count`} />
                ))}
              </View>
              {show && goalErrors.types ? (
                <Text variant="footnote" color="forfeit" accessibilityLiveRegion="polite">
                  {goalErrors.types}
                </Text>
              ) : null}
            </View>
          </ListGroup>
          <TextField label="Title" value={draft.title} onChangeText={(title) => patch({ title })} placeholder={titlePlaceholder} helper={`Leave it empty for "${suggestedTitle(draft) || titlePlaceholder}".`} maxLength={60} />
        </>
      ) : null}

      {step === 'goal' && option.kind === 'steps' ? (
        <>
          <TextField
            label="Steps a day"
            value={draft.goalText}
            onChangeText={(goalText) => patch({ goalText: goalText.replace(/,/g, '') })}
            keyboardType="number-pad"
            inputMode="numeric"
            placeholder="10000"
            error={show ? goalErrors.goal : undefined}
            helper={show && goalErrors.goal ? undefined : "The day's total from Apple Health, counted at midnight. Steps typed into Health don't count."}
            clearable={false}
            selectTextOnFocus
            autoFocus
          />
          <ListGroup header="Days" footer={show && goalErrors.days ? undefined : 'Each picked day is its own round.'}>
            <View style={[styles.daysBlock, { backgroundColor: colors.surface }]}>
              <DayStrip days={draft.days} onToggle={(iso) => patch({ days: toggleDay(draft.days, iso) })} />
              <QuickPicks days={draft.days} onPick={(days) => patch({ days })} />
              {show && goalErrors.days ? (
                <Text variant="footnote" color="forfeit" accessibilityLiveRegion="polite">
                  {goalErrors.days}
                </Text>
              ) : null}
            </View>
          </ListGroup>
          <TextField label="Title" value={draft.title} onChangeText={(title) => patch({ title })} placeholder={titlePlaceholder} helper={`Leave it empty for "${suggestedTitle(draft) || titlePlaceholder}".`} maxLength={60} />
        </>
      ) : null}

      {step === 'goal' && option.kind === 'custom' ? (
        <>
          <TextField
            label="What counts?"
            value={draft.title}
            onChangeText={(title) => patch({ title })}
            placeholder="Read 20 pages"
            error={show ? goalErrors.title : undefined}
            helper={show && goalErrors.title ? undefined : 'You mark it done before midnight; the group can challenge a mark and vote.'}
            maxLength={60}
            autoFocus
          />
          <ListGroup header="How often" footer={draft.customPeriod === 'weekly' ? 'One mark per week, Monday to Sunday night.' : show && goalErrors.days ? undefined : 'One mark per picked day.'}>
            <View style={[styles.presetWrap, { backgroundColor: colors.surface }]}>
              <SegmentedControl
                segments={['Every day', 'Every week']}
                index={draft.customPeriod === 'weekly' ? 1 : 0}
                onChange={(i) => {
                  haptic('selection');
                  patch({ customPeriod: i === 1 ? 'weekly' : 'daily' });
                }}
                accessibilityLabel="Every day or every week"
              />
            </View>
            {draft.customPeriod === 'daily' ? (
              <View style={[styles.daysBlock, { backgroundColor: colors.surface }]}>
                <DayStrip days={draft.days} onToggle={(iso) => patch({ days: toggleDay(draft.days, iso) })} />
                <QuickPicks days={draft.days} onPick={(days) => patch({ days })} />
                {show && goalErrors.days ? (
                  <Text variant="footnote" color="forfeit" accessibilityLiveRegion="polite">
                    {goalErrors.days}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </ListGroup>
          <ListGroup footer="A photo goes with the mark so friends can see it. Appeals and challenges work as on any other day.">
            <ListRow
              title="Needs a photo"
              onPress={() => {
                haptic('selection');
                patch({ needsPhoto: !draft.needsPhoto });
              }}
              accessibilityLabel={`Needs a photo, ${draft.needsPhoto ? 'on' : 'off'}`}
              accessibilityHint="Toggles whether a mark needs a photo"
              trailing={
                <Switch
                  value={draft.needsPhoto}
                  onValueChange={(needsPhoto) => {
                    haptic('selection');
                    patch({ needsPhoto });
                  }}
                  accessibilityLabel="Needs a photo"
                  trackColor={{ true: colors.tint }}
                  ios_backgroundColor={colors.fillStrong}
                  {...(Platform.OS === 'web' ? { thumbColor: colors.surfaceElevated, activeThumbColor: colors.surfaceElevated } : {})}
                />
              }
            />
          </ListGroup>
        </>
      ) : null}

      {step === 'pledge' ? (
        <>
          <TextField
            label={pledgeFieldLabel(draft)}
            value={draft.dollars}
            onChangeText={(dollars) => patch({ dollars: dollars.replace(/^\$/, '') })}
            keyboardType="decimal-pad"
            inputMode="decimal"
            leading={
              <Text variant="body" color="secondary">
                $
              </Text>
            }
            error={show ? pledgeErrors.amount : undefined}
            helper={
              goalKind
                ? 'Between $0.01 and $100.00. Forfeited only when you fall short; a week that could not sync in time is recomputed when it does.'
                : 'Between $0.01 and $100.00. Forfeited only on days you miss; unverified days never cost anything.'
            }
            clearable={false}
            selectTextOnFocus
          />
          <View style={styles.quickRow} accessibilityRole="radiogroup" accessibilityLabel="Quick amounts">
            {QUICK_AMOUNTS_CENTS.map((cents) => (
              <ToggleChip
                key={cents}
                label={formatCents(cents).replace(/\.00$/, '')}
                selected={stakeCents === cents}
                onPress={() => patch({ dollars: centsToDecimalString(cents) })}
                accessibilityLabel={`${formatCents(cents)} ${pledgeFieldLabel(draft).toLowerCase()}`}
                style={styles.quickChip}
              />
            ))}
          </View>

          {!goalKind ? (
            <ListGroup footer={season ? `${seasonSummary(season)}. At the finish line everyone sees who showed up most, who had the longest streak and who came out ahead.` : 'Four weeks with a finish line and a recap. You can start or end a season any time from the pact.'}>
              <ListRow
                title="Run as a 4-week season starting Monday"
                onPress={() => {
                  haptic('selection');
                  patch({ season: !draft.season });
                }}
                accessibilityLabel={`Run as a 4-week season starting Monday, ${draft.season ? 'on' : 'off'}`}
                accessibilityHint="Toggles the season"
                trailing={
                  <Switch
                    value={draft.season}
                    onValueChange={(s) => {
                      haptic('selection');
                      patch({ season: s });
                    }}
                    accessibilityLabel="Run as a 4-week season starting Monday"
                    trackColor={{ true: colors.tint }}
                    ios_backgroundColor={colors.fillStrong}
                    {...(Platform.OS === 'web' ? { thumbColor: colors.surfaceElevated, activeThumbColor: colors.surfaceElevated } : {})}
                  />
                }
              />
            </ListGroup>
          ) : null}

          <Card accessibilityLabel="Summary">
            <Text variant="headline">{summaryTitle}</Text>
            {goalKind ? (
              <Text variant="body">{goalSummaryLine(draft)}</Text>
            ) : (
              <Text variant="body">
                {describeDays(draft.days)}, {describeWindow(Math.max(0, windowOpen), draft.deadline)}
              </Text>
            )}
            <Text variant="body">
              Pledge {stakeCents !== null ? formatCents(stakeCents) : '—'} {pledgeFieldLabel(draft).toLowerCase().replace(/^per /, 'per ')}
            </Text>
            {season ? <Text variant="body">{seasonSummary(season)}</Text> : null}
            <Text variant="footnote" color="secondary">
              {pledgeSentence(draft, stakeCents ?? 0)}
            </Text>
          </Card>
          {serverError ? (
            <Text variant="footnote" color="forfeit" accessibilityRole="alert" accessibilityLiveRegion="assertive">
              {serverError}
            </Text>
          ) : null}
        </>
      ) : null}

      <TimeZoneSheet open={tzOpen} selected={draft.tz} onClose={() => setTzOpen(false)} onSelect={(tz) => patch({ tz })} />
    </Screen>
  );
}

// ---------- pieces ----------

function HeaderButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={[styles.headerButton, Platform.OS === 'web' && styles.headerButtonWeb]}
    >
      <Text variant="body" color="tint">
        {label}
      </Text>
    </Pressable>
  );
}

/** Step dots; the current one is tint and wider. Reads as "Step 1 of 4" to VoiceOver. */
function StepDots({ step, count }: { step: number; count: number }) {
  const { colors } = useTheme();
  return (
    <View
      style={styles.dots}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${step + 1} of ${count}`}
      accessibilityValue={{ min: 1, max: count, now: step + 1 }}
    >
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={[styles.dot, i === step ? [styles.dotActive, { backgroundColor: colors.tint }] : { backgroundColor: colors.fillStrong }]} />
      ))}
    </View>
  );
}

function DayStrip({ days, onToggle }: { days: readonly number[]; onToggle: (iso: number) => void }) {
  const { colors } = useTheme();
  return (
    <View style={styles.strip} accessibilityRole="list">
      {DAY_CELLS.map((cell) => {
        const on = days.includes(cell.iso);
        return (
          <Pressable
            key={cell.iso}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            accessibilityLabel={cell.name}
            onPress={() => {
              haptic('selection');
              onToggle(cell.iso);
            }}
            style={({ pressed }) => [
              styles.dayCell,
              { backgroundColor: on ? colors.tint : colors.fill, borderColor: on ? colors.tint : colors.separator },
              pressed && styles.pressed,
            ]}
          >
            <Text variant="headline" style={{ color: on ? colors.onTint : colors.label }}>
              {cell.short}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function QuickPicks({ days, onPick }: { days: readonly number[]; onPick: (days: number[]) => void }) {
  const active = activeQuickPick(days);
  return (
    <View style={styles.quickRow} accessibilityRole="radiogroup" accessibilityLabel="Quick picks">
      {QUICK_PICKS.map((q) => (
        <ToggleChip key={q.id} label={q.label} selected={active === q.id} onPress={() => onPick(applyQuickPick(q.id))} style={styles.quickChip} />
      ))}
    </View>
  );
}

function ToggleChip({
  label,
  selected,
  onPress,
  accessibilityLabel,
  style,
  role = 'radio',
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  /** radios pick one of a set (tapping the selected one is a no-op); checkboxes toggle */
  role?: 'radio' | 'checkbox';
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={{ selected, checked: selected }}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={() => {
        if (selected && role === 'radio') return;
        if (role === 'radio') haptic('selection');
        onPress();
      }}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: selected ? colors.tintSoft : colors.fill },
        pressed && styles.pressed,
        style,
      ]}
    >
      <Text variant="subheadline" emphasis={selected} color={selected ? 'tint' : 'label'} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function TimeZoneSheet({
  open,
  selected,
  onClose,
  onSelect,
}: {
  open: boolean;
  selected: string;
  onClose: () => void;
  onSelect: (tz: string) => void;
}) {
  const { height } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const options = useMemo(() => timeZoneOptions(deviceTimeZone()), []);
  const results = searchTimeZones(options, query);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  return (
    <Sheet open={open} onClose={onClose} title="Time zone">
      <TextField
        label="Search"
        value={query}
        onChangeText={setQuery}
        placeholder="City or region"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />
      <ScrollView style={{ maxHeight: height * 0.45 }} keyboardShouldPersistTaps="handled">
        <ListGroup>
          {results.map((o) => (
            <ListRow
              key={o.id}
              title={o.name}
              subtitle={`${o.city} · ${timeZoneOffsetLabel(o.id)}`}
              trailing={o.id === selected ? <Icon name="checkmark" size={18} color="tint" accessibilityLabel="Selected" /> : undefined}
              onPress={() => {
                haptic('selection');
                onSelect(o.id);
                onClose();
              }}
              accessibilityLabel={`${o.name}, ${o.city}${o.id === selected ? ', selected' : ''}`}
            />
          ))}
          {results.length === 0 ? <ListRow title="No matches" subtitle="Try the nearest big city." disabled /> : null}
        </ListGroup>
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  headerButton: { minHeight: TOUCH_TARGET, justifyContent: 'center' },
  headerButtonWeb: { paddingHorizontal: space.lg },
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: space.sm, paddingBottom: space.xs },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotActive: { width: 20 },
  daysBlock: { padding: space.lg, gap: space.md },
  strip: { flexDirection: 'row', gap: space.sm },
  dayCell: {
    flex: 1,
    minHeight: TOUCH_TARGET,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickRow: { flexDirection: 'row', gap: space.sm },
  quickChip: { flex: 1 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: { minHeight: TOUCH_TARGET - 8, paddingHorizontal: space.md, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.8 },
  presetWrap: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm },
  errorWrap: { paddingHorizontal: space.lg, paddingBottom: space.md },
  segmentRow: { flexDirection: 'row', justifyContent: 'flex-start', marginTop: -space.xs },
  unitHelper: { marginTop: space.xs },
  unitSegment: { width: 140 },
});

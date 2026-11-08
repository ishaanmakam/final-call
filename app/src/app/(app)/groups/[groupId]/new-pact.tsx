import { useQueryClient } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { createPact, setPactSeason } from '@/api/rpc';
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
import {
  DAY_CELLS,
  DEFAULT_DRAFT,
  QUICK_AMOUNTS_CENTS,
  QUICK_PICKS,
  WINDOW_PRESETS,
  activeQuickPick,
  applyQuickPick,
  describeWindow,
  draftSeason,
  draftWindowOpen,
  isDraftDirty,
  offsetLabel,
  presetLabel,
  toggleDay,
  validatePledge,
  validateWhat,
  validateWhen,
  type WizardDraft,
} from '@/features/pact/wizard';
import { searchTimeZones, timeZoneDisplayName, timeZoneOffsetLabel, timeZoneOptions } from '@/features/shared/timeZones';
import { seasonSummary } from '@/features/stats/season';
import { userMessage } from '@/lib/errors';
import { centsToDecimalString, formatCents, parseDollarsToCents } from '@/lib/money';
import { describeDays, deviceTimeZone, displayMinutes, formatDateInZone, formatTimeInZone, nextOccurrence, toPgTime } from '@/lib/time';
import { TOUCH_TARGET, haptic, radius, space, useTheme } from '@/theme';

const STEP_TITLES = ["What's the pact?", 'When?', 'Pledge'] as const;
const STEP_COUNT = STEP_TITLES.length;

export default function NewPactWizard() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const { colors } = useTheme();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<WizardDraft>(() => ({ ...DEFAULT_DRAFT, tz: deviceTimeZone() }));
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
  const stepValid = [Object.keys(whatErrors).length === 0, Object.keys(whenErrors).length === 0, Object.keys(pledgeErrors).length === 0];
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
  const season = draftSeason(draft, Date.now());

  const next = async () => {
    setTouched(true);
    if (!stepValid[step]) {
      haptic('error');
      return;
    }
    if (step < STEP_COUNT - 1) {
      setTouched(false);
      setStep(step + 1);
      return;
    }
    if (creating.current) return;
    creating.current = true;
    setBusy(true);
    setServerError(null);
    try {
      const pactId = await createPact({
        groupId,
        title: draft.title.trim(),
        days: [...draft.days].sort((a, b) => a - b),
        windowOpen: toPgTime(windowOpen),
        deadline: toPgTime(draft.deadline),
        stakeCents: stakeCents!,
        tz: draft.tz,
      });
      // the season is a second call: a failure there must not lose the pact that was just created
      let seasonNote = '';
      const season = draftSeason(draft, Date.now());
      if (season) {
        try {
          await setPactSeason(pactId, season.start, season.weeks);
        } catch {
          seasonNote = " The season didn't start; you can start it from the pact.";
        }
      }
      await qc.invalidateQueries({ queryKey: ['group', groupId] });
      toast.show({ message: `Pact created. Now set your place.${seasonNote}`, tone: seasonNote ? 'neutral' : 'success', icon: 'checkmark' });
      // lift the dismiss guard first (usePreventRemove's effect runs before the one below), then leave
      setLeaving(true);
      setDestination(`/pacts/${pactId}/place`);
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
    if (step === 0) {
      router.back();
      return;
    }
    setTouched(false);
    setStep(step - 1);
  };

  return (
    <Screen
      footer={
        <Button
          title={step === STEP_COUNT - 1 ? 'Create pact' : 'Next'}
          onPress={() => void next()}
          loading={busy}
          accessibilityHint={step === STEP_COUNT - 1 ? 'Creates the pact, then asks for your place' : `Goes to step ${step + 2} of ${STEP_COUNT}`}
        />
      }
    >
      <Stack.Screen
        options={{
          title: STEP_TITLES[step],
          headerBackVisible: false,
          gestureEnabled: !dirty,
          headerLeft: () => <HeaderButton label={step === 0 ? 'Cancel' : 'Back'} onPress={back} />,
        }}
      />
      <StepDots step={step} count={STEP_COUNT} />

      {step === 0 ? (
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

      {step === 1 ? (
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

      {step === 2 ? (
        <>
          <TextField
            label="Per missed day"
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
            helper="Between $0.01 and $100.00. Forfeited only on days you miss; unverified days never cost anything."
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
                accessibilityLabel={`${formatCents(cents)} per missed day`}
                style={styles.quickChip}
              />
            ))}
          </View>

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
                  onValueChange={(season) => {
                    haptic('selection');
                    patch({ season });
                  }}
                  accessibilityLabel="Run as a 4-week season starting Monday"
                  trackColor={{ true: colors.tint }}
                  ios_backgroundColor={colors.fillStrong}
                  {...(Platform.OS === 'web' ? { thumbColor: colors.surfaceElevated, activeThumbColor: colors.surfaceElevated } : {})}
                />
              }
            />
          </ListGroup>

          <Card accessibilityLabel="Summary">
            <Text variant="headline">{draft.title.trim() || 'Your pact'}</Text>
            <Text variant="body">
              {describeDays(draft.days)}, {describeWindow(Math.max(0, windowOpen), draft.deadline)}
            </Text>
            <Text variant="body">Pledge {stakeCents !== null ? formatCents(stakeCents) : '—'} per missed day</Text>
            {season ? <Text variant="body">{seasonSummary(season)}</Text> : null}
            <Text variant="footnote" color="secondary">
              Miss a day and your pledge is forfeited to the pool, which is split among everyone who showed up. If nobody
              shows up, the pool carries over. Balances settle up weekly on Venmo.
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

/** Three dots; the current one is tint and wider. Reads as "Step 1 of 3" to VoiceOver. */
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
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, checked: selected }}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={() => {
        if (selected) return;
        haptic('selection');
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
  chip: { minHeight: TOUCH_TARGET - 8, paddingHorizontal: space.md, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.8 },
  presetWrap: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm },
});

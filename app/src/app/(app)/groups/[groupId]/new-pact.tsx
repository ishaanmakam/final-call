import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { createPact } from '@/api/rpc';
import { TimeStepper } from '@/components/TimeStepper';
import { Body, Button, Card, Chip, ErrorText, Field, Heading, Row, Screen } from '@/components/ui';
import { formatCents, MAX_STAKE_CENTS, MIN_STAKE_CENTS, parseDollarsToCents } from '@/lib/money';
import {
  ISO_DAY_LABELS,
  describeDays,
  deviceTimeZone,
  displayMinutes,
  formatDateInZone,
  formatTimeInZone,
  isValidTimeZone,
  nextOccurrence,
  toPgTime,
} from '@/lib/time';

const STEPS = ['What', 'When', 'Pledge'] as const;

export default function NewPactWizard() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState('');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [windowOpen, setWindowOpen] = useState(8 * 60);
  const [deadline, setDeadline] = useState(9 * 60);
  const [tz, setTz] = useState(deviceTimeZone());
  const [dollars, setDollars] = useState('5.00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const stakeCents = parseDollarsToCents(dollars);
  const tzValid = isValidTimeZone(tz.trim());

  const preview = useMemo(() => {
    if (!tzValid || days.length === 0) return null;
    try {
      return nextOccurrence(Date.now(), days, toPgTime(deadline), tz.trim());
    } catch {
      return null;
    }
  }, [days, deadline, tz, tzValid]);

  const stepError = (): string | null => {
    if (step === 0) {
      if (title.trim().length < 2) return 'Give the pact a title, like "9am class".';
      if (days.length === 0) return 'Pick at least one day.';
    }
    if (step === 1) {
      if (windowOpen >= deadline) return 'The window must open before the deadline on the same day.';
      if (!tzValid) return `Unknown time zone "${tz}".`;
    }
    if (step === 2) {
      if (stakeCents === null) return 'Enter a dollar amount like 5 or 2.50.';
      if (stakeCents < MIN_STAKE_CENTS || stakeCents > MAX_STAKE_CENTS)
        return `Pledge must be between ${formatCents(MIN_STAKE_CENTS)} and ${formatCents(MAX_STAKE_CENTS)}.`;
    }
    return null;
  };

  const next = async () => {
    const problem = stepError();
    if (problem) {
      setError(new Error(problem));
      return;
    }
    setError(null);
    if (step < STEPS.length - 1) {
      setStep(step + 1);
      return;
    }
    setBusy(true);
    try {
      const pactId = await createPact({
        groupId,
        title: title.trim(),
        days: [...days].sort((a, b) => a - b),
        windowOpen: toPgTime(windowOpen),
        deadline: toPgTime(deadline),
        stakeCents: stakeCents!,
        tz: tz.trim(),
      });
      await qc.invalidateQueries({ queryKey: ['group', groupId] });
      router.replace(`/pacts/${pactId}/place`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const toggleDay = (d: number) => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));

  return (
    <Screen>
      <Body muted>
        Step {step + 1} of {STEPS.length}: {STEPS[step]}
      </Body>

      {step === 0 ? (
        <>
          <Field label="Title" value={title} onChangeText={setTitle} placeholder="9am class" maxLength={60} />
          <Heading>Days</Heading>
          <Row>
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <Chip key={d} label={ISO_DAY_LABELS[d] ?? ''} selected={days.includes(d)} onPress={() => toggleDay(d)} />
            ))}
          </Row>
          <Body muted>Everyone picks their own place next, so one pact can cover different buildings.</Body>
        </>
      ) : null}

      {step === 1 ? (
        <>
          <TimeStepper label="Check-in window opens" minutes={windowOpen} onChange={setWindowOpen} />
          <TimeStepper label="Deadline" minutes={deadline} onChange={setDeadline} />
          <Body muted>
            You can check in from {displayMinutes(windowOpen)} until {displayMinutes(deadline)}.
          </Body>
          <Field
            label="Time zone"
            value={tz}
            onChangeText={setTz}
            autoCapitalize="none"
            autoCorrect={false}
            hint="Times follow this zone, including daylight saving changes."
          />
          {preview ? (
            <Body muted>
              Next: {formatDateInZone(preview.deadlineAt, tz.trim())} by {formatTimeInZone(preview.deadlineAt, tz.trim())}
            </Body>
          ) : null}
        </>
      ) : null}

      {step === 2 ? (
        <>
          <Field
            label="Daily pledge (USD)"
            value={dollars}
            onChangeText={setDollars}
            keyboardType="decimal-pad"
            hint="From $0.01 to $100.00 per scheduled day."
          />
          <Card>
            <Heading>{title.trim() || 'Your pact'}</Heading>
            <Body>
              {describeDays(days)}, {displayMinutes(windowOpen)} to {displayMinutes(deadline)} ({tz.trim()})
            </Body>
            <Body>Pledge {stakeCents !== null ? formatCents(stakeCents) : '?'} per day.</Body>
            <Body muted>
              Miss a day and your pledge is forfeited to the pool, which is split among everyone who showed up. If
              nobody shows up, the pool carries over. Balances settle up weekly on Venmo.
            </Body>
          </Card>
        </>
      ) : null}

      <ErrorText error={error} />
      <Row>
        {step > 0 ? (
          <Button title="Back" variant="secondary" onPress={() => setStep(step - 1)} style={{ flex: 1 }} />
        ) : null}
        <Button
          title={step === STEPS.length - 1 ? 'Create pact' : 'Next'}
          onPress={() => void next()}
          loading={busy}
          style={{ flex: 1 }}
        />
      </Row>
    </Screen>
  );
}

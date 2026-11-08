/**
 * The place gate on screen: the "Waiting for a friend to confirm" / "Objected" block under a
 * person's row, its Confirm / Object actions, and the objection sheet (reason required). Used by
 * pact detail ("Who's in") and the feed (place events). The rules live in the database; the
 * server's view says what is confirmable / objectable (`acknowledgeable`, `objectable`).
 */
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { acknowledgePlace, objectPlace } from '../../api/rpc';
import type { PactPlaceVisibleRow } from '../../api/types';
import { Button, Icon, Pill, Sheet, Text, TextField, type PillTone } from '../../components';
import { userMessage } from '../../lib/errors';
import { haptic, space, useTheme } from '../../theme';
import { OBJECTION_ERROR, OBJECTION_MAX_LENGTH, OBJECTION_MIN_LENGTH, objectionSheetCopy } from './placeCopy';

export interface ObjectionTarget {
  place: PactPlaceVisibleRow;
  /** the owner's name as the viewer says it ("Maya Chen") */
  ownerName: string;
}

// ---------- Confirm / Object ----------

export interface PlaceActionsProps {
  place: PactPlaceVisibleRow;
  userId: string;
  ownerName: string;
  onObject: (t: ObjectionTarget) => void;
  /** after a confirmation landed: invalidate queries */
  onChanged: () => void | Promise<unknown>;
}

/** The two 44 pt buttons for someone else's place that still waits. Nothing for your own place. */
export function PlaceActions({ place, userId, ownerName, onObject, onChanged }: PlaceActionsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (place.user_id === userId || (!place.acknowledgeable && !place.objectable)) return null;

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    haptic('commit');
    try {
      await acknowledgePlace(place.place_id);
      await onChanged();
    } catch (e) {
      setError(e);
      haptic('error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.actions}>
      <View style={styles.buttons}>
        {place.acknowledgeable ? (
          <Button
            title="Confirm"
            size="small"
            leading={<Icon name="checkmark" size={16} color="onTint" />}
            loading={busy}
            onPress={() => void confirm()}
            accessibilityLabel={`Confirm ${ownerName}'s place`}
            accessibilityHint="It counts from now, or 12 hours after it was set"
            style={styles.flex}
          />
        ) : null}
        {place.objectable ? (
          <Button
            title="Object"
            size="small"
            variant="secondary"
            disabled={busy}
            onPress={() => onObject({ place, ownerName })}
            accessibilityLabel={`Object to ${ownerName}'s place`}
            accessibilityHint="Opens a form for your reason"
            style={styles.flex}
          />
        ) : null}
      </View>
      {error ? (
        <Text variant="footnote" color="forfeit" accessibilityRole="alert">
          {userMessage(error)}
        </Text>
      ) : null}
    </View>
  );
}

// ---------- the status block under a person's row ----------

export interface PlaceStatusBlockProps extends Omit<PlaceActionsProps, 'place'> {
  text: string;
  pill: { label: string; tone: PillTone } | null;
  /** the row the actions apply to (the pending one); null when there is nothing to act on */
  place: PactPlaceVisibleRow | null;
  last: boolean;
}

export function PlaceStatusBlock({ text, pill, place, last, ...actions }: PlaceStatusBlockProps) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.block,
        { backgroundColor: colors.surface },
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
      ]}
      accessibilityLabel={`${pill ? `${pill.label}. ` : ''}${text}`}
    >
      <View style={styles.blockIcon}>
        <Icon name="location" size={18} color={pill?.tone === 'excluded' ? 'secondary' : 'tint'} />
      </View>
      <View style={styles.blockBody}>
        {pill ? <Pill label={pill.label} tone={pill.tone} size="compact" style={styles.pill} /> : null}
        <Text variant="callout">{text}</Text>
        {place ? <PlaceActions place={place} {...actions} /> : null}
      </View>
    </View>
  );
}

// ---------- the objection sheet ----------

export interface ObjectionSheetProps {
  target: ObjectionTarget | null;
  open: boolean;
  onClose: () => void;
  onDone: (t: ObjectionTarget) => void;
}

export function ObjectionSheet({ target, open, onClose, onDone }: ObjectionSheetProps) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open, target]);

  if (!target) return null;
  const copy = objectionSheetCopy(target.ownerName, target.place.label);

  const submit = async () => {
    if (busy) return;
    if (reason.trim().length < OBJECTION_MIN_LENGTH) {
      setError(OBJECTION_ERROR);
      haptic('error');
      return;
    }
    setBusy(true);
    setError(null);
    haptic('commit');
    try {
      await objectPlace(target.place.place_id, reason.trim());
      onDone(target);
    } catch (e) {
      setError(userMessage(e));
      haptic('error');
    } finally {
      setBusy(false);
    }
  };

  const sheet = (
    <Sheet open={open} onClose={onClose} title={copy.title}>
      <Text variant="subheadline" color="secondary">
        {target.place.label ?? 'Their place'} · {target.place.radius_m} m
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
        maxLength={OBJECTION_MAX_LENGTH}
        error={error}
        autoFocus={Platform.OS !== 'web'}
      />
      <Text variant="footnote" color="secondary">
        {copy.rule}
      </Text>
      <Button title="Send objection" onPress={() => void submit()} loading={busy} />
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

const styles = StyleSheet.create({
  flex: { flex: 1 },
  actions: { gap: space.sm },
  buttons: { flexDirection: 'row', gap: space.sm },
  block: {
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  blockIcon: { width: 28, alignItems: 'center', paddingTop: 1 },
  blockBody: { flex: 1, gap: space.sm },
  pill: { alignSelf: 'flex-start' },
});

import type { ImagePickerAsset } from 'expo-image-picker';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import { openReview } from '../../api/rpc';
import type { ReviewKind } from '../../api/types';
import { Button, Icon, Sheet, Text, TextField } from '../../components';
import { userMessage } from '../../lib/errors';
import { pickEvidencePhoto, uploadEvidencePhoto } from '../../lib/reviewPhoto';
import { REASON_ERROR, REASON_MIN_LENGTH, reviewSheetCopy } from './reviewCopy';

/** What the sheet needs to open an appeal or a challenge: the day, the person, the pact. */
export interface ReviewSheetTarget {
  instanceId: string;
  subjectUserId: string;
  /** "you" or a first name, for the sheet's copy */
  subjectShortName: string;
  /** "Thu, Nov 12" or "week of Nov 9" */
  dayLabel: string;
  pactTitle: string;
  groupId: string;
  kind: ReviewKind;
}

export interface ReviewSheetProps {
  target: ReviewSheetTarget | null;
  open: boolean;
  /** the signed-in user (evidence photos are stored under their folder) */
  userId: string;
  onClose: () => void;
  onDone: (kind: ReviewKind) => void;
}

/**
 * The appeal / challenge sheet, shared by the feed (any result) and the pact screen (a friend's
 * reached goal this week). A reason is required; a photo is optional and only for appeals.
 */
export function ReviewSheet({ target, open, userId, onClose, onDone }: ReviewSheetProps) {
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
  const { kind } = target;
  const copy = reviewSheetCopy(kind, target.dayLabel, target.subjectShortName);

  const submit = async () => {
    if (busy) return;
    if (reason.trim().length < REASON_MIN_LENGTH) {
      setError(REASON_ERROR);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const photoPath = photo ? await uploadEvidencePhoto(photo, target.groupId, userId) : null;
      await openReview({
        instanceId: target.instanceId,
        subjectUserId: target.subjectUserId,
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
        {target.pactTitle}
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

import type { PactActivityRow } from '../../api/types';
import { EmptyState, Icon, ListGroup, ListRow, Pill, Text, type IconName } from '../../components';
import { formatDateInZone, formatTimeInZone } from '../../lib/time';
import { activityLine, activityTypeLabel, rejectionText, sourceLabel, type DistanceUnit } from './goal';

export interface ActivityGroupProps {
  activities: readonly PactActivityRow[];
  userId: string;
  nameOf: (id: string) => string;
  tz: string;
  unit: DistanceUnit;
  /** a friend's accepted entry can be challenged (the instance closed with a success for them, no review yet) */
  canChallenge: (a: PactActivityRow) => boolean;
  onChallenge: (a: PactActivityRow) => void;
  header: string;
  footer?: string;
  emptyBody: string;
}

const TYPE_ICON: Record<string, IconName> = {
  running: 'figure.run',
  walking: 'figure.walk',
  hiking: 'figure.walk',
  cycling: 'bicycle',
  strength: 'dumbbell',
  swimming: 'figure.run',
  rowing: 'figure.run',
  yoga: 'flame',
  other: 'flame',
  steps: 'shoeprints.fill',
};

/**
 * The evidence list: date and type, distance / duration / pace, a source + device chip. Rows the
 * server rejected are greyed with the reason in plain words. Others' accepted entries carry a
 * Challenge affordance once the week has a posted result.
 */
export function ActivityGroup({ activities, userId, nameOf, tz, unit, canChallenge, onChallenge, header, footer, emptyBody }: ActivityGroupProps) {
  return (
    <ListGroup header={header} footer={footer}>
      {activities.length === 0 ? <EmptyState icon="heart" title="No activities yet" body={emptyBody} /> : null}
      {activities.map((a) => {
        const rejected = a.verdict !== 'accepted';
        const who = nameOf(a.user_id);
        // the day is enough in the row; VoiceOver gets the time too
        const when = formatDateInZone(a.started_at, tz);
        const whenFull = `${when} ${formatTimeInZone(a.started_at, tz)}`;
        const line = activityLine(a, unit);
        const reason = rejectionText(a, unit);
        const chip = a.device ?? sourceLabel(a.source);
        const challenge = !rejected && a.user_id !== userId && canChallenge(a);
        return (
          <ListRow
            key={a.activity_id}
            leading={<Icon name={TYPE_ICON[a.activity_type] ?? 'flame'} size={20} color={rejected ? 'tertiary' : 'tint'} />}
            title={`${who} · ${activityTypeLabel(a.activity_type)}`}
            // a rejected row leads with the reason (the day is in the VoiceOver label); two lines is the row's limit
            subtitle={rejected ? (reason ?? `${when} · Doesn't count`) : `${when}${line ? ` · ${line}` : ''}`}
            trailing={
              challenge ? (
                <Text variant="footnote" color="tint" emphasis>
                  Challenge
                </Text>
              ) : (
                <Pill label={chip} tone={rejected ? 'void' : 'pending'} size="compact" accessibilityLabel={`${sourceLabel(a.source)}${a.device ? `, ${a.device}` : ''}`} />
              )
            }
            disabled={rejected}
            onPress={challenge ? () => onChallenge(a) : undefined}
            accessibilityLabel={`${who}, ${activityTypeLabel(a.activity_type)}, ${whenFull}${line ? `, ${line}` : ''}, ${sourceLabel(a.source)}${a.device ? ` on ${a.device}` : ''}${rejected ? `. ${reason}` : ''}`}
            accessibilityHint={challenge ? 'Opens a challenge for this result' : undefined}
          />
        );
      })}
    </ListGroup>
  );
}

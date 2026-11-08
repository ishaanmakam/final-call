import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Platform, type StyleProp, type TextStyle } from 'react-native';
import { countdownParts } from '../theme/countdown';
import type { TypeVariant } from '../theme/tokens';
import { Text, type TextColor } from './Text';

export interface CountdownProps {
  /** milliseconds remaining; negative values render 0:00 */
  ms: number;
  variant?: TypeVariant;
  color?: TextColor;
  /** switch to the forfeit tone in the last minute (default true) */
  urgentColor?: boolean;
  /** VoiceOver suffix, e.g. "left" or "until it opens" */
  suffix?: string;
  /** announce once at these remaining-minute marks (default 5 and 1) */
  announceAtMinutes?: readonly number[];
  style?: StyleProp<TextStyle>;
}

/**
 * h:mm:ss / mm:ss in tabular figures so digits tick without re-layout. The accessible label is
 * spoken in words. VoiceOver is not told about every tick (that would be unbearable); it hears
 * the value on focus and once at the announce marks.
 */
export function Countdown({
  ms,
  variant = 'title1',
  color = 'label',
  urgentColor = true,
  suffix = 'left',
  announceAtMinutes = [5, 1],
  style,
}: CountdownProps) {
  const parts = countdownParts(ms, suffix);
  const announced = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const minutes = Math.ceil(ms / 60_000);
    if (announceAtMinutes.includes(minutes) && ms % 60_000 > 59_000 && !announced.current.has(minutes)) {
      announced.current.add(minutes);
      AccessibilityInfo.announceForAccessibility(parts.label);
    }
  }, [ms, announceAtMinutes, parts.label]);
  return (
    <Text
      variant={variant}
      color={urgentColor && parts.urgent ? 'forfeit' : color}
      tabular
      accessibilityLabel={parts.label}
      style={style}
    >
      {parts.text}
    </Text>
  );
}

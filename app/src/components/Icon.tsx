import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Platform, View } from 'react-native';
import Svg, { Circle, Line, Path, Polyline } from 'react-native-svg';
import { useTheme } from '../theme/ThemeProvider';
import { resolveTextColor, type TextColor } from './Text';

/** The small icon vocabulary the app uses. iOS draws the SF Symbol; elsewhere a matching stroke SVG. */
export type IconName =
  | 'checkmark'
  | 'xmark'
  | 'chevron.right'
  | 'chevron.down'
  | 'clock'
  | 'location'
  | 'person.2'
  | 'exclamationmark.triangle'
  | 'snowflake'
  | 'minus.circle'
  | 'arrow.clockwise'
  | 'wifi.slash'
  | 'plus'
  | 'xmark.circle.fill'
  | 'hourglass';

export interface IconProps {
  name: IconName;
  size?: number;
  color?: TextColor;
  /** VoiceOver label; omit for decorative icons (they are hidden from the tree) */
  accessibilityLabel?: string;
}

const SF: Record<IconName, SFSymbol> = {
  checkmark: 'checkmark',
  xmark: 'xmark',
  'chevron.right': 'chevron.right',
  'chevron.down': 'chevron.down',
  clock: 'clock',
  location: 'location',
  'person.2': 'person.2',
  'exclamationmark.triangle': 'exclamationmark.triangle',
  snowflake: 'snowflake',
  'minus.circle': 'minus.circle',
  'arrow.clockwise': 'arrow.clockwise',
  'wifi.slash': 'wifi.slash',
  plus: 'plus',
  'xmark.circle.fill': 'xmark.circle.fill',
  hourglass: 'hourglass',
};

function Glyph({ name, color }: { name: IconName; color: string }) {
  const stroke = { stroke: color, strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  switch (name) {
    case 'checkmark':
      return <Polyline points="5 12.5 10 17.5 19 7" {...stroke} />;
    case 'xmark':
      return (
        <>
          <Line x1="6" y1="6" x2="18" y2="18" {...stroke} />
          <Line x1="18" y1="6" x2="6" y2="18" {...stroke} />
        </>
      );
    case 'chevron.right':
      return <Polyline points="9 5 16 12 9 19" {...stroke} />;
    case 'chevron.down':
      return <Polyline points="5 9 12 16 19 9" {...stroke} />;
    case 'clock':
      return (
        <>
          <Circle cx="12" cy="12" r="9" {...stroke} />
          <Polyline points="12 7 12 12 15.5 14" {...stroke} />
        </>
      );
    case 'location':
      return <Path d="M20 4 4 11l8 1 1 8z" {...stroke} />;
    case 'person.2':
      return (
        <>
          <Circle cx="9" cy="8" r="3.2" {...stroke} />
          <Path d="M2.5 19c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5" {...stroke} />
          <Path d="M15.5 5.2a3.2 3.2 0 0 1 0 5.6" {...stroke} />
          <Path d="M17.5 13.8c2.5.6 4 2.6 4 5.2" {...stroke} />
        </>
      );
    case 'exclamationmark.triangle':
      return (
        <>
          <Path d="M12 3.5 21.5 20h-19z" {...stroke} />
          <Line x1="12" y1="9.5" x2="12" y2="14" {...stroke} />
          <Circle cx="12" cy="17" r="0.9" fill={color} />
        </>
      );
    case 'snowflake':
      return (
        <>
          <Line x1="12" y1="3" x2="12" y2="21" {...stroke} />
          <Line x1="4.2" y1="7.5" x2="19.8" y2="16.5" {...stroke} />
          <Line x1="4.2" y1="16.5" x2="19.8" y2="7.5" {...stroke} />
        </>
      );
    case 'minus.circle':
      return (
        <>
          <Circle cx="12" cy="12" r="9" {...stroke} />
          <Line x1="8" y1="12" x2="16" y2="12" {...stroke} />
        </>
      );
    case 'arrow.clockwise':
      return (
        <>
          <Path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" {...stroke} />
          <Polyline points="19.5 3.5 19.5 8.5 14.5 8.5" {...stroke} />
        </>
      );
    case 'wifi.slash':
      return (
        <>
          <Path d="M3 9.5a14 14 0 0 1 18 0" {...stroke} />
          <Path d="M6.5 13a9 9 0 0 1 11 0" {...stroke} />
          <Circle cx="12" cy="17.5" r="1.2" fill={color} />
          <Line x1="4" y1="4" x2="20" y2="20" {...stroke} />
        </>
      );
    case 'plus':
      return (
        <>
          <Line x1="12" y1="5" x2="12" y2="19" {...stroke} />
          <Line x1="5" y1="12" x2="19" y2="12" {...stroke} />
        </>
      );
    case 'xmark.circle.fill':
      return (
        <>
          <Circle cx="12" cy="12" r="10" fill={color} />
          <Line x1="8.5" y1="8.5" x2="15.5" y2="15.5" stroke="#FFFFFF" strokeWidth={2} strokeLinecap="round" />
          <Line x1="15.5" y1="8.5" x2="8.5" y2="15.5" stroke="#FFFFFF" strokeWidth={2} strokeLinecap="round" />
        </>
      );
    case 'hourglass':
      return <Path d="M7 3h10M7 21h10M8 3c0 4 4 5 4 9s-4 5-4 9M16 3c0 4-4 5-4 9s4 5 4 9" {...stroke} />;
  }
}

export function Icon({ name, size = 20, color = 'label', accessibilityLabel }: IconProps) {
  const { colors } = useTheme();
  const tint = resolveTextColor(colors, color);
  const a11y = accessibilityLabel
    ? { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel }
    : { accessible: false, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };
  const fallback = (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Glyph name={name} color={tint} />
    </Svg>
  );
  if (Platform.OS !== 'ios') return <View {...a11y}>{fallback}</View>;
  return (
    <View {...a11y} style={{ width: size, height: size }}>
      <SymbolView name={SF[name]} size={size} tintColor={tint} weight="semibold" fallback={fallback} />
    </View>
  );
}

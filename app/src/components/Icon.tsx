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
  | 'hourglass'
  | 'gearshape'
  | 'person.3'
  | 'envelope'
  | 'envelope.open'
  | 'bell'
  | 'globe'
  | 'magnifyingglass'
  | 'apple.logo'
  | 'rectangle.portrait.and.arrow.right'
  | 'photo'
  | 'bubble.left'
  | 'arrow.up.right'
  | 'square.and.arrow.up'
  | 'ellipsis.circle'
  | 'doc.on.doc';

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
  gearshape: 'gearshape',
  'person.3': 'person.3',
  envelope: 'envelope',
  'envelope.open': 'envelope.open',
  bell: 'bell',
  globe: 'globe',
  magnifyingglass: 'magnifyingglass',
  'apple.logo': 'apple.logo',
  'rectangle.portrait.and.arrow.right': 'rectangle.portrait.and.arrow.right',
  photo: 'photo',
  'bubble.left': 'bubble.left',
  'arrow.up.right': 'arrow.up.right',
  'square.and.arrow.up': 'square.and.arrow.up',
  'ellipsis.circle': 'ellipsis.circle',
  'doc.on.doc': 'doc.on.doc',
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
    case 'gearshape':
      return (
        <>
          <Circle cx="12" cy="12" r="3" {...stroke} />
          <Path
            d="M12 2.5l1.6 2.3 2.7-.7.7 2.7 2.3 1.6-1.4 2.4 1.4 2.4-2.3 1.6-.7 2.7-2.7-.7L12 21.5l-1.6-2.3-2.7.7-.7-2.7-2.3-1.6 1.4-2.4-1.4-2.4 2.3-1.6.7-2.7 2.7.7z"
            {...stroke}
          />
        </>
      );
    case 'person.3':
      return (
        <>
          <Circle cx="12" cy="7.5" r="3" {...stroke} />
          <Path d="M6.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" {...stroke} />
          <Path d="M4.5 6.2a2.4 2.4 0 1 0 0 4.6" {...stroke} />
          <Path d="M1.5 17c0-2.4 1.5-4 3.8-4.3" {...stroke} />
          <Path d="M19.5 6.2a2.4 2.4 0 1 1 0 4.6" {...stroke} />
          <Path d="M22.5 17c0-2.4-1.5-4-3.8-4.3" {...stroke} />
        </>
      );
    case 'envelope':
      return (
        <>
          <Path d="M3 6.5h18v11H3z" {...stroke} />
          <Polyline points="3 7 12 13.5 21 7" {...stroke} />
        </>
      );
    case 'envelope.open':
      return (
        <>
          <Path d="M3 10l9-6 9 6v10H3z" {...stroke} />
          <Polyline points="3 10 12 16 21 10" {...stroke} />
        </>
      );
    case 'bell':
      return (
        <>
          <Path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" {...stroke} />
          <Path d="M10 20a2 2 0 0 0 4 0" {...stroke} />
        </>
      );
    case 'globe':
      return (
        <>
          <Circle cx="12" cy="12" r="9" {...stroke} />
          <Path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18" {...stroke} />
        </>
      );
    case 'magnifyingglass':
      return (
        <>
          <Circle cx="10.5" cy="10.5" r="6.5" {...stroke} />
          <Line x1="15.5" y1="15.5" x2="20.5" y2="20.5" {...stroke} />
        </>
      );
    case 'apple.logo':
      return (
        <Path
          d="M16.4 12.7c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9s-1.8-.9-3-.8c-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.8 3-.8s1.8.8 3 .7c1.3 0 2.1-1.1 2.8-2.3.9-1.3 1.3-2.6 1.3-2.6s-2.5-1-2.5-3.7zM14.1 6c.6-.8 1.1-1.9 1-3-.9 0-2.1.6-2.7 1.4-.6.7-1.1 1.8-1 2.9 1 .1 2.1-.5 2.7-1.3z"
          fill={color}
        />
      );
    case 'rectangle.portrait.and.arrow.right':
      return (
        <>
          <Path d="M13 4H5v16h8" {...stroke} />
          <Line x1="10" y1="12" x2="21" y2="12" {...stroke} />
          <Polyline points="17 8 21 12 17 16" {...stroke} />
        </>
      );
    case 'photo':
      return (
        <>
          <Path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z" {...stroke} />
          <Circle cx="9" cy="9.5" r="1.6" {...stroke} />
          <Path d="M4.5 17.5 10 12l3.5 3.5 2-2 4 4" {...stroke} />
        </>
      );
    case 'bubble.left':
      return <Path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5z" {...stroke} />;
    case 'arrow.up.right':
      return (
        <>
          <Line x1="6" y1="18" x2="18" y2="6" {...stroke} />
          <Polyline points="9 6 18 6 18 15" {...stroke} />
        </>
      );
    case 'square.and.arrow.up':
      return (
        <>
          <Path d="M8 9H6.5A1.5 1.5 0 0 0 5 10.5v8A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 17.5 9H16" {...stroke} />
          <Line x1="12" y1="3.5" x2="12" y2="14" {...stroke} />
          <Polyline points="8.5 7 12 3.5 15.5 7" {...stroke} />
        </>
      );
    case 'ellipsis.circle':
      return (
        <>
          <Circle cx="12" cy="12" r="9" {...stroke} />
          <Circle cx="7.5" cy="12" r="1.1" fill={color} />
          <Circle cx="12" cy="12" r="1.1" fill={color} />
          <Circle cx="16.5" cy="12" r="1.1" fill={color} />
        </>
      );
    case 'doc.on.doc':
      return (
        <>
          <Path d="M9 7.5V5a1.5 1.5 0 0 1 1.5-1.5H17L20 6.5V15a1.5 1.5 0 0 1-1.5 1.5H16" {...stroke} />
          <Path d="M5.5 7.5h7L15 9.5V19a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 4 19V9a1.5 1.5 0 0 1 1.5-1.5z" {...stroke} />
        </>
      );
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

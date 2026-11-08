import { useEffect, useRef, type ComponentRef } from 'react';
import { AccessibilityInfo, Platform, View, findNodeHandle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Card, StatusPill, Text } from '../../components';
import { haptic, spring, useReducedMotion } from '../../theme';
import { AnimatedHeadline } from './AnimatedHeadline';
import type { GateClose } from './gateClose';

export interface GateCloseCardProps {
  gate: GateClose;
}

/**
 * The gate-close moment: today's result and the money, in the verdict panel's shape. Enters with
 * the reveal spring (opacity, translateY 8, scale 0.97; opacity only under Reduce Motion); the money
 * figure counts up over 350 ms on the same frame; one haptic, Success for winnings and Warning for a
 * forfeit, none when no pledge moved; VoiceOver hears the headline and subline once and focus
 * lands on the headline. A tallying card re-mounts as the posted one (keyed by state), so the
 * reveal happens when the result lands, not when the clock ticks past the deadline.
 */
export function GateCloseCard({ gate }: GateCloseCardProps) {
  const reduced = useReducedMotion();
  const t = useSharedValue(0);
  const headline = useRef<ComponentRef<typeof View>>(null);
  const tone = gate.tone === 'neutral' ? 'label' : gate.tone;

  useEffect(() => {
    t.set(withSpring(1, spring('reveal')));
    if (gate.haptic) haptic(gate.haptic);
    // the haptic and the spring start on the same frame; a re-mount (tallying -> posted) fires once
  }, [t]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (Platform.OS === 'web') return;
    AccessibilityInfo.announceForAccessibility(`${gate.headline}. ${gate.subline}`);
    const id = setTimeout(() => {
      const tag = headline.current ? findNodeHandle(headline.current) : null;
      if (tag) AccessibilityInfo.setAccessibilityFocus(tag);
    }, 350);
    return () => clearTimeout(id);
  }, [gate.headline, gate.subline]);

  const enter = useAnimatedStyle(() => {
    const v = t.get();
    return reduced ? { opacity: v } : { opacity: v, transform: [{ translateY: 8 * (1 - v) }, { scale: 0.97 + 0.03 * v }] };
  });

  return (
    <Animated.View style={enter} testID={`gate-close-${gate.state}`}>
      <Card>
        {gate.pill ? <StatusPill state={gate.pill} /> : null}
        <View ref={headline} accessible accessibilityRole="header" accessibilityLabel={gate.headline}>
          {gate.amount ? (
            <AnimatedHeadline before={gate.amount.before} cents={gate.amount.cents} after={gate.amount.after} signed={gate.tone === 'success'} color={tone} />
          ) : (
            <Text variant="headline" color={tone}>
              {gate.headline}
            </Text>
          )}
        </View>
        <Text variant="callout">{gate.subline}</Text>
        {gate.footnote ? (
          <Text variant="footnote" color="secondary">
            {gate.footnote}
          </Text>
        ) : null}
      </Card>
    </Animated.View>
  );
}

import { useEffect, useRef, type ComponentRef } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View, findNodeHandle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Button, Card, StatusPill, Text } from '../../components';
import { space, spring, useReducedMotion } from '../../theme';
import type { PanelAction, VerdictPanel as Panel } from './copy';

export interface VerdictPanelProps {
  panel: Panel;
  onAction?: (action: PanelAction) => void;
  /** a second, plain action under the primary one (permission denied: "Not now") */
  onDismiss?: () => void;
  actionDisabled?: boolean;
}

const ACTION_LABEL: Record<PanelAction, string> = {
  tryAgain: 'Try again',
  allowLocation: 'Allow location',
  openSettings: 'Open Settings',
  signIn: 'Sign in',
};

/**
 * The status line grown into a panel. Enters with the reveal spring on opacity, translateY 8 and
 * scale 0.97 (opacity only under Reduce Motion); VoiceOver hears the headline and body once and
 * focus lands on the headline.
 */
export function VerdictPanel({ panel, onAction, onDismiss, actionDisabled }: VerdictPanelProps) {
  const reduced = useReducedMotion();
  const t = useSharedValue(0);
  const headline = useRef<ComponentRef<typeof View>>(null);

  useEffect(() => {
    t.set(withSpring(1, spring('reveal')));
  }, [t]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    AccessibilityInfo.announceForAccessibility(`${panel.headline}. ${panel.body}`);
    const id = setTimeout(() => {
      const tag = headline.current ? findNodeHandle(headline.current) : null;
      if (tag) AccessibilityInfo.setAccessibilityFocus(tag);
    }, 350);
    return () => clearTimeout(id);
  }, [panel.headline, panel.body]);

  const enter = useAnimatedStyle(() => {
    const v = t.get();
    return reduced
      ? { opacity: v }
      : { opacity: v, transform: [{ translateY: 8 * (1 - v) }, { scale: 0.97 + 0.03 * v }] };
  });

  return (
    <Animated.View style={enter}>
      <Card>
        {panel.pill ? <StatusPill state={panel.pill} /> : null}
        <View ref={headline} accessible accessibilityRole="header" accessibilityLabel={panel.headline}>
          <Text variant="headline">{panel.headline}</Text>
        </View>
        <Text variant="callout">{panel.body}</Text>
        {panel.footnote ? (
          <Text variant="footnote" color="secondary">
            {panel.footnote}
          </Text>
        ) : null}
        {panel.action ? (
          <View style={styles.actions}>
            <Button
              title={ACTION_LABEL[panel.action]}
              size="small"
              variant={panel.action === 'tryAgain' ? 'secondary' : 'primary'}
              disabled={actionDisabled}
              onPress={() => onAction?.(panel.action!)}
            />
            {panel.action === 'allowLocation' && onDismiss ? <Button title="Not now" size="small" variant="tertiary" onPress={onDismiss} /> : null}
          </View>
        ) : null}
      </Card>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.xs, flexWrap: 'wrap' },
});

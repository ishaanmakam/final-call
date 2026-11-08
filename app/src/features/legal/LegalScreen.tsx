import { Stack } from 'expo-router';
import { Linking, StyleSheet, View } from 'react-native';
import { Button, Screen, Text } from '@/components';
import { space, useTheme } from '@/theme';
import { LEGAL_CONTACT, type LegalDocument, type LegalSection } from './content';

function Section({ section }: { section: LegalSection }) {
  const { colors } = useTheme();
  return (
    <View style={styles.section} accessibilityRole="none">
      <Text variant="title3" accessibilityRole="header">
        {section.heading}
      </Text>
      {section.paragraphs.map((p) => (
        <Text key={p} variant="body" color="secondary">
          {p}
        </Text>
      ))}
      {section.bullets?.map((b) => (
        <View key={b} style={styles.bullet}>
          <View style={[styles.dot, { backgroundColor: colors.tertiary }]} accessibilityElementsHidden importantForAccessibility="no" />
          <Text variant="body" color="secondary" style={styles.flex}>
            {b}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Static, scrollable legal text on the type scale; the same words as docs/legal/*.md. */
export function LegalScreen({ doc }: { doc: LegalDocument }) {
  return (
    <Screen>
      <Stack.Screen options={{ title: doc.title }} />
      <View style={styles.head}>
        <Text variant="footnote" color="secondary">
          Final Call · last updated {doc.updated}
        </Text>
        <Text variant="body">{doc.intro}</Text>
      </View>
      {doc.sections.map((s) => (
        <Section key={s.heading} section={s} />
      ))}
      <View style={styles.contact}>
        <Button
          title={`Email ${LEGAL_CONTACT}`}
          variant="tertiary"
          size="small"
          onPress={() => void Linking.openURL(`mailto:${LEGAL_CONTACT}?subject=Final%20Call`).catch(() => undefined)}
          accessibilityHint="Opens your mail app"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: { gap: space.sm, paddingBottom: space.md },
  section: { gap: space.sm, paddingBottom: space.lg },
  bullet: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start', paddingLeft: space.xs },
  dot: { width: 5, height: 5, borderRadius: 3, marginTop: 9 },
  contact: { alignItems: 'flex-start', paddingTop: space.sm },
});

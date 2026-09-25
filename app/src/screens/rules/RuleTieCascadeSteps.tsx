import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useThemedStyles } from '../../theme';
import type { ThemeColors } from '../../theme';

export type CascadeStep = {
  title: string;
  description: string;
  examples?: string[];
};

export default function RuleTieCascadeSteps({ steps }: { steps: CascadeStep[] }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.wrap}>
      {steps.map((step, i) => (
        <View key={i}>
          <View style={styles.stepRow}>
            <View style={styles.badge}>
              <Text style={styles.badgeTxt}>{i + 1}</Text>
            </View>
            <View style={styles.stepBody}>
              <Text style={styles.stepTitle}>{step.title}</Text>
              <Text style={styles.stepDesc}>{step.description}</Text>
              {(step.examples ?? []).map((example, ei) => (
                <Text key={ei} style={styles.stepExample}>
                  Ejemplo: {example}
                </Text>
              ))}
            </View>
          </View>
          {i < steps.length - 1 ? <Text style={styles.arrow}>↓</Text> : null}
        </View>
      ))}
    </View>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { marginBottom: 4 },
    stepRow: { flexDirection: 'row', gap: 10 },
    badge: {
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 2,
    },
    badgeTxt: { color: c.onAccent, fontSize: 12, fontWeight: '700' },
    stepBody: { flex: 1 },
    stepTitle: { fontSize: 14, fontWeight: '700', color: c.text, marginBottom: 3 },
    stepDesc: { fontSize: 13, color: c.textBody, lineHeight: 18, marginBottom: 3 },
    stepExample: { fontSize: 12, color: c.textSecondary, fontStyle: 'italic', marginBottom: 2 },
    arrow: { fontSize: 14, color: c.textMuted, marginVertical: 2, marginLeft: 12 },
  });

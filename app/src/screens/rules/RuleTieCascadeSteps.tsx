import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export type CascadeStep = {
  title: string;
  description: string;
  examples?: string[];
};

export default function RuleTieCascadeSteps({ steps }: { steps: CascadeStep[] }) {
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

const styles = StyleSheet.create({
  wrap: { marginBottom: 4 },
  stepRow: { flexDirection: 'row', gap: 10 },
  badge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#3B82F6',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  badgeTxt: { color: '#fff', fontSize: 12, fontWeight: '700' },
  stepBody: { flex: 1 },
  stepTitle: { fontSize: 14, fontWeight: '700', color: '#111', marginBottom: 3 },
  stepDesc: { fontSize: 13, color: '#374151', lineHeight: 18, marginBottom: 3 },
  stepExample: { fontSize: 12, color: '#6B7280', fontStyle: 'italic', marginBottom: 2 },
  arrow: { fontSize: 14, color: '#9CA3AF', marginVertical: 2, marginLeft: 12 },
});

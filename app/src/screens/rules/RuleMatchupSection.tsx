import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export type RuleMatchup = {
  id: string;
  phaseLabel?: string;
  a: string;
  b: string;
  scoreA?: number;
  scoreB?: number;
};

type Props = {
  title: string;
  matchups: RuleMatchup[];
};

export default function RuleMatchupSection({ title, matchups }: Props) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.header}>{title}</Text>
      {matchups.map((m) => (
        <View key={m.id} style={styles.row}>
          {m.phaseLabel ? <Text style={styles.phaseLabel}>{m.phaseLabel}</Text> : null}
          <View style={styles.matchRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarTxt}>{m.a.charAt(0)}</Text>
            </View>
            <Text style={styles.name} numberOfLines={1}>
              {m.a}
            </Text>
            {m.scoreA != null && m.scoreB != null ? (
              <Text style={styles.score}>
                {m.scoreA}-{m.scoreB}
              </Text>
            ) : (
              <Text style={styles.vs}>vs</Text>
            )}
            <Text style={[styles.name, styles.nameRight]} numberOfLines={1}>
              {m.b}
            </Text>
            <View style={styles.avatar}>
              <Text style={styles.avatarTxt}>{m.b.charAt(0)}</Text>
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 12,
    backgroundColor: '#fafafa',
    padding: 12,
    marginBottom: 4,
  },
  header: { fontSize: 13, fontWeight: '700', color: '#111', marginBottom: 8 },
  row: { marginBottom: 10 },
  phaseLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#9CA3AF',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  matchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  avatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#E0E7FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarTxt: { fontSize: 12, fontWeight: '700', color: '#4338CA' },
  name: { flex: 1, fontSize: 13, fontWeight: '600', color: '#111' },
  nameRight: { textAlign: 'right' },
  vs: { fontSize: 11, color: '#9CA3AF', fontWeight: '600', marginHorizontal: 2 },
  score: { fontSize: 13, fontWeight: '700', color: '#111', marginHorizontal: 4 },
});

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useThemedStyles } from '../../theme';
import type { ThemeColors } from '../../theme';

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
  const styles = useThemedStyles(createStyles);
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

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: {
      borderWidth: 1,
      borderColor: c.divider,
      borderRadius: 12,
      backgroundColor: c.card,
      padding: 12,
      marginBottom: 4,
    },
    header: { fontSize: 13, fontWeight: '700', color: c.text, marginBottom: 8 },
    row: { marginBottom: 10 },
    phaseLabel: {
      fontSize: 11,
      fontWeight: '700',
      color: c.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
      marginBottom: 4,
    },
    matchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    avatar: {
      width: 26,
      height: 26,
      borderRadius: 13,
      backgroundColor: c.status.info.subtle,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarTxt: { fontSize: 12, fontWeight: '700', color: c.status.info.text },
    name: { flex: 1, fontSize: 13, fontWeight: '600', color: c.text },
    nameRight: { textAlign: 'right' },
    vs: { fontSize: 11, color: c.textMuted, fontWeight: '600', marginHorizontal: 2 },
    score: { fontSize: 13, fontWeight: '700', color: c.text, marginHorizontal: 4 },
  });

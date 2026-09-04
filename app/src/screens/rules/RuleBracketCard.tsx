import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export type BracketSlot =
  | { kind: 'player'; name: string }
  | { kind: 'winnerOf'; label: string };

export type BracketMatch = {
  a: BracketSlot;
  /** null = bye: `a` avanza directo, sin jugar. */
  b: BracketSlot | null;
  format?: 'BO1' | 'BO3';
};

export type BracketRound = {
  title: string;
  matches: BracketMatch[];
};

function slotLabel(slot: BracketSlot): string {
  return slot.kind === 'winnerOf' ? `Ganador de ${slot.label}` : slot.name;
}

export default function RuleBracketCard({ rounds }: { rounds: BracketRound[] }) {
  return (
    <View style={styles.wrap}>
      {rounds.map((round, ri) => (
        <View key={ri} style={styles.round}>
          <Text style={styles.roundTitle}>{round.title}</Text>
          {round.matches.map((m, mi) => (
            <View key={mi} style={styles.matchBox}>
              <View style={styles.matchRow}>
                <Text style={styles.matchText} numberOfLines={2}>
                  {slotLabel(m.a)}
                </Text>
                {m.b ? (
                  <>
                    <Text style={styles.vsText}>vs</Text>
                    <Text style={styles.matchText} numberOfLines={2}>
                      {slotLabel(m.b)}
                    </Text>
                  </>
                ) : (
                  <Text style={styles.byeText}>(bye, pasa directo)</Text>
                )}
                {m.format ? <Text style={styles.formatTag}>{m.format}</Text> : null}
              </View>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 4 },
  round: { marginBottom: 10 },
  roundTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6B7280',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  matchBox: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    backgroundColor: '#fff',
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 6,
  },
  matchRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  matchText: {
    flexShrink: 1,
    flexBasis: '38%',
    fontSize: 13,
    fontWeight: '600',
    color: '#111',
    textAlign: 'center',
  },
  vsText: { fontSize: 11, color: '#9CA3AF', fontWeight: '600' },
  byeText: { fontSize: 12, color: '#9CA3AF', fontStyle: 'italic' },
  formatTag: {
    fontSize: 10,
    fontWeight: '700',
    color: '#3B82F6',
    backgroundColor: '#EFF6FF',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
});

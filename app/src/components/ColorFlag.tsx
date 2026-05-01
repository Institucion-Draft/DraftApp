import React from 'react';
import { View, StyleSheet } from 'react-native';
import type { MtgColor } from '../lib/database.types';

export const MTG_COLOR_HEX: Record<MtgColor, string> = {
  W: '#FFFBE0',
  U: '#3B82F6',
  B: '#1F2937',
  R: '#EF4444',
  G: '#10B981',
  C: '#9CA3AF',
};

type Props = {
  colors: MtgColor[];
  width?: number;
  height?: number;
};

export default function ColorFlag({ colors, width = 20, height = 10 }: Props) {
  if (colors.length === 0) {
    return (
      <View style={[styles.outer, { width, height }]}>
        <View style={[styles.fill, { backgroundColor: '#9CA3AF' }]} />
      </View>
    );
  }

  return (
    <View style={[styles.outer, { width, height }]}>
      {colors.map((c, i) => (
        <View
          key={`${c}-${i}`}
          style={[styles.segment, { backgroundColor: MTG_COLOR_HEX[c] }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    flexDirection: 'row',
    borderRadius: 2,
    borderWidth: 1,
    borderColor: '#1F2937',
    overflow: 'hidden',
  },
  fill: { flex: 1 },
  segment: {
    flex: 1,
    minWidth: 0,
  },
});

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';

type Props = {
  /** icon_slot 1-15 (uno por logro): placeholder numerado hasta que exista el arte final. */
  slot: number;
  /** Conseguida: en color (dorado). No conseguida: apagada, en escala de grises. */
  unlocked: boolean;
  size?: number;
};

/** Medalla placeholder de un logro: círculo con el número del slot. */
export default function AchievementMedal({ slot, unlocked, size = 48 }: Props) {
  const styles = useThemedStyles(createStyles);
  return (
    <View
      style={[
        styles.base,
        unlocked ? styles.on : styles.off,
        { width: size, height: size, borderRadius: size / 2 },
      ]}
    >
      <Text style={[styles.num, unlocked ? styles.numOn : styles.numOff, { fontSize: Math.round(size * (slot >= 10 ? 0.36 : 0.42)) }]}>
        {slot}
      </Text>
    </View>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    base: { alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
    on: { backgroundColor: c.achievement.solid, borderColor: c.achievement.border },
    off: { backgroundColor: c.backgroundAlt, borderColor: c.border },
    num: { fontWeight: '800' },
    numOn: { color: c.achievement.onSolid },
    numOff: { color: c.textMuted },
  });

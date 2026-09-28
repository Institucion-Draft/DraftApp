import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';
import { ACHIEVEMENT_MEDAL_IMAGES } from '../assets/achievementImages';

type Props = {
  /** code único del logro (achievement_definitions.code). */
  code: string;
  /** Conseguida: arte a color. No conseguida: arte en escala de grises. */
  unlocked: boolean;
  size?: number;
  /** 'circle' (default, usado en Medallero/Lista/Bitácora) o 'square' (Detalle). */
  shape?: 'circle' | 'square';
};

/** Medalla de un logro: arte real (a color si está conseguida, gris si no). */
export default function AchievementMedal({ code, unlocked, size = 48, shape = 'circle' }: Props) {
  const styles = useThemedStyles(createStyles);
  const src = ACHIEVEMENT_MEDAL_IMAGES[code];
  const radius = shape === 'circle' ? size / 2 : 0;

  if (!src) {
    // No debería pasar con datos válidos del backend: red de seguridad visual.
    return (
      <View
        style={[
          styles.base,
          styles.off,
          { width: size, height: size, borderRadius: radius },
        ]}
      >
        <Text style={[styles.num, styles.numOff, { fontSize: Math.round(size * 0.42) }]}>?</Text>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.base,
        unlocked ? styles.on : styles.off,
        { width: size, height: size, borderRadius: radius },
      ]}
    >
      <Image
        source={unlocked ? src.normal : src.locked}
        style={{ width: size, height: size, borderRadius: radius }}
        resizeMode="cover"
      />
    </View>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    base: { alignItems: 'center', justifyContent: 'center', borderWidth: 2, overflow: 'hidden' },
    on: { backgroundColor: c.achievement.solid, borderColor: c.achievement.border },
    off: { backgroundColor: c.backgroundAlt, borderColor: c.border },
    num: { fontWeight: '800' },
    numOff: { color: c.textMuted },
  });

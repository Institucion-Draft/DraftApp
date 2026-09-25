import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';

type Props = {
  style?: StyleProp<ViewStyle>;
};

/** Punto de "no visto". No captura toques. Se posiciona desde afuera con `style`. */
export default function UnseenDot({ style }: Props) {
  const styles = useThemedStyles(createStyles);
  return <View pointerEvents="none" style={[styles.dot, style]} accessibilityLabel="Hay algo sin ver" />;
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    dot: {
      width: 12,
      height: 12,
      borderRadius: 6,
      backgroundColor: c.status.error.solid,
      borderWidth: 2,
      borderColor: c.background,
    },
  });

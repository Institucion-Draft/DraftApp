import React from 'react';
import { Alert, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';

type Props = {
  title: string;
  body: string;
};

export default function InfoTooltip({ title, body }: Props) {
  const styles = useThemedStyles(createStyles);
  return (
    <TouchableOpacity
      style={styles.btn}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      onPress={() => Alert.alert(title, body)}
    >
      <Text style={styles.icon}>ⓘ</Text>
    </TouchableOpacity>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    btn: { paddingHorizontal: 2 },
    icon: { fontSize: 16, color: c.textSecondary, fontWeight: '600' },
  });

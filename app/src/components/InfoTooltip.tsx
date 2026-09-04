import React from 'react';
import { Alert, Text, TouchableOpacity, StyleSheet } from 'react-native';

type Props = {
  title: string;
  body: string;
};

export default function InfoTooltip({ title, body }: Props) {
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

const styles = StyleSheet.create({
  btn: { paddingHorizontal: 2 },
  icon: { fontSize: 16, color: '#6B7280', fontWeight: '600' },
});

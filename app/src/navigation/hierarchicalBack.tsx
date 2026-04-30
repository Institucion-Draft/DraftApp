import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import type { MainStackParamList } from './mainStackParams';

const styles = StyleSheet.create({
  wrap: { paddingVertical: 4, paddingHorizontal: 4, marginLeft: -4 },
  label: { color: '#3B82F6', fontSize: 17 },
});

/** Navegación del stack (cualquier pantalla) — tipado laxo para aceptar props de cada screen. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StackNav = { navigate: (...args: any[]) => void };

/** Reemplaza el back del header: navega al padre lógico en lugar de `goBack()`. */
export function hierarchicalHeaderBack(
  navigation: StackNav,
  target: keyof MainStackParamList,
  params?: MainStackParamList[keyof MainStackParamList]
) {
  return () => (
    <Pressable
      onPress={() => {
        if (params === undefined) {
          navigation.navigate(target);
        } else {
          navigation.navigate(target, params);
        }
      }}
      hitSlop={12}
      style={styles.wrap}
    >
      <Text style={styles.label}>Atrás</Text>
    </Pressable>
  );
}

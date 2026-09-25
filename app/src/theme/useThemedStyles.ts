import { useMemo } from 'react';
import { useTheme } from './ThemeContext';
import type { ThemeColors } from './palette';

/**
 * Patrón estándar para que un `StyleSheet.create` pueda leer el tema. Un StyleSheet a nivel de
 * módulo corre una sola vez al importar el archivo, antes de que exista el tema, así que se lo
 * convierte en una función de `colors` y se memoiza por modo:
 *
 *   const createStyles = (c: ThemeColors) =>
 *     StyleSheet.create({
 *       container: { flex: 1, backgroundColor: c.background },
 *       title: { color: c.text },
 *     });
 *
 *   function MiScreen() {
 *     const styles = useThemedStyles(createStyles);
 *     ...
 *   }
 *
 * `factory` DEBE estar definida a nivel de módulo (referencia estable). Si se define adentro del
 * componente, se regenera en cada render y se pierde la memoización. Para estilos condicionales
 * (badges, estados) conviene leer `colors.status.<estado>` desde `useTheme()` en el componente.
 */
export function useThemedStyles<T>(factory: (colors: ThemeColors) => T): T {
  const { colors } = useTheme();
  return useMemo(() => factory(colors), [factory, colors]);
}

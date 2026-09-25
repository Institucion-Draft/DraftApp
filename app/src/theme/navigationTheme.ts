import { DarkTheme, DefaultTheme } from '@react-navigation/native';
import type { Theme } from '@react-navigation/native';
import type { ThemeColors, ThemeMode } from './palette';

/**
 * Theme de React Navigation derivado de nuestra paleta. Parte de DefaultTheme/DarkTheme (para
 * conservar `fonts` y demás).
 *
 * En modo claro solo fija el fondo/card en blanco y deja `primary`, `text`, `border` y
 * `notification` de DefaultTheme: son los que usan hoy los headers nativos, y así el modo claro
 * queda idéntico al de antes. En modo oscuro se pisan con nuestra paleta.
 */
export function buildNavigationTheme(mode: ThemeMode, colors: ThemeColors): Theme {
  if (mode === 'light') {
    return {
      ...DefaultTheme,
      colors: { ...DefaultTheme.colors, background: colors.background, card: colors.background },
    };
  }
  return {
    ...DarkTheme,
    colors: {
      ...DarkTheme.colors,
      primary: colors.accent,
      background: colors.background,
      card: colors.background,
      text: colors.text,
      border: colors.border,
      notification: colors.status.error.solid,
    },
  };
}

import React from 'react';
import { StatusBar } from 'react-native';
import { DefaultTheme } from '@react-navigation/native';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { ForceLightTheme } from './ThemeContext';

/**
 * Guarda para las pantallas que SIEMPRE se ven en su estilo claro, sin importar el modo global.
 * Las screens guardadas no consumen el ThemeContext por su cuenta; este archivo es lo único que las
 * aísla, en dos niveles:
 *   1. Navegación: fondo del contenido, header y barra de estado (options + layout).
 *   2. Subárbol: el layout envuelve la screen en `ForceLightTheme`, así que CUALQUIER componente
 *      que use `useTheme()`/`useThemedStyles()` debajo (incluidos los compartidos y los Modal) recibe
 *      la paleta clara. Esto evita que un componente compartido ya migrado (p. ej. PlayerAvatar
 *      dentro de LifeChart) pinte con la paleta oscura sobre el fondo claro de una pantalla guardada.
 *
 * Guardas permanentes (pantallas excluidas del modo oscuro de forma definitiva, no se sacan en
 * tandas futuras):
 *   - LifeTracker, ContextFreeLifeTracker y LifeChart: estética propia del life tracker.
 *   - ProDeC: excluida por decisión de diseño.
 *   - DraftTimerConfig, DraftTimerAdvanced, DraftTimerSim y DraftTimerPreview: comparten la estética
 *     de cronómetro (DraftTimerScreen, la pantalla del temporizador en sí, sí está migrada).
 * Si una pantalla necesitara una guarda TEMPORAL (depende visualmente de componentes todavía sin
 * migrar), se agrega acá con su motivo y se saca al migrarlos. Hoy no hay ninguna.
 *
 * Se usa en `MainNavigator`:
 *   <Stack.Screen ... options={{ ...LIGHT_LOCKED_OPTIONS, title: '...' }} layout={lightLockedLayout} />
 *
 * - Options: fondo del contenido y header con los colores claros de DefaultTheme (lo que
 *   mostraban antes de existir el modo oscuro).
 * - Layout: fuerza la barra de estado en `dark-content` (texto oscuro sobre fondo blanco)
 *   mientras la screen está montada (al salir vuelve al valor del modo global) y envuelve la screen
 *   en `ForceLightTheme`. El header queda fuera del layout: lo cubren las options.
 */
export const LIGHT_LOCKED_OPTIONS: NativeStackNavigationOptions = {
  contentStyle: { backgroundColor: '#ffffff' },
  headerStyle: { backgroundColor: DefaultTheme.colors.card },
  headerTintColor: DefaultTheme.colors.primary,
  headerTitleStyle: { color: DefaultTheme.colors.text },
};

export function lightLockedLayout({ children }: { children: React.ReactElement }) {
  return (
    <>
      <StatusBar barStyle="dark-content" />
      <ForceLightTheme>{children}</ForceLightTheme>
    </>
  );
}

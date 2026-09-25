import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { palettes } from './palette';
import type { ThemeColors, ThemeMode } from './palette';

const STORAGE_KEY = 'draftapp.themeMode';

type ThemeContextValue = {
  mode: ThemeMode;
  colors: ThemeColors;
  toggleMode: () => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/**
 * Modo de la app: 'light' por defecto y NO sigue el sistema operativo. Se persiste en
 * AsyncStorage; hasta leerlo no se renderiza nada, para no mostrar un frame claro y recién
 * después pasar a oscuro.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>('light');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (active && (stored === 'light' || stored === 'dark')) setMode(stored);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setHydrated(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const toggleMode = useCallback(() => {
    const next: ThemeMode = mode === 'light' ? 'dark' : 'light';
    setMode(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
  }, [mode]);

  // `colors` es una constante por modo (referencia estable), así que sirve como dependencia de useMemo.
  const value = useMemo<ThemeContextValue>(
    () => ({ mode, colors: palettes[mode], toggleMode }),
    [mode, toggleMode]
  );

  if (!hydrated) return null;

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Fuerza la paleta clara en todo su subárbol, sin importar el modo global: cualquier `useTheme()`
 * / `useThemedStyles()` debajo recibe `mode: 'light'` y `lightColors`. Lo usa la guarda de
 * `theme/lightLock.tsx`. `toggleMode` sigue apuntando al provider real.
 */
export function ForceLightTheme({ children }: { children: React.ReactNode }) {
  const parent = useTheme();
  const value = useMemo<ThemeContextValue>(
    () => ({ mode: 'light', colors: palettes.light, toggleMode: parent.toggleMode }),
    [parent.toggleMode]
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme debe usarse dentro de ThemeProvider');
  return ctx;
}

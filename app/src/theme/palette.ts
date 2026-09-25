/**
 * Paletas de tokens semánticos de la UI (modo claro y oscuro).
 *
 * Reglas:
 * - Los valores de `light` reproducen los colores más comunes que ya usa la app, para que el
 *   modo claro se vea igual que siempre.
 * - NINGÚN valor de UI puede coincidir con un color de Magic (`MTG_COLOR_HEX` en
 *   `components/ColorFlag.tsx`: #FFFBE0, #3B82F6, #1F2937, #EF4444, #10B981, #9CA3AF). Los colores
 *   MTG son contenido y no cambian con el tema; si la UI compartiera hex con ellos, un
 *   buscar/reemplazar futuro confundiría "esto es UI" con "esto es contenido". Por eso `accent`,
 *   `textMuted` y los `solid` de info/success son un tono apenas distinto de los Tailwind
 *   originales (#3b82f6, #9ca3af, #10b981).
 * - Los colores de contenido MTG (W/U/B/R/G/C, COLOR_BG, COLOR_HEX) no viven acá.
 */

export type ThemeMode = 'light' | 'dark';

/** Los 4 roles de un mismo estado, siempre juntos: badge = subtle + border + text; botón = solid. */
export type StatusColors = {
  /** Fondo suave (badges, banners). */
  subtle: string;
  border: string;
  /** Texto legible sobre `subtle`. */
  text: string;
  /** Color pleno (botones, íconos, indicadores). */
  solid: string;
  /** Texto/ícono sobre `solid` (p. ej. el label de un botón relleno). */
  onSolid: string;
};

export type ThemeColors = {
  /** Fondo base de pantalla. */
  background: string;
  /** Fondo alternativo: secciones, chips, filas rayadas. */
  backgroundAlt: string;
  /** Superficie elevada (cards). */
  card: string;

  /** Texto principal. */
  text: string;
  /** Texto de cuerpo un poco más suave que `text` (párrafos). */
  textBody: string;
  textSecondary: string;
  /** Placeholders, hints, texto deshabilitado. */
  textMuted: string;

  border: string;
  borderStrong: string;
  /** Separadores finos entre secciones. */
  divider: string;

  accent: string;
  /** Texto/ícono sobre un fondo `accent` (o cualquier `status.*.solid`). */
  onAccent: string;

  status: {
    error: StatusColors;
    warning: StatusColors;
    success: StatusColors;
    info: StatusColors;
  };

  /**
   * Rol de organizador (lila/violeta). Misma forma que un estado: badge = subtle + text (+ border);
   * insignia/botón lleno = solid + onSolid. Lo comparten el badge "Organizador" del workspace y la
   * insignia "O" de posta del evento.
   */
  organizer: StatusColors;

  /** Fondo semitransparente detrás de modales. */
  overlay: string;
  /** Color de sombra (iOS shadowColor). */
  shadow: string;
};

export const lightColors: ThemeColors = {
  background: '#ffffff',
  backgroundAlt: '#f3f4f6',
  card: '#fafafa',

  text: '#111111',
  textBody: '#374151',
  textSecondary: '#6b7280',
  textMuted: '#9aa0ac',

  border: '#e5e7eb',
  borderStrong: '#d1d5db',
  divider: '#eeeeee',

  accent: '#3a80f5',
  onAccent: '#ffffff',

  status: {
    error: { subtle: '#fee2e2', border: '#fecaca', text: '#991b1b', solid: '#dc2626', onSolid: '#ffffff' },
    warning: { subtle: '#fef3c7', border: '#fde68a', text: '#92400e', solid: '#f59e0b', onSolid: '#111111' },
    success: { subtle: '#dcfce7', border: '#bbf7d0', text: '#166534', solid: '#12b67e', onSolid: '#111111' },
    info: { subtle: '#eff6ff', border: '#dbeafe', text: '#1d4ed8', solid: '#3a80f5', onSolid: '#ffffff' },
  },

  organizer: { subtle: '#f5f3ff', border: '#ddd6fe', text: '#6d28d9', solid: '#7c3aed', onSolid: '#ffffff' },

  overlay: 'rgba(0,0,0,0.45)',
  shadow: '#000000',
};

export const darkColors: ThemeColors = {
  background: '#0e1116',
  backgroundAlt: '#1a1f27',
  card: '#212934',

  text: '#f3f4f6',
  textBody: '#d1d5db',
  textSecondary: '#a3aab5',
  textMuted: '#7d8590',

  border: '#2b323c',
  borderStrong: '#3a424e',
  divider: '#222831',

  accent: '#4f8ef7',
  onAccent: '#ffffff',

  status: {
    error: { subtle: '#3a1618', border: '#5c2226', text: '#fca5a5', solid: '#f26b6f', onSolid: '#0e1116' },
    warning: { subtle: '#3a2a0c', border: '#5c4413', text: '#fcd34d', solid: '#f0a020', onSolid: '#0e1116' },
    success: { subtle: '#0f2f22', border: '#17492f', text: '#86efac', solid: '#2fbf8a', onSolid: '#0e1116' },
    info: { subtle: '#1c3a66', border: '#274d88', text: '#93c5fd', solid: '#4f8ef7', onSolid: '#0e1116' },
  },

  organizer: { subtle: '#2e2150', border: '#4a3a80', text: '#c4b5fd', solid: '#9770f7', onSolid: '#0e1116' },

  overlay: 'rgba(0,0,0,0.6)',
  shadow: '#000000',
};

export const palettes: Record<ThemeMode, ThemeColors> = {
  light: lightColors,
  dark: darkColors,
};

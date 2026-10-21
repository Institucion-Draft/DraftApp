/**
 * Iniciales de Gen 3 que muestra el aviso de desbloqueo, en orden: Treecko (#252), Torchic (#255), Mudkip (#258).
 * Se identifican por especie (no por ids de base): el storage_path de default_avatars es `default-avatars/<especie>.png`
 * (migración 0142), así que se resuelven con defaultAvatarPublicUrl sin consultar la tabla.
 */
export type Gen3Starter = { dex: number; species: string; storagePath: string };

const STARTERS: { dex: number; species: string }[] = [
  { dex: 252, species: 'treecko' },
  { dex: 255, species: 'torchic' },
  { dex: 258, species: 'mudkip' },
];

export function gen3Starters(): Gen3Starter[] {
  return STARTERS.map((s) => ({ ...s, storagePath: `default-avatars/${s.species}.png` }));
}

/** Medidas del aviso (en px). El PNG de 96x96 tiene mucho aire transparente: se recorta a la zona del sprite. */
export const STARTER_SPRITE_PX = 88;
export const STARTER_GAP_PX = 8;
// Zona opaca de los tres PNG (en una grilla de 96): x 27..68, y 26..71. Se recorta con un pequeño margen.
const CROP_X0 = 24 / 96;
const CROP_Y0 = 25 / 96;
const CROP_W = 48 / 96;
const CROP_H = 47 / 96;
const CARD_MAX_WIDTH = 320; // appAlert.tsx: card.maxWidth
const BACKDROP_PADDING = 32; // appAlert.tsx: backdrop.paddingHorizontal (a cada lado)
const CONTENT_PADDING = 20; // appAlert.tsx: content.paddingHorizontal (a cada lado)

export type StartersLayout = {
  /** Lado con que se dibuja el PNG completo (88 salvo en pantallas muy angostas). */
  size: number;
  gap: number;
  /** Ventana visible de cada sprite (recorte del aire transparente). */
  clipWidth: number;
  clipHeight: number;
  /** Desplazamiento del PNG dentro de la ventana. */
  offsetX: number;
  offsetY: number;
  /** Ancho total de la fila. */
  totalWidth: number;
};

/** Medidas según el ancho de pantalla: 88 px si entran las tres ventanas con su separación; si no, lo mínimo necesario. */
export function startersLayout(windowWidth: number): StartersLayout {
  const inner = Math.min(CARD_MAX_WIDTH, windowWidth - 2 * BACKDROP_PADDING) - 2 * CONTENT_PADDING;
  const gap = STARTER_GAP_PX;
  const fit = Math.floor((inner - 2 * gap) / (3 * CROP_W));
  const size = Math.max(24, Math.min(STARTER_SPRITE_PX, fit));
  const clipWidth = Math.round(size * CROP_W);
  return {
    size,
    gap,
    clipWidth,
    clipHeight: Math.round(size * CROP_H),
    offsetX: -Math.round(size * CROP_X0),
    offsetY: -Math.round(size * CROP_Y0),
    totalWidth: clipWidth * 3 + gap * 2,
  };
}

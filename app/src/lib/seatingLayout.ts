/**
 * Medidas y adornos de la pantalla de la mesa (sorteo de lugares): lógica pura, sin React.
 *  - scatterEmojis: 🥐/🃏/🧉 desperdigados sobre la mesa antes del sorteo, determinísticos por id de evento.
 *  - tableBodySize: ancho y alto de la mesa según la cantidad de lugares.
 *  - circuitArrows: flechas curvas que envuelven la mesa en forma de óvalo.
 */
import { tableLayout, type PackDirection } from './eventSeating';

// ── Semilla determinística ───────────────────────────────────────────────────────────────────────────────────────
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Emojis sobre la mesa ─────────────────────────────────────────────────────────────────────────────────────────
export const SCATTER_COLS = 3;
export const SCATTER_ROWS = 4;
/** Celdas (col,row) del centro: quedan libres para los vórtices del sorteo. */
const CENTER_CELLS = new Set(['1,1', '1,2']);

export type ScatterEmoji = {
  emoji: '🥐' | '🃏' | '🧉';
  /** Esquina superior izquierda como fracción (0..1) del ancho/alto de la mesa. */
  left: number;
  top: number;
  col: number;
  row: number;
  /** Grados. */
  rotate: number;
};

/**
 * Entre 2 y 4 🥐, entre 2 y 4 🃏 y exactamente un 🧉, cada uno en su propia celda de una grilla de 3x4 (sin las dos del
 * centro) con un pequeño desplazamiento dentro de la celda: nunca se superponen, no se salen del borde ni tapan el área
 * central. Todo sale del id del evento (mismo id => mismo resultado, en cualquier celu y cada vez que se abre). Las
 * posiciones son fracciones de la mesa, así que valen para cualquier tamaño.
 */
export function scatterEmojis(eventId: string): ScatterEmoji[] {
  const rng = mulberry32(hash32(`mesa:${eventId}`));
  const croissants = 2 + Math.floor(rng() * 3);
  const cards = 2 + Math.floor(rng() * 3);
  const kinds: ScatterEmoji['emoji'][] = [
    ...Array.from({ length: croissants }, () => '🥐' as const),
    ...Array.from({ length: cards }, () => '🃏' as const),
    '🧉',
  ];
  // Mezcla de Fisher-Yates de las celdas disponibles y de los emojis.
  const cells: { col: number; row: number }[] = [];
  for (let row = 0; row < SCATTER_ROWS; row += 1) {
    for (let col = 0; col < SCATTER_COLS; col += 1) if (!CENTER_CELLS.has(`${col},${row}`)) cells.push({ col, row });
  }
  const shuffle = <T,>(arr: T[]): T[] => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const cs = shuffle(cells);
  const ks = shuffle(kinds);
  return ks.map((emoji, i) => {
    const { col, row } = cs[i];
    const jx = rng() * 0.12; // fracción de la celda
    const jy = rng() * 0.12;
    return {
      emoji,
      col,
      row,
      left: (col + jx) / SCATTER_COLS,
      top: (row + jy) / SCATTER_ROWS,
      rotate: Math.round((rng() - 0.5) * 40),
    };
  });
}

// ── Tamaño de la mesa ────────────────────────────────────────────────────────────────────────────────────────────
export const BODY_MIN_W = 100;
export const BODY_MAX_W = 160;
export const BODY_MIN_H = 112;

/**
 * Relación alto/ancho de la mesa: n=2 y n=3 compactas, n=4 casi cuadrada, y de ahí crece con los lugares de cada lado
 * (1 + 0.5 por cada lugar de más en un lado): n=5-6 → 1,5; n=7-8 → 2; n=9-10 → 2,5...
 */
export function tableAspect(n: number): number {
  const L = tableLayout(n);
  if (L.n <= 2) return 0.85;
  if (L.n === 3) return 0.95;
  return 1 + 0.5 * (L.perSide - 1);
}

export type TableBodySize = { width: number; height: number; ratio: number };

/**
 * Ancho y alto del rectángulo de la mesa. El ancho queda acotado (BODY_MIN_W..BODY_MAX_W) según el espacio libre entre
 * las columnas de lugares; el alto sale de la relación por cantidad de lugares y nunca es menor a lo que ocupan los
 * lugares de un lado (`cellStep` = alto de un lugar con su nombre). El alto lo absorbe el scroll vertical de la pantalla.
 */
export function tableBodySize(n: number, availableWidth: number, cellStep: number): TableBodySize {
  const L = tableLayout(n);
  const width = Math.round(Math.max(BODY_MIN_W, Math.min(BODY_MAX_W, availableWidth)));
  const height = Math.round(Math.max(BODY_MIN_H, width * tableAspect(n), L.perSide * cellStep));
  return { width, height, ratio: height / width };
}

// ── Flechas curvas del circuito ──────────────────────────────────────────────────────────────────────────────────
export type ArrowPoint = { x: number; y: number };
export type CircuitArrow = {
  /** Puntos del arco, en el orden en que circula el sobre (el último es la punta). */
  points: ArrowPoint[];
  /** Vértices del triángulo de la punta. */
  head: [ArrowPoint, ArrowPoint, ArrowPoint];
};

/** Exponente de la superelipse: > 2 hace el óvalo más "cuadrado" para que abrace los lugares de las esquinas. */
export const OVAL_EXPONENT = 5;

function ovalPoint(deg: number, cx: number, cy: number, a: number, b: number): ArrowPoint {
  const t = (deg * Math.PI) / 180;
  const s = Math.sin(t);
  const c = Math.cos(t);
  const e = 2 / OVAL_EXPONENT;
  return { x: cx + a * Math.sign(s) * Math.abs(s) ** e, y: cy - b * Math.sign(c) * Math.abs(c) ** e };
}

/** ¿El punto (relativo al centro) está dentro del óvalo de semiejes a, b? */
export function insideOval(dx: number, dy: number, a: number, b: number): boolean {
  return Math.abs(dx / a) ** OVAL_EXPONENT + Math.abs(dy / b) ** OVAL_EXPONENT <= 1;
}

/**
 * `count` flechas de arco (3 o 4) repartidas a lo largo de un óvalo que ocupa el rectángulo width x height (con `inset`
 * px de margen), de modo que en conjunto envuelven la mesa. Con 'cw' la punta está al final del arco en sentido horario;
 * con 'ccw', al principio (sentido antihorario).
 */
export function circuitArrows(
  width: number,
  height: number,
  direction: PackDirection,
  opts: { count?: number; spanDeg?: number; inset?: number; headSize?: number } = {}
): CircuitArrow[] {
  const count = Math.min(4, Math.max(3, Math.trunc(opts.count ?? 4)));
  const span = opts.spanDeg ?? (count === 4 ? 58 : 80);
  const inset = opts.inset ?? 6;
  const head = opts.headSize ?? 11;
  const cx = width / 2;
  const cy = height / 2;
  const a = width / 2 - inset;
  const b = height / 2 - inset;
  const step = 360 / count;
  const offset = (step - span) / 2; // el hueco entre flechas queda centrado en los ejes
  const arrows: CircuitArrow[] = [];
  for (let k = 0; k < count; k += 1) {
    const start = k * step + offset;
    const pts: ArrowPoint[] = [];
    const N = 24;
    for (let i = 0; i <= N; i += 1) pts.push(ovalPoint(start + (span * i) / N, cx, cy, a, b));
    const ordered = direction === 'cw' ? pts : [...pts].reverse();
    const tip = ordered[ordered.length - 1];
    const prev = ordered[ordered.length - 3];
    const dx = tip.x - prev.x;
    const dy = tip.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    arrows.push({
      points: ordered,
      head: [
        tip,
        { x: tip.x - ux * head + nx * head * 0.55, y: tip.y - uy * head + ny * head * 0.55 },
        { x: tip.x - ux * head - nx * head * 0.55, y: tip.y - uy * head - ny * head * 0.55 },
      ],
    });
  }
  return arrows;
}

/**
 * Textos de las tarjetas del simulador de sorteo de zonas (ZonesDrawScreen) a partir de las opciones del
 * planificador (zonesPlanner.ts). Módulo puro: sin React ni Supabase, así se puede probar sin UI. Los nombres de
 * las copas se reciben por parámetro (los arma el helper de knockoutRounds.ts con la sede del evento).
 */
import type { ZoneOption } from './zonesPlanner';

export type CupNames = {
  /** "Copa {sede}" (o "Copa" sin sede). */
  prima: string;
  /** "Copa Consuelo". */
  consuelo: string;
};

export type ZoneOptionText = {
  /** "3 zonas · 4-4-4" */
  title: string;
  /** "Partidos por jugador en fase de grupos: 3" (o "2/3" si son desiguales) */
  matches: string;
  /** "Interzonal: Sí" | "Interzonal: No" */
  interzonal: string;
  /** "Jugadores que clasifican por grupo: 2" (con comodines: "2 + 2 mejores 3°") */
  qualifiers: string;
  /** "Jugadores a Copa Quito: 8" */
  copa: string;
  /** "Jugadores a Copa Consuelo: 4" (con menos de 4: "3 (no se arma)") */
  consuelo: string;
  warnings: string[];
  blockers: string[];
};

export function zoneMatchesText(o: Pick<ZoneOption, 'matchesMin' | 'matchesMax'>): string {
  const n = o.matchesMin === o.matchesMax ? `${o.matchesMin}` : `${o.matchesMin}/${o.matchesMax}`;
  return `Partidos por jugador en fase de grupos: ${n}`;
}

export function zoneInterzonalText(o: Pick<ZoneOption, 'interzonal'>): string {
  return `Interzonal: ${o.interzonal ? 'Sí' : 'No'}`;
}

export function zoneQualifiersText(o: Pick<ZoneOption, 'qualifiers' | 'wildcards'>): string {
  const base = `${o.qualifiers}`;
  const value = o.wildcards > 0 ? `${base} + ${o.wildcards} mejores ${o.qualifiers + 1}°` : base;
  return `Jugadores que clasifican por grupo: ${value}`;
}

export function zoneCopaText(o: Pick<ZoneOption, 'copaSize'>, names: CupNames): string {
  return `Jugadores a ${names.prima}: ${o.copaSize}`;
}

export function zoneConsueloText(o: Pick<ZoneOption, 'consueloSize' | 'consueloCreated'>, names: CupNames): string {
  return `Jugadores a ${names.consuelo}: ${o.consueloCreated ? o.consueloSize : `${o.consueloSize} (no se arma)`}`;
}

export function zoneOptionText(o: ZoneOption, names: CupNames): ZoneOptionText {
  return {
    title: `${o.zonesCount} zonas · ${o.zoneSizes.join('-')}`,
    matches: zoneMatchesText(o),
    interzonal: zoneInterzonalText(o),
    qualifiers: zoneQualifiersText(o),
    copa: zoneCopaText(o, names),
    consuelo: zoneConsueloText(o, names),
    warnings: o.warnings,
    blockers: o.blockers,
  };
}

/** Las 5 líneas de una tarjeta, en orden, después del título. */
export function zoneOptionLines(t: ZoneOptionText): string[] {
  return [t.matches, t.interzonal, t.qualifiers, t.copa, t.consuelo];
}

/** Clave estable de una opción (k, interzonal, q, w). */
export function zoneOptionKey(o: Pick<ZoneOption, 'zonesCount' | 'interzonal' | 'qualifiers' | 'wildcards'>): string {
  return `${o.zonesCount}|${o.interzonal ? 1 : 0}|${o.qualifiers}|${o.wildcards}`;
}

/** Geometría del esquema visual (ZonesSchema): qué filas pasan, cuáles son candidatas y entre qué zonas hay flechas. */
export type ZonesSchemaModel = {
  /** Tamaño de cada zona, de la más grande a la más chica. */
  sizes: number[];
  qualifiers: number;
  wildcards: number;
  /** Por columna: la fila q (0-based) lleva borde punteado (candidata a mejor del puesto siguiente). */
  wildcardRow: boolean[];
  /** Pares de columnas contiguas (i, i+1) con una flecha de interzonal. */
  arrows: [number, number][];
  /** Filas de la Copa (q) y de Consuelo (el resto, hasta la zona más grande). */
  copaRows: number;
  /** Primera fila (0-based) desde la que TODAS las columnas son sólo grises (sin fila resaltada ni punteada). */
  grayStart: number;
  /** Filas del bloque gris (de grayStart hasta el final de la zona más grande). */
  consueloRows: number;
  consueloCreated: boolean;
};

export function zonesSchemaModel(o: ZoneOption): ZonesSchemaModel {
  const sizes = [...o.zoneSizes].sort((a, b) => b - a);
  const k = sizes.length;
  const allEqual = sizes.every((s) => s === sizes[0]);
  const wildcardRow = sizes.map((s) => o.wildcards > 0 && s >= o.qualifiers + 1);
  const arrows: [number, number][] = [];
  if (o.interzonal) {
    // Zonas desiguales: sólo entre las chicas (obligatorio). Iguales: pares contiguos (k=2 una flecha;
    // k=3, dos: 0-1 y 1-2; k=4, dos: 0-1 y 2-3).
    const start = allEqual ? 0 : sizes.filter((s) => s === sizes[0]).length;
    const idx = Array.from({ length: k - start }, (_, i) => start + i);
    if (idx.length === 2) arrows.push([idx[0], idx[1]]);
    else if (idx.length === 3) arrows.push([idx[0], idx[1]], [idx[1], idx[2]]);
    else if (idx.length === 4) arrows.push([idx[0], idx[1]], [idx[2], idx[3]]);
  }
  // Las filas punteadas (q+1) todavía no son "sólo grises": el bloque gris arranca después.
  const grayStart = o.qualifiers + (wildcardRow.some(Boolean) ? 1 : 0);
  return {
    sizes,
    qualifiers: o.qualifiers,
    wildcards: o.wildcards,
    wildcardRow,
    arrows,
    copaRows: o.qualifiers,
    grayStart,
    consueloRows: Math.max(0, sizes[0] - grayStart),
    consueloCreated: o.consueloCreated,
  };
}

export type SchemaBox = { top: number; height: number };

export type ZonesSchemaLayout = {
  /** Alto de las filas (zona más grande). */
  height: number;
  /** Espacio a reservar arriba / abajo para lo que sobresale de las filas. */
  padTop: number;
  padBottom: number;
  /** Llave que encierra a los clasificados (filas 0..q-1) y su etiqueta. */
  copaBracket: SchemaBox;
  copaLabel: SchemaBox;
  /** Llave del bloque gris y su etiqueta; null si Consuelo no se arma (menos de 4 jugadores) o no hay filas grises. */
  consuelo: { bracket: SchemaBox; label: SchemaBox } | null;
};

/**
 * Posiciones (px, con el origen en el borde superior de la primera fila) de las llaves y etiquetas del esquema.
 * - Copa: la etiqueta se centra sobre su llave; si es más alta, se ancla al borde inferior de la llave y crece
 *   hacia arriba (nunca queda más abajo que su llave).
 * - Consuelo: la llave encierra sólo el bloque gris (desde grayStart) y la etiqueta arranca en su borde superior,
 *   creciendo hacia abajo. Si Consuelo no se arma, no hay llave ni etiqueta.
 * Como la llave de la Copa termina antes de grayStart, las etiquetas no se pisan nunca.
 */
export function zonesSchemaLayout(
  m: ZonesSchemaModel,
  rowH: number,
  copaLabelH: number,
  consueloLabelH: number
): ZonesSchemaLayout {
  const height = (m.sizes[0] ?? 0) * rowH;
  const copaBracket: SchemaBox = { top: 0, height: m.copaRows * rowH };
  const copaLabel: SchemaBox = {
    top: copaLabelH <= copaBracket.height ? (copaBracket.height - copaLabelH) / 2 : copaBracket.height - copaLabelH,
    height: copaLabelH,
  };
  const consuelo =
    m.consueloCreated && m.consueloRows > 0
      ? {
          bracket: { top: m.grayStart * rowH, height: m.consueloRows * rowH } as SchemaBox,
          label: { top: m.grayStart * rowH, height: consueloLabelH } as SchemaBox,
        }
      : null;
  const padTop = Math.max(0, -copaLabel.top);
  const padBottom = consuelo ? Math.max(0, consuelo.label.top + consuelo.label.height - height) : 0;
  return { height, padTop, padBottom, copaBracket, copaLabel, consuelo };
}

/**
 * Planificador de zonas de la Copa (grupos + llaves, competition_format = 'zones_knockout').
 *
 * Módulo puro (sin React ni Supabase): dado el número de inscriptos activos N arma las combinaciones posibles
 * de zonas (k = 2..4), interzonal, clasificados por zona (q) y "mejores del puesto siguiente" (w), con sus
 * derivados, bloqueos, advertencias y las recomendadas. El servidor (draw_zones, migración 0136) revalida
 * EXACTAMENTE las mismas reglas de interzonal y de bloqueo; este módulo es la fuente para la UI (B1b).
 *
 * Reglas de interzonal (cada jugador que lo juega, juega exactamente UNO contra alguien de OTRA zona):
 * - Zonas iguales (N divisible por k): opcional, posible sólo si N es par; lo juegan todos.
 * - Zonas desiguales (r = N mod k zonas de s+1, k-r zonas de s): obligatorio si es posible y lo juegan SÓLO los
 *   jugadores de las zonas chicas (tamaño s), cada uno contra otro de otra zona chica. Posible con al menos 2
 *   zonas chicas y una cantidad par de jugadores en ellas. Si no es posible: sin interzonal y partidos desiguales.
 */

export const ZONES_MIN = 2;
export const ZONES_MAX = 4;
/** Tamaño permitido del cuadro de la Copa (k*q + w). */
export const COPA_MIN = 4;
export const COPA_MAX = 16;
/** Rango de partidos por jugador sin advertencia. */
export const MATCHES_WARN_MIN = 3;
export const MATCHES_WARN_MAX = 7;
/** Consuelo se arma sólo con al menos esta cantidad de jugadores. */
export const CONSUELO_MIN = 4;

export type InterzonalMode = 'optional' | 'mandatory' | 'impossible';

export type ZoneLayout = {
  /** Tamaños por zona (A, B, C, D): primero las grandes (s+1), después las chicas (s). */
  sizes: number[];
  /** Cantidad de zonas grandes (r = N mod k). 0 = zonas iguales. */
  bigZones: number;
  smallSize: number;
  mode: InterzonalMode;
  /** Jugadores que juegan el interzonal si se juega. */
  interzonalPlayers: number;
};

export type ZoneOption = {
  zonesCount: number;
  zoneSizes: number[];
  /** Interzonal RESUELTO de esta opción. */
  interzonal: boolean;
  interzonalMode: InterzonalMode;
  qualifiers: number;
  wildcards: number;
  /** Partidos por jugador, mínimo y máximo entre todos los inscriptos. */
  matchesMin: number;
  matchesMax: number;
  /** Total de la Copa: k*q + w. */
  copaSize: number;
  /** Jugadores de Consuelo: N - T (se arma sólo con >= 4). */
  consueloSize: number;
  /** Consuelo se arma (al menos CONSUELO_MIN jugadores). */
  consueloCreated: boolean;
  /** No se puede confirmar. */
  blockers: string[];
  /** Se puede confirmar. */
  warnings: string[];
};

export type ZonesInput = {
  /** Inscriptos activos. */
  playerCount: number;
  /** Formato de las partidas (no cambia ninguna regla de zonas; se acepta para que la UI lo pase completo). */
  matchFormat?: 'bo1' | 'bo2' | 'bo3';
};

/** Reparto de N jugadores en k zonas: diferencia máxima de 1 entre zonas. */
export function zoneLayout(n: number, k: number): ZoneLayout {
  const s = Math.floor(n / k);
  const r = n % k;
  const sizes: number[] = [];
  for (let i = 0; i < k; i += 1) sizes.push(i < r ? s + 1 : s);
  let mode: InterzonalMode;
  let interzonalPlayers: number;
  if (r === 0) {
    interzonalPlayers = n;
    mode = n % 2 === 0 ? 'optional' : 'impossible';
  } else {
    const smallZones = k - r;
    interzonalPlayers = smallZones * s;
    mode = smallZones >= 2 && interzonalPlayers % 2 === 0 ? 'mandatory' : 'impossible';
  }
  return { sizes, bigZones: r, smallSize: s, mode, interzonalPlayers };
}

/** Partidos de cada zona (por jugador de esa zona) para un interzonal resuelto. */
function zoneMatches(layout: ZoneLayout, interzonal: boolean): number[] {
  return layout.sizes.map((size, idx) => {
    const plays = interzonal && (layout.bigZones === 0 || idx >= layout.bigZones);
    return size - 1 + (plays ? 1 : 0);
  });
}

/**
 * Arma una opción con sus derivados, bloqueos y advertencias.
 * `requestedInterzonal`: lo que pide el organizador; en zonas desiguales con interzonal posible se fuerza a true.
 */
export function buildZoneOption(
  playerCount: number,
  zonesCount: number,
  qualifiers: number,
  wildcards: number,
  requestedInterzonal: boolean
): ZoneOption {
  const n = playerCount;
  const k = zonesCount;
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!Number.isInteger(k) || k < ZONES_MIN || k > ZONES_MAX) {
    blockers.push(`La cantidad de zonas tiene que ser de ${ZONES_MIN} a ${ZONES_MAX}.`);
  }
  const safeK = Math.min(Math.max(Math.trunc(k) || ZONES_MIN, ZONES_MIN), ZONES_MAX);
  const layout = zoneLayout(n, safeK);
  const minSize = Math.min(...layout.sizes);
  if (minSize < 1) blockers.push('Hay más zonas que jugadores.');

  // Interzonal: obligatorio si es posible en zonas desiguales; imposible si lo piden y no se puede.
  let interzonal = false;
  if (layout.mode === 'mandatory') {
    interzonal = true;
  } else if (layout.mode === 'optional') {
    interzonal = requestedInterzonal;
  } else if (requestedInterzonal) {
    blockers.push('El interzonal es imposible con esta cantidad de jugadores y zonas.');
  }

  if (!Number.isInteger(qualifiers) || qualifiers < 1) {
    blockers.push('Tiene que clasificar al menos 1 jugador por zona.');
  } else if (qualifiers > minSize) {
    blockers.push('Los clasificados por zona no pueden superar el tamaño de la zona más chica.');
  }
  const candidates = layout.sizes.filter((sz) => sz >= qualifiers + 1).length;
  if (!Number.isInteger(wildcards) || wildcards < 0 || wildcards > safeK - 1) {
    blockers.push(`Los mejores del puesto siguiente van de 0 a ${safeK - 1}.`);
  } else if (wildcards > candidates) {
    blockers.push('No hay suficientes zonas con jugadores en el puesto siguiente.');
  }

  const copaSize = safeK * qualifiers + wildcards;
  if (copaSize < COPA_MIN || copaSize > COPA_MAX) {
    blockers.push(`La Copa tiene que tener entre ${COPA_MIN} y ${COPA_MAX} jugadores (quedan ${copaSize}).`);
  }
  const consueloSize = n - copaSize;

  const zm = zoneMatches(layout, interzonal);
  const matchesMin = Math.min(...zm);
  const matchesMax = Math.max(...zm);
  if (matchesMin < MATCHES_WARN_MIN || matchesMax > MATCHES_WARN_MAX) {
    warnings.push(`Partidos por jugador fuera de ${MATCHES_WARN_MIN} a ${MATCHES_WARN_MAX}.`);
  }
  if (matchesMin !== matchesMax) warnings.push('Partidos desiguales entre zonas.');
  if (copaSize * 3 > n * 2) warnings.push('La Copa tiene más de 2/3 de los inscriptos.');
  if (consueloSize < CONSUELO_MIN) warnings.push(`Consuelo tendría menos de ${CONSUELO_MIN} jugadores: no se arma.`);

  return {
    zonesCount: safeK,
    zoneSizes: layout.sizes,
    interzonal,
    interzonalMode: layout.mode,
    qualifiers,
    wildcards,
    matchesMin,
    matchesMax,
    copaSize,
    consueloSize,
    consueloCreated: consueloSize >= CONSUELO_MIN,
    blockers,
    warnings,
  };
}

/** Todas las combinaciones sin bloqueos (cada (k, interzonal, q, w) una vez). */
export function enumerateZoneOptions(input: ZonesInput): ZoneOption[] {
  const n = input.playerCount;
  const out: ZoneOption[] = [];
  for (let k = ZONES_MIN; k <= ZONES_MAX; k += 1) {
    const layout = zoneLayout(n, k);
    const minSize = Math.min(...layout.sizes);
    if (minSize < 1) continue;
    const izValues = layout.mode === 'optional' ? [false, true] : layout.mode === 'mandatory' ? [true] : [false];
    for (const iz of izValues) {
      for (let q = 1; q <= minSize; q += 1) {
        for (let w = 0; w <= k - 1; w += 1) {
          const opt = buildZoneOption(n, k, q, w, iz);
          if (opt.blockers.length === 0) out.push(opt);
        }
      }
    }
  }
  return out;
}

/** Fase de grupos pareja: todos los jugadores con los mismos partidos. */
export function isEvenGroupPhase(o: ZoneOption): boolean {
  return o.matchesMin === o.matchesMax;
}

function inRange(o: ZoneOption, lo: number, hi: number): boolean {
  return o.matchesMin >= lo && o.matchesMax <= hi;
}

/** 0 = ideal (3..5 partidos), 1 = aceptable (6..7), 2 = fuera de rango. */
function rangeClass(o: ZoneOption): number {
  if (inRange(o, 3, 5)) return 0;
  if (inRange(o, 6, 7)) return 1;
  return 2;
}

/** Preferencia del tamaño de la Copa: 8, luego 4, luego 6/12/16, luego 10/14, último impares. */
export function copaSizeRank(t: number): number {
  if (t === 8) return 0;
  if (t === 4) return 1;
  if (t === 6 || t === 12 || t === 16) return 2;
  if (t === 10 || t === 14) return 3;
  return 4;
}

type Config = { k: number; interzonal: boolean; options: ZoneOption[] };

function groupByConfig(options: ZoneOption[]): Config[] {
  const map = new Map<string, Config>();
  for (const o of options) {
    const key = `${o.zonesCount}|${o.interzonal}`;
    let c = map.get(key);
    if (!c) {
      c = { k: o.zonesCount, interzonal: o.interzonal, options: [] };
      map.set(key, c);
    }
    c.options.push(o);
  }
  return [...map.values()];
}

/** Dentro de una configuración (k, interzonal), las opciones (q, w) de mejor a peor. */
function sortQW(options: ZoneOption[], n: number): ZoneOption[] {
  const cap = Math.floor((2 * n) / 3);
  const capped = options.filter((o) => o.copaSize <= cap);
  const pool = capped.length > 0 ? capped : options;
  return [...pool].sort(
    (a, b) =>
      copaSizeRank(a.copaSize) - copaSizeRank(b.copaSize) ||
      a.wildcards - b.wildcards ||
      a.qualifiers - b.qualifiers
  );
}

/**
 * Hasta 3 recomendadas, distintas en (k, interzonal, q, w), de mejor a peor.
 * Para N < 8 no hay recomendadas (queda "Personalizar").
 */
export function recommendZoneOptions(input: ZonesInput): ZoneOption[] {
  const n = input.playerCount;
  if (n < 8) return [];
  const all = enumerateZoneOptions(input);
  if (all.length === 0) return [];
  const configs = groupByConfig(all);

  // Primero fase de grupos pareja y en rango; si no hay ninguna, las mejores disponibles (marcadas con advertencia
  // porque ya traen "partidos desiguales" o "fuera de rango").
  const even = configs.filter((c) => isEvenGroupPhase(c.options[0]) && rangeClass(c.options[0]) < 2);
  let ordered: Config[];
  if (even.length > 0) {
    ordered = [...even].sort((a, b) => {
      const oa = a.options[0];
      const ob = b.options[0];
      const ra = rangeClass(oa);
      const rb = rangeClass(ob);
      const pa = a.interzonal && ra === 0 ? 0 : 1;
      const pb = b.interzonal && rb === 0 ? 0 : 1;
      return ra - rb || pa - pb || a.k - b.k;
    });
  } else {
    const spread = (c: Config) => c.options[0].matchesMax - c.options[0].matchesMin;
    const dist = (c: Config) => {
      const o = c.options[0];
      const mid = (o.matchesMin + o.matchesMax) / 2;
      return mid < 3 ? 3 - mid : mid > 5 ? mid - 5 : 0;
    };
    ordered = [...configs].sort((a, b) => spread(a) - spread(b) || dist(a) - dist(b) || a.k - b.k);
  }

  const lists = ordered.map((c) => sortQW(c.options, n));
  const picked: ZoneOption[] = [];
  const seen = new Set<string>();
  for (let round = 0; picked.length < 3 && round < 40; round += 1) {
    let progressed = false;
    for (const list of lists) {
      const o = list[round];
      if (!o) continue;
      progressed = true;
      const key = `${o.zonesCount}|${o.interzonal}|${o.qualifiers}|${o.wildcards}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(o);
      if (picked.length === 3) break;
    }
    if (!progressed) break;
  }
  return picked;
}

/** Consuelo se arma con al menos CONSUELO_MIN jugadores: N - (zonas * clasificados + comodines). */
export function consueloWillBeCreated(playerCount: number, zones: number, qualifiers: number, wildcards: number): boolean {
  return playerCount - (zones * qualifiers + wildcards) >= CONSUELO_MIN;
}

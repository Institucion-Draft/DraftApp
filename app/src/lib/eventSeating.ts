/**
 * Sorteo de lugares en la mesa (migración 0144): lógica pura, sin acceso a datos.
 *
 * Geometría de la mesa, sentido de los sobres, verificador de adyacencia de 2HG y reglas de visibilidad de los botones.
 */

// ── Sentido ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** 'cw' = los sobres pasan del lugar N al N+1 (como el reloj, con la numeración horaria). */
export type PackDirection = 'cw' | 'ccw';

export function oppositeDirection(d: PackDirection): PackDirection {
  return d === 'cw' ? 'ccw' : 'cw';
}

/**
 * Sentido de los sobres del sobre número `packIndex` (1, 2, 3...): el sobre 1 va en el sentido sorteado y se alterna en
 * cada sobre (2 = el opuesto, 3 = el sorteado, etc.). Un índice menor a 1 se trata como el sobre 1.
 */
export function packDirection(first: PackDirection, packIndex: number): PackDirection {
  const idx = Number.isFinite(packIndex) ? Math.max(1, Math.trunc(packIndex)) : 1;
  return idx % 2 === 1 ? first : oppositeDirection(first);
}

/** Mate y cigarro giran SIEMPRE al revés que los sobres de ese sobre (no se sortean). */
export function mateDirection(first: PackDirection, packIndex: number): PackDirection {
  return oppositeDirection(packDirection(first, packIndex));
}

// ── Geometría de la mesa ─────────────────────────────────────────────────────────────────────────────────────────
export type SeatZone = 'top' | 'right' | 'bottom' | 'left';

export type TableLayout = {
  n: number;
  /** Lugares en la cabecera de arriba (0 o 1). */
  top: number;
  /** Lugares en la cabecera de abajo (0 o 1). */
  bottom: number;
  /** Lugares en cada lado largo. */
  perSide: number;
};

/**
 * Siempre un lugar en cada cabecera y el resto repartido en partes iguales en los lados largos; con n impar, una sola
 * cabecera (la de arriba) y el resto equivalente a cada lado. n=2: dos cabeceras. n=3: una cabecera y uno por lado.
 */
export function tableLayout(n: number): TableLayout {
  const total = Math.max(0, Math.trunc(n));
  if (total <= 0) return { n: 0, top: 0, bottom: 0, perSide: 0 };
  if (total === 1) return { n: 1, top: 1, bottom: 0, perSide: 0 };
  if (total % 2 === 0) return { n: total, top: 1, bottom: 1, perSide: (total - 2) / 2 };
  return { n: total, top: 1, bottom: 0, perSide: (total - 1) / 2 };
}

export type SeatSlot = {
  seat: number; // 1..n
  zone: SeatZone;
  /** Posición dentro del lado (0 = el de más arriba) para 'left' y 'right'; 0 en las cabeceras. */
  row: number;
};

/**
 * Numeración en sentido horario empezando en la cabecera de arriba: el 1; después el lado derecho de arriba hacia abajo;
 * la cabecera de abajo (si hay); y el lado izquierdo de abajo hacia arriba.
 * Devuelve un arreglo indexado por (lugar - 1).
 */
export function seatSlots(n: number): SeatSlot[] {
  const L = tableLayout(n);
  const out: SeatSlot[] = [];
  let seat = 1;
  if (L.top) out.push({ seat: seat++, zone: 'top', row: 0 });
  for (let r = 0; r < L.perSide; r += 1) out.push({ seat: seat++, zone: 'right', row: r });
  if (L.bottom) out.push({ seat: seat++, zone: 'bottom', row: 0 });
  for (let r = L.perSide - 1; r >= 0; r -= 1) out.push({ seat: seat++, zone: 'left', row: r });
  return out;
}

// ── 2HG ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Cantidad de pares de lugares contiguos del círculo (k y k+1, y n y 1) que tienen el mismo equipo.
 * `seatTeams[k-1]` es el equipo de quien está en el lugar k. Con n = 2 el par se cuenta una sola vez.
 */
export function adjacentSameTeam(seatTeams: (string | number)[]): number {
  const n = seatTeams.length;
  if (n < 2) return 0;
  let bad = 0;
  for (let k = 0; k < n - 1; k += 1) if (seatTeams[k] === seatTeams[k + 1]) bad += 1;
  if (n > 2 && seatTeams[n - 1] === seatTeams[0]) bad += 1;
  return bad;
}

// ── Vigencia y botones ───────────────────────────────────────────────────────────────────────────────────────────
export type SeatingRowState = { is_current: boolean } | null | undefined;

export function isSeatingCurrent(row: SeatingRowState): boolean {
  return row?.is_current === true;
}

export type SeatingButton =
  | { kind: 'none' }
  | { kind: 'draw'; label: 'Sortear lugares en la mesa' }
  | { kind: 'assignment'; label: 'Asignación de lugares en la mesa' }
  | { kind: 'positions'; label: 'Posiciones en la mesa' };

/**
 * Qué botón se ve en la pantalla del evento.
 *  - Toggle OFF: ninguno.
 *  - Antes de arrancar: quien gestiona ve "Sortear lugares en la mesa"; los demás ven "Asignación de lugares en la mesa"
 *    una vez que existe un sorteo publicado (vigente u obsoleto: si quedó obsoleto el botón NO se oculta, la pantalla
 *    avisa que se va a volver a sortear).
 *  - Arrancado el draft (isDraftStarted) o terminado: con sorteo, quien gestiona ve "Posiciones en la mesa" (sólo lectura)
 *    y los demás "Asignación..."; sin ningún sorteo, nadie ve botón de mesa.
 */
/**
 * ¿El draft ya arrancó? Misma condición que draw_event_seating en la base: hay draft_started_at O el estado ya no es
 * 'scheduled' (drafting, playing, completed, concluded...). Un evento cancelado tampoco está "por arrancar"; sus botones
 * de mesa se ocultan aparte (la pantalla del evento no los muestra si está cancelado).
 */
export function isDraftStarted(event: { status: string | null | undefined; draft_started_at: string | null | undefined }): boolean {
  return !!event.draft_started_at || (event.status != null && event.status !== 'scheduled');
}

export function seatingButton(input: {
  enabled: boolean;
  canManage: boolean;
  draftStarted: boolean;
  seating: SeatingRowState;
}): SeatingButton {
  if (!input.enabled) return { kind: 'none' };
  if (input.draftStarted) {
    // Arrancado o terminado sin ningún sorteo: no hay mesa que mostrar, para nadie.
    if (!input.seating) return { kind: 'none' };
    if (input.canManage) return { kind: 'positions', label: 'Posiciones en la mesa' };
    return { kind: 'assignment', label: 'Asignación de lugares en la mesa' };
  }
  if (input.canManage) return { kind: 'draw', label: 'Sortear lugares en la mesa' };
  return input.seating ? { kind: 'assignment', label: 'Asignación de lugares en la mesa' } : { kind: 'none' };
}

/** ¿Falta el sorteo para poder arrancar el draft? (la base lo exige también). */
export function seatingBlocksStart(input: { enabled: boolean; seating: SeatingRowState }): boolean {
  return input.enabled && !isSeatingCurrent(input.seating);
}

/** Qué ve en la pantalla de la mesa quien la abre. */
export type SeatingScreenMode =
  | 'animating' // el organizador acaba de sortear: ruleta
  | 'pending' // el organizador vuelve con un sorteo sin publicar: se muestra estático y se publica
  | 'current' // mesa sorteada y vigente (estática)
  | 'stale' // obsoleto: los demás ven el aviso
  | 'empty'; // todavía no hay sorteo: mesa vacía

export function seatingScreenMode(input: {
  canManage: boolean;
  hasPending: boolean;
  current: SeatingRowState;
  animating: boolean;
}): SeatingScreenMode {
  if (input.animating) return 'animating';
  if (input.canManage && input.hasPending) return 'pending';
  if (isSeatingCurrent(input.current)) return 'current';
  if (input.current) return input.canManage ? 'empty' : 'stale';
  return 'empty';
}

// ── Personas que se sientan (espejo de seating_persons en la base) ────────────────────────────────────────────────
export type SeatingParticipantRow = {
  id: string;
  user_id: string;
  role: string;
  left_event_at: string | null;
  member_b_user_id: string | null;
};

export type SeatingPerson = { participantId: string; member: 'a' | 'b'; userId: string };

/** Jugadores activos; en 2HG cada equipo aporta dos personas. */
export function seatingPersons(rows: SeatingParticipantRow[]): SeatingPerson[] {
  const out: SeatingPerson[] = [];
  for (const r of rows) {
    if (r.role !== 'player' || r.left_event_at) continue;
    out.push({ participantId: r.id, member: 'a', userId: r.user_id });
    if (r.member_b_user_id) out.push({ participantId: r.id, member: 'b', userId: r.member_b_user_id });
  }
  return out;
}

// ── Ruleta cosmética ─────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Pausas (ms) entre pasos de la ruleta: arrancan rápidas y se van frenando; suman ~totalMs. La animación es sólo
 * cosmética: el resultado ya lo calculó el servidor.
 */
export function rouletteDelays(totalMs = 3000, firstMs = 80, growth = 1.14): number[] {
  const raw: number[] = [];
  let sum = 0;
  let d = firstMs;
  while (sum + d <= totalMs) {
    raw.push(d);
    sum += d;
    d *= growth;
  }
  if (raw.length === 0) return [totalMs];
  // Se reparte lo que sobra para que la suma sea exactamente totalMs.
  const k = totalMs / sum;
  const out = raw.map((x) => Math.round(x * k));
  out[out.length - 1] += totalMs - out.reduce((s, x) => s + x, 0);
  return out;
}

/**
 * Lugar que se muestra para quien está realmente en `seat` durante el paso `step` de `steps`: todos rotan juntos (se
 * conserva la permutación) y en el último paso queda cada uno en su lugar real.
 */
export function rouletteSeat(seat: number, n: number, step: number, steps: number): number {
  if (n <= 0) return seat;
  const offset = Math.max(0, steps - step);
  return ((seat - 1 + offset) % n) + 1;
}

// ── Cronómetro del draft ─────────────────────────────────────────────────────────────────────────────────────────
export type TimerVortexDirections = {
  /** 🃏: sentido de los sobres del sobre actual. */
  packs: PackDirection;
  /** 🧉 y 🚬: siempre el opuesto al de los sobres de ese sobre. */
  mate: PackDirection;
  cigar: PackDirection;
};

/**
 * Sentidos de los tres vórtices del cronómetro. `packNumber` es el número de sobre (1, 2, 3...), el mismo que muestra la
 * pantalla ("Sobre N"): el sobre 1 va en el sentido sorteado y se alterna sobre a sobre.
 */
export function timerVortexDirections(first: PackDirection, packNumber: number): TimerVortexDirections {
  const mate = mateDirection(first, packNumber);
  return { packs: packDirection(first, packNumber), mate, cigar: mate };
}

/** El cronómetro del draft está en curso: esperando o contando (no cargando ni terminado). Una pausa sigue siendo "en curso". */
export function timerIsActive(phase: string): boolean {
  return phase === 'waiting' || phase === 'counting';
}

/** Los vórtices se muestran sólo con el cronómetro en curso, el toggle ON y un sorteo vigente publicado. */
export function timerVorticesVisible(input: {
  phase: string;
  enabled: boolean;
  seating: { is_current: boolean } | null | undefined;
}): boolean {
  return timerIsActive(input.phase) && input.enabled && isSeatingCurrent(input.seating);
}

/** Giran sólo mientras el cronómetro cuenta (no en espera ni en pausa) y la pantalla tiene el foco. */
export function timerVorticesSpinning(input: { phase: string; paused: boolean; focused: boolean }): boolean {
  return input.focused && input.phase === 'counting' && !input.paused;
}

/** Tamaño (px) de cada mini vórtice del cronómetro y separación entre ellos. */
export const TIMER_VORTEX_SIZE = 44;
export const TIMER_VORTEX_GAP = 6;

/** Ancho total de la fila de tres mini vórtices. */
export function timerVorticesRowWidth(size = TIMER_VORTEX_SIZE, gap = TIMER_VORTEX_GAP): number {
  return 3 * size + 2 * gap;
}

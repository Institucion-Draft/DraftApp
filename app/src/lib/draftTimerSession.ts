/**
 * Sesión del cronómetro de rondas cronometradas: lógica pura (sin red, sin React, sin AsyncStorage). La usan draftTimerStore.ts (persistencia),
 * DraftTimerScreen.tsx (guardar/restaurar) y EventDetailScreen.tsx (botón de acceso).
 *
 * SEMÁNTICA DE RESTAURACIÓN (cuenta regresiva por pick, tiempos ABSOLUTOS):
 *  - Una sesión guarda `secondsLeft` y `savedAt`. Si estaba CORRIENDO (phase 'counting' y no pausada) su fin es `savedAt + secondsLeft*1000`:
 *    ese instante absoluto no cambia aunque la app esté cerrada o en segundo plano, así que al volver se descuenta el tiempo real transcurrido.
 *      · Si todavía falta tiempo: sigue corriendo con lo que falta.
 *      · Si ya terminó: se aplica lo mismo que habría pasado en vivo. Si no era la última pick, queda en la siguiente, esperando el "Iniciar"
 *        (como al vencer en vivo; la pick vencida queda pendiente de log). Si era la última, el cronómetro terminó (done) y se loguea con el
 *        instante real de fin. Como cada pick vencida espera un toque manual, a lo sumo vence UNA pick mientras la app no estaba.
 *  - Si estaba PAUSADA: sigue pausada con los mismos segundos (la pausa no consume tiempo, esté o no la app abierta).
 *  - Si estaba ESPERANDO (el "Iniciar" de la pick todavía sin tocar): sigue esperando con la misma pick y sus segundos completos.
 *  - Una sesión de más de 24 h, de otra versión o con datos inválidos se descarta (no se restaura nada raro).
 */

export const TIMER_SESSION_VERSION = 1;
/** Pasado este tiempo desde el último guardado, la sesión se considera abandonada. */
export const TIMER_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type TimerSession = {
  v: typeof TIMER_SESSION_VERSION;
  pickIdx: number;
  /** 'counting' = la pick ya arrancó (corriendo o pausada); 'waiting' = esperando el "Iniciar". */
  phase: 'waiting' | 'counting';
  paused: boolean;
  /** Segundos que faltaban en `savedAt` (en 'waiting', los de la pick completa). */
  secondsLeft: number;
  /** Date.now() (ms) del guardado. */
  savedAt: number;
  /** Date.now() (ms) en que se tocó "Iniciar" en la pick en curso (para el log de duración real); null si no hay. */
  roundStartAt: number | null;
  /** Pick (índice) ya vencida o salteada cuyo log todavía no se escribió (se escribe al tocar "Iniciar" de la siguiente); null si no hay. */
  unloggedPick: number | null;
};

export function serializeTimerSession(s: TimerSession): string {
  return JSON.stringify(s);
}

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** JSON -> sesión válida, o null (texto vacío, JSON roto, otra versión, campos fuera de rango). Nunca lanza. */
export function parseTimerSession(raw: string | null | undefined): TimerSession | null {
  if (!raw) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (r.v !== TIMER_SESSION_VERSION) return null;
  if (!isInt(r.pickIdx) || r.pickIdx < 0) return null;
  if (r.phase !== 'waiting' && r.phase !== 'counting') return null;
  if (typeof r.paused !== 'boolean') return null;
  if (!isNum(r.secondsLeft) || r.secondsLeft < 0) return null;
  if (!isNum(r.savedAt) || r.savedAt <= 0) return null;
  if (r.roundStartAt !== null && !isNum(r.roundStartAt)) return null;
  if (r.unloggedPick !== null && !(isInt(r.unloggedPick) && r.unloggedPick >= 0)) return null;
  return {
    v: TIMER_SESSION_VERSION,
    pickIdx: r.pickIdx,
    phase: r.phase,
    paused: r.paused,
    secondsLeft: Math.round(r.secondsLeft),
    savedAt: r.savedAt,
    roundStartAt: (r.roundStartAt as number | null) ?? null,
    unloggedPick: (r.unloggedPick as number | null) ?? null,
  };
}

/** Arma la sesión a guardar. En 'counting' sin pausa, `endsAt` (ms absolutos) manda: los segundos se recalculan desde ahí. */
export function snapshotTimerSession(input: {
  pickIdx: number;
  phase: 'waiting' | 'counting';
  paused: boolean;
  secondsLeft: number;
  endsAt: number | null;
  roundStartAt: number | null;
  unloggedPick: number | null;
  now: number;
}): TimerSession {
  const running = input.phase === 'counting' && !input.paused && input.endsAt != null;
  const secondsLeft = running ? Math.max(0, Math.ceil(((input.endsAt as number) - input.now) / 1000)) : Math.max(0, Math.round(input.secondsLeft));
  return {
    v: TIMER_SESSION_VERSION,
    pickIdx: input.pickIdx,
    phase: input.phase,
    paused: input.phase === 'counting' ? input.paused : false,
    secondsLeft,
    savedAt: input.now,
    roundStartAt: input.roundStartAt,
    unloggedPick: input.unloggedPick,
  };
}

export type RestoredTimer =
  /** Esperando el "Iniciar" de la pick. */
  | { kind: 'waiting'; pickIdx: number; secondsLeft: number; roundStartAt: number | null; unloggedPick: number | null }
  /** Corriendo: sigue contando hasta `endsAt` (ms absolutos). */
  | { kind: 'running'; pickIdx: number; secondsLeft: number; endsAt: number; roundStartAt: number | null; unloggedPick: number | null }
  /** Pausada con los mismos segundos. */
  | { kind: 'paused'; pickIdx: number; secondsLeft: number; roundStartAt: number | null; unloggedPick: number | null }
  /** Venció mientras la app no estaba: pasa a la siguiente pick esperando el "Iniciar"; la vencida queda pendiente de log. */
  | { kind: 'expired_next'; pickIdx: number; expiredPick: number; roundStartAt: number | null }
  /** Venció la ÚLTIMA pick: el cronómetro terminó. `elapsedSec` = duración real hasta el instante de fin (para el log). */
  | { kind: 'expired_done'; expiredPick: number; elapsedSec: number };

/**
 * Sesión guardada -> qué hacer al volver. `timelineLen` = cantidad de picks de la línea de tiempo actual. null = descartar la sesión
 * (vieja, de otra versión, o con una pick fuera de la línea de tiempo: los jugadores cambiaron y ya no coincide).
 */
export function restoreTimerSession(s: TimerSession | null, timelineLen: number, now: number): RestoredTimer | null {
  if (!s || timelineLen <= 0) return null;
  if (s.pickIdx >= timelineLen) return null;
  if (now - s.savedAt > TIMER_SESSION_MAX_AGE_MS) return null;

  if (s.phase === 'waiting') {
    return { kind: 'waiting', pickIdx: s.pickIdx, secondsLeft: s.secondsLeft, roundStartAt: s.roundStartAt, unloggedPick: s.unloggedPick };
  }
  if (s.paused) {
    return { kind: 'paused', pickIdx: s.pickIdx, secondsLeft: Math.max(1, s.secondsLeft), roundStartAt: s.roundStartAt, unloggedPick: s.unloggedPick };
  }
  // corriendo: fin absoluto = savedAt + secondsLeft
  const endsAt = s.savedAt + s.secondsLeft * 1000;
  if (now < endsAt) {
    return {
      kind: 'running',
      pickIdx: s.pickIdx,
      secondsLeft: Math.max(1, Math.ceil((endsAt - now) / 1000)),
      endsAt,
      roundStartAt: s.roundStartAt,
      unloggedPick: s.unloggedPick,
    };
  }
  const next = s.pickIdx + 1;
  if (next >= timelineLen) {
    const elapsedSec = s.roundStartAt != null ? Math.max(0, Math.round((endsAt - s.roundStartAt) / 1000)) : 0;
    return { kind: 'expired_done', expiredPick: s.pickIdx, elapsedSec };
  }
  return { kind: 'expired_next', pickIdx: next, expiredPick: s.pickIdx, roundStartAt: s.roundStartAt };
}

/**
 * Sin sesión local (app reinstalada, otro celular): retomar desde draft_timer_logs.
 * El log de una pick se escribe al tocar "Iniciar" de la SIGUIENTE (la última, al terminar), así que el último global_pick logueado `g`
 * (1-based) dice que las picks 0..g-1 ya terminaron y se registraron; la pick g (la siguiente) puede haberse jugado sin log todavía: este
 * fallback queda a lo sumo UNA pick atrás, y se corrige con "Siguiente ronda". Siempre en 'waiting' (nunca arranca sola ni termina el draft:
 * si todo estaba logueado se queda en la última pick). Devuelve null si no hay logs.
 */
export function fallbackFromLogs(loggedGlobalPicks: readonly number[], timelineLen: number): { pickIdx: number } | null {
  if (timelineLen <= 0) return null;
  const valid = loggedGlobalPicks.filter((g) => Number.isInteger(g) && g >= 1);
  if (valid.length === 0) return null;
  const maxLogged = Math.max(...valid);
  return { pickIdx: Math.min(maxLogged, timelineLen - 1) };
}

/** ¿Ya hay un log de esta pick (índice 0-based)? Evita duplicados al restaurar o al reintentar. */
export function isPickLogged(logged: ReadonlySet<number>, pickIdx: number): boolean {
  return logged.has(pickIdx + 1);
}

/**
 * Botón "⏱ Rondas cronometradas" del detalle del evento: solo quien gestiona el evento (organizador o posta; el cronómetro es local de cada
 * celular y no se sincroniza, así que a un participante común no le serviría), con el draft cronometrado en curso (arrancó y no terminó) y el
 * evento no cancelado. NO depende de que haya una sesión local guardada.
 */
export function shouldShowTimerButton(input: {
  canManageEvent: boolean;
  isTimedDraft: boolean | null | undefined;
  draftStartedAt: string | null | undefined;
  draftEndedAt: string | null | undefined;
  status: string | null | undefined;
}): boolean {
  return (
    input.canManageEvent &&
    !!input.isTimedDraft &&
    !!input.draftStartedAt &&
    !input.draftEndedAt &&
    input.status !== 'cancelled'
  );
}

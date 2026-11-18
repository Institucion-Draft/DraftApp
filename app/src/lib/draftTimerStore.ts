import AsyncStorage from '@react-native-async-storage/async-storage';
import type { TimerParams } from './draftTimer';
import { parseTimerSession, serializeTimerSession, type TimerSession } from './draftTimerSession';

let _pending: TimerParams | null = null;

export function setPendingTimerParams(p: TimerParams): void {
  _pending = p;
}

export function getAndClearPendingTimerParams(): TimerParams | null {
  const p = _pending;
  _pending = null;
  return p;
}

// --------------- sesión del cronómetro: memoria + AsyncStorage ---------------
// La memoria sirve mientras vive el JS; AsyncStorage sobrevive a matar la app. La lógica de qué se guarda y cómo se restaura es pura y está
// en draftTimerSession.ts. Toda escritura a AsyncStorage es "fire and forget" y nunca lanza: si falla, queda la memoria.

export type { TimerSession } from './draftTimerSession';

const _timerSessions: Record<string, TimerSession> = {};
const storageKey = (eventId: string) => `draft_timer_session_v1:${eventId}`;

export function saveTimerSession(eventId: string, session: TimerSession): void {
  _timerSessions[eventId] = session;
  void AsyncStorage.setItem(storageKey(eventId), serializeTimerSession(session)).catch(() => undefined);
}

/** Solo memoria (síncrono). */
export function getTimerSession(eventId: string): TimerSession | null {
  return _timerSessions[eventId] ?? null;
}

/** Memoria primero; si no hay, AsyncStorage (tras matar la app o reinstalar el JS). Una sesión ilegible cuenta como inexistente. */
export async function loadTimerSession(eventId: string): Promise<TimerSession | null> {
  const mem = _timerSessions[eventId];
  if (mem) return mem;
  try {
    const stored = parseTimerSession(await AsyncStorage.getItem(storageKey(eventId)));
    if (stored) _timerSessions[eventId] = stored;
    return stored;
  } catch {
    return null;
  }
}

/** Borra la sesión de memoria y de AsyncStorage. */
export function clearTimerSession(eventId: string): void {
  delete _timerSessions[eventId];
  void AsyncStorage.removeItem(storageKey(eventId)).catch(() => undefined);
}

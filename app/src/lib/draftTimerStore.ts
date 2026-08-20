import type { TimerParams } from './draftTimer';

let _pending: TimerParams | null = null;

export function setPendingTimerParams(p: TimerParams): void {
  _pending = p;
}

export function getAndClearPendingTimerParams(): TimerParams | null {
  const p = _pending;
  _pending = null;
  return p;
}

// --------------- timer session state (persists while app is in memory) ---------------

export type TimerSessionState = {
  pickIdx: number;
  secondsLeft: number;
  /** 'counting' = was actively running; 'waiting' = was paused or idle */
  phase: 'waiting' | 'counting';
  savedAt: number; // Date.now() ms
};

const _timerSessions: Record<string, TimerSessionState> = {};

export function saveTimerSession(eventId: string, state: TimerSessionState): void {
  _timerSessions[eventId] = state;
}

export function getTimerSession(eventId: string): TimerSessionState | null {
  return _timerSessions[eventId] ?? null;
}

export function clearTimerSession(eventId: string): void {
  delete _timerSessions[eventId];
}

export function hasTimerSession(eventId: string): boolean {
  return eventId in _timerSessions;
}

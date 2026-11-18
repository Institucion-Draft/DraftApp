// Tests de la sesión del cronómetro del draft (app/src/lib/draftTimerSession.ts): serialización, restauración, fallback desde logs y botón.
// node app/scripts/draft-timer-session.test.mjs
import {
  TIMER_SESSION_MAX_AGE_MS,
  serializeTimerSession,
  parseTimerSession,
  snapshotTimerSession,
  restoreTimerSession,
  fallbackFromLogs,
  isPickLogged,
  shouldShowTimerButton,
} from '../src/lib/draftTimerSession.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };

const T0 = 1_700_000_000_000;
const base = { v: 1, pickIdx: 3, phase: 'counting', paused: false, secondsLeft: 40, savedAt: T0, roundStartAt: T0 - 20_000, unloggedPick: 2 };
const LEN = 40;

// --- serialización -----------------------------------------------------------------------------------------------------------------------
ok(JSON.stringify(parseTimerSession(serializeTimerSession(base))) === JSON.stringify(base), 'ida y vuelta: serializar y parsear devuelve la misma sesión');
const nulls = { ...base, roundStartAt: null, unloggedPick: null };
ok(JSON.stringify(parseTimerSession(serializeTimerSession(nulls))) === JSON.stringify(nulls), 'ida y vuelta con roundStartAt y unloggedPick en null');
for (const [name, raw] of [
  ['null', null], ['undefined', undefined], ['vacío', ''], ['JSON roto', '{no'], ['no es objeto', '42'], ['null JSON', 'null'],
  ['otra versión', JSON.stringify({ ...base, v: 2 })], ['sin versión', JSON.stringify({ ...base, v: undefined })],
  ['pickIdx negativo', JSON.stringify({ ...base, pickIdx: -1 })], ['pickIdx decimal', JSON.stringify({ ...base, pickIdx: 1.5 })],
  ['phase inválida', JSON.stringify({ ...base, phase: 'done' })], ['paused no booleano', JSON.stringify({ ...base, paused: 'si' })],
  ['secondsLeft negativo', JSON.stringify({ ...base, secondsLeft: -3 })], ['secondsLeft string', JSON.stringify({ ...base, secondsLeft: '40' })],
  ['savedAt 0', JSON.stringify({ ...base, savedAt: 0 })], ['unloggedPick inválido', JSON.stringify({ ...base, unloggedPick: -2 })],
  ['roundStartAt string', JSON.stringify({ ...base, roundStartAt: 'x' })],
]) {
  let r; let threw = false;
  try { r = parseTimerSession(raw); } catch { threw = true; }
  ok(!threw && r === null, `parse descarta sin lanzar: ${name}`);
}

// --- snapshot -----------------------------------------------------------------------------------------------------------------------------
const snap = (o) => snapshotTimerSession({ pickIdx: 5, phase: 'counting', paused: false, secondsLeft: 99, endsAt: T0 + 12_300, roundStartAt: T0 - 5_000, unloggedPick: 4, now: T0, ...o });
ok(snap({}).secondsLeft === 13, 'corriendo: los segundos salen del fin absoluto (redondeo hacia arriba), no del estado');
ok(snap({ endsAt: T0 - 500 }).secondsLeft === 0, 'corriendo y ya vencido: 0, nunca negativo');
ok(snap({ paused: true }).secondsLeft === 99 && snap({ paused: true }).paused === true, 'pausada: guarda los segundos congelados y paused');
ok(snap({ phase: 'waiting', paused: true, endsAt: null }).paused === false && snap({ phase: 'waiting', endsAt: null }).secondsLeft === 99, 'esperando: nunca queda pausada y guarda los segundos completos');
ok(snap({}).roundStartAt === T0 - 5_000 && snap({}).unloggedPick === 4, 'guarda roundStartAt y unloggedPick');
ok(parseTimerSession(serializeTimerSession(snap({}))) !== null, 'un snapshot siempre es una sesión válida');

// --- restauración --------------------------------------------------------------------------------------------------------------------------
const rs = (s, dtMs, len = LEN) => restoreTimerSession(s, len, s.savedAt + dtMs);
ok(restoreTimerSession(null, LEN, T0) === null, 'sin sesión: null');
let r = rs({ ...base, phase: 'waiting', secondsLeft: 60 }, 3_600_000);
ok(r.kind === 'waiting' && r.pickIdx === 3 && r.secondsLeft === 60 && r.unloggedPick === 2, 'esperando: sigue esperando con la misma pick y sus segundos completos, pase lo que pase con el tiempo');
r = rs({ ...base, paused: true, secondsLeft: 22 }, 5_400_000);
ok(r.kind === 'paused' && r.secondsLeft === 22 && r.pickIdx === 3, 'pausada: sigue pausada con los mismos segundos aunque pase hora y media (la pausa no consume tiempo)');
r = rs({ ...base }, 10_000);
ok(r.kind === 'running' && r.secondsLeft === 30 && r.endsAt === T0 + 40_000, 'corriendo, volvió a los 10 s: sigue corriendo con 30 s y el mismo fin absoluto');
r = rs({ ...base }, 10_400);
ok(r.kind === 'running' && r.secondsLeft === 30, 'corriendo: el redondeo es hacia arriba (29,6 s -> 30)');
r = rs({ ...base }, 39_999);
ok(r.kind === 'running' && r.secondsLeft === 1, 'corriendo, a 1 ms del fin: 1 s (nunca 0 en estado "running")');
r = rs({ ...base }, 40_000);
ok(r.kind === 'expired_next' && r.pickIdx === 4 && r.expiredPick === 3 && r.roundStartAt === T0 - 20_000, 'venció justo: pasa a la siguiente pick, la vencida queda pendiente de log (roundStartAt conservado)');
r = rs({ ...base }, 2 * 3_600_000);
ok(r.kind === 'expired_next' && r.pickIdx === 4, 'si estuvo horas fuera, vence UNA sola pick (la siguiente espera el "Iniciar"; no se saltean picks)');
r = rs({ ...base, pickIdx: LEN - 1 }, 60_000);
ok(r.kind === 'expired_done' && r.expiredPick === LEN - 1 && r.elapsedSec === 60, 'venció la última pick: el cronómetro terminó y la duración real va hasta el instante de fin (60 s), no hasta ahora');
r = rs({ ...base, pickIdx: LEN - 1, roundStartAt: null }, 60_000);
ok(r.kind === 'expired_done' && r.elapsedSec === 0, 'última pick sin roundStartAt: duración 0');
ok(rs({ ...base, pickIdx: LEN }, 1000) === null && rs({ ...base, pickIdx: 99 }, 1000) === null, 'una pick fuera de la línea de tiempo actual: se descarta');
ok(rs({ ...base }, TIMER_SESSION_MAX_AGE_MS + 1) === null, 'una sesión de más de 24 h se descarta');
ok(rs({ ...base, paused: true }, TIMER_SESSION_MAX_AGE_MS + 1) === null && rs({ ...base, phase: 'waiting' }, TIMER_SESSION_MAX_AGE_MS + 1) === null, 'también pausada o esperando');
ok(restoreTimerSession(base, 0, T0) === null, 'línea de tiempo vacía: se descarta');
ok(restoreTimerSession(base, LEN, T0 - 5000)?.kind === 'running', 'reloj del celular atrasado (ahora < savedAt): no rompe, sigue corriendo');
// cadena: guardar -> serializar -> parsear -> restaurar
const chain = restoreTimerSession(parseTimerSession(serializeTimerSession(snap({}))), LEN, T0 + 5_000);
ok(chain.kind === 'running' && chain.pickIdx === 5 && chain.secondsLeft === 8 && chain.unloggedPick === 4, 'cadena completa guardar -> JSON -> restaurar conserva pick, tiempo y log pendiente');

// --- fallback desde logs ----------------------------------------------------------------------------------------------------------------------------
ok(fallbackFromLogs([], LEN) === null && fallbackFromLogs([0, -1, 1.5, NaN], LEN) === null, 'sin logs válidos: null (arranca de cero)');
ok(fallbackFromLogs(Array.from({ length: 39 }, (_, i) => i + 1), LEN).pickIdx === 39, 'con 39 logs (el caso real): retoma en la pick 40 (índice 39)');
ok(fallbackFromLogs([1, 2, 3, 4, 5], LEN).pickIdx === 5, 'último log global_pick 5: retoma en la pick siguiente (índice 5, la 6ª)');
ok(fallbackFromLogs([5, 1, 3], LEN).pickIdx === 5, 'sin importar el orden de los logs');
ok(fallbackFromLogs(Array.from({ length: 40 }, (_, i) => i + 1), LEN).pickIdx === 39, 'todo logueado: se queda en la última pick (no termina el draft solo)');
ok(fallbackFromLogs([60], LEN).pickIdx === 39, 'un log fuera de rango se acota a la última pick');
ok(fallbackFromLogs([3], 0) === null, 'línea de tiempo vacía: null');
// no duplicar logs
const logged = new Set([1, 2, 3, 4, 5]);
ok(isPickLogged(logged, 4) && !isPickLogged(logged, 5) && isPickLogged(logged, 0), 'isPickLogged: índice 0-based contra global_pick 1-based');
// el fallback queda a lo sumo una atrás: la pick que ya estaba jugada sin log se vuelve a mostrar y su log se escribe UNA vez
const fb = fallbackFromLogs([...logged], LEN);
ok(fb.pickIdx === 5 && !isPickLogged(logged, fb.pickIdx), 'tras el fallback, la pick de retoma todavía no tiene log (se escribirá una sola vez)');
logged.add(fb.pickIdx + 1);
ok(isPickLogged(logged, fb.pickIdx), 'una vez logueada, un segundo intento no la duplica');

// --- botón "Rondas cronometradas" ----------------------------------------------------------------------------------------------------------------------
const btn = (o) => shouldShowTimerButton({ canManageEvent: true, isTimedDraft: true, draftStartedAt: '2026-11-15T20:00:00Z', draftEndedAt: null, status: 'drafting', ...o });
ok(btn({}), 'organizador/posta, draft cronometrado en curso: se muestra (sin depender de una sesión local)');
ok(!btn({ canManageEvent: false }), 'un participante común o miembro sin la posta: NO se muestra');
ok(!btn({ isTimedDraft: false }) && !btn({ isTimedDraft: null }) && !btn({ isTimedDraft: undefined }), 'draft no cronometrado: no se muestra');
ok(!btn({ draftStartedAt: null }) && !btn({ draftStartedAt: undefined }) && !btn({ draftStartedAt: '' }), 'draft sin arrancar: no se muestra');
ok(!btn({ draftEndedAt: '2026-11-15T22:00:00Z' }), 'draft ya finalizado (draft_ended_at): se oculta');
ok(!btn({ status: 'cancelled' }), 'evento cancelado: se oculta');
for (const st of ['scheduled', 'drafting', 'playing', null]) ok(btn({ status: st }), `con status ${String(st)} (y sin draft_ended_at) la condición es la del pedido`);

console.log(fails ? `\n${fails} FALLAS` : '\nTodo OK');
process.exit(fails ? 1 : 0);

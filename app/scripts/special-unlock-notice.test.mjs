// Tests de la condición del aviso del desbloqueo especial de la partida 420 (app/src/lib/specialUnlockNoticeCondition.ts).
// node app/scripts/special-unlock-notice.test.mjs
import {
  SPECIAL_UNLOCK_WINNER_TITLE,
  SPECIAL_UNLOCK_WINNER_MESSAGE,
  SPECIAL_UNLOCK_MESSAGE_GAP,
  SPECIAL_UNLOCK_LOSER_TITLE,
  SPECIAL_UNLOCK_LOSER_MESSAGE,
  specialUnlockNoticeParts,
  WORKSPACE_NOTICE_ORDER,
  parseSpecialUnlockNotice,
  shouldShowSpecialUnlockNotice,
  specialUnlockNoticeText,
  runNoticesInOrder,
} from '../src/lib/specialUnlockNoticeCondition.ts';
import { GEN3_NOTICE_TEXT } from '../src/lib/gen3NoticeCondition.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const row = (role, extra = {}) => ({ role, season_id: 's1', workspace_id: 'w1', match_id: 'm1', ...extra });
const show = (data, shownThisSession = false) => shouldShowSpecialUnlockNotice({ notice: parseSpecialUnlockNotice(data), shownThisSession });

// --- qué devuelve la RPC (returns table: arreglo con 0 o 1 fila) ----------------------------------------------------------
ok(show([row('winner')]) === true, 'hay aviso (ganador): se muestra');
ok(show([row('loser')]) === true, 'hay aviso (perdedor): se muestra');
ok(show([]) === false, 'sin aviso (arreglo vacío): no se muestra');
ok(show(null) === false && show(undefined) === false, 'sin datos (null/undefined): no se muestra');
ok(show(row('winner')) === true, 'una fila suelta (no arreglo) también se entiende');
ok(show([row('winner')], true) === false && show([row('loser')], true) === false, 'ya mostrado en esta sesión: no se vuelve a mostrar (doble foco, re-render, falla del "visto")');
ok(show([row('admin')]) === false && show([{ season_id: 's' }]) === false && show(['x']) === false && show(42) === false, 'rol desconocido o fila rara: no se muestra nada');
ok(show([row('winner'), row('loser')]) === true && parseSpecialUnlockNotice([row('winner'), row('loser')]).role === 'winner', 'si llegaran dos filas se toma la primera (la base devuelve a lo sumo una)');

// --- parseo: forma exacta de la fila ---------------------------------------------------------------------------------------
const n = parseSpecialUnlockNotice([row('loser', { match_id: null })]);
ok(n.role === 'loser' && n.season_id === 's1' && n.workspace_id === 'w1' && n.match_id === null, 'parseo: role, season_id, workspace_id y match_id (null permitido: la base lo anula si se borra la partida)');
ok(Object.keys(n).sort().join(',') === 'match_id,role,season_id,workspace_id', 'parseo: solo los cuatro campos de la RPC');

// --- textos --------------------------------------------------------------------------------------------------------------------
ok(specialUnlockNoticeText('winner') === SPECIAL_UNLOCK_WINNER_TITLE, 'rol ganador: el título es el del ganador');
ok(specialUnlockNoticeText('loser') === SPECIAL_UNLOCK_LOSER_TITLE, 'rol perdedor: el título es el del perdedor');
ok(specialUnlockNoticeText('otro') === null && specialUnlockNoticeText(null) === null && specialUnlockNoticeText(undefined) === null, 'texto: rol desconocido -> null');
ok(SPECIAL_UNLOCK_WINNER_TITLE === '¡Felicitaciones!\nGanaste la partida 420° de esta temporada', 'título exacto del ganador: dos líneas (negrita) separadas por un salto de línea');
ok(SPECIAL_UNLOCK_WINNER_TITLE.split('\n').length === 2 && SPECIAL_UNLOCK_WINNER_TITLE.split('\n')[0] === '¡Felicitaciones!', 'el título tiene exactamente 2 líneas y la 1.ª es "¡Felicitaciones!"');
ok(SPECIAL_UNLOCK_WINNER_MESSAGE === 'Te espera una sorpresa el próximo draft al que te inscribas 🚬', 'mensaje exacto del ganador (emoji al final, después de "inscribas")');
ok(SPECIAL_UNLOCK_MESSAGE_GAP === '\n\n', 'separación entre título y mensaje: dos renglones vacíos');
ok(!SPECIAL_UNLOCK_WINNER_TITLE.includes('.') && !SPECIAL_UNLOCK_WINNER_MESSAGE.includes('.'), 'el cartel del ganador no tiene ningún punto');
ok(!/[,;:?]/.test(SPECIAL_UNLOCK_WINNER_TITLE + SPECIAL_UNLOCK_WINNER_MESSAGE) && (SPECIAL_UNLOCK_WINNER_TITLE + SPECIAL_UNLOCK_WINNER_MESSAGE).match(/[!¡]/g).length === 2, 'solo hay puntuación en "¡Felicitaciones!" (¡ y !)');
ok(specialUnlockNoticeParts('winner').message === SPECIAL_UNLOCK_WINNER_MESSAGE && specialUnlockNoticeParts('loser').message === SPECIAL_UNLOCK_LOSER_MESSAGE && specialUnlockNoticeParts('x') === null, 'partes por rol: ganador y perdedor llevan título y mensaje, rol inválido -> null');
ok(SPECIAL_UNLOCK_LOSER_TITLE === 'Perdiste el partido 420° de temporada', 'título exacto del perdedor (negrita)');
ok(SPECIAL_UNLOCK_LOSER_MESSAGE === '¡Mejor suerte la próxima!', 'mensaje exacto del perdedor (texto normal)');
ok(!SPECIAL_UNLOCK_LOSER_TITLE.includes('.') && !SPECIAL_UNLOCK_LOSER_MESSAGE.includes('.'), 'el cartel del perdedor no tiene ningún punto');
ok(!/[,;:?]/.test(SPECIAL_UNLOCK_LOSER_TITLE + SPECIAL_UNLOCK_LOSER_MESSAGE) && (SPECIAL_UNLOCK_LOSER_TITLE + SPECIAL_UNLOCK_LOSER_MESSAGE).match(/[!¡]/g).length === 2, 'solo hay puntuación en "¡Mejor suerte la próxima!" (¡ y !)');
ok(SPECIAL_UNLOCK_LOSER_TITLE.split('\n').length === 1, 'el título del perdedor es una sola línea');
ok(SPECIAL_UNLOCK_WINNER_TITLE !== SPECIAL_UNLOCK_LOSER_TITLE && SPECIAL_UNLOCK_WINNER_TITLE !== GEN3_NOTICE_TEXT, 'los textos son distintos entre sí y del de la Gen 3');

// --- secuencia con el cartel de la Gen 3: de a uno y en orden ---------------------------------------------------------------
ok(WORKSPACE_NOTICE_ORDER.join(',') === 'gen3,special', 'orden: primero la Gen 3 y después el desbloqueo especial');
{
  const log = [];
  let running = 0;
  let maxRunning = 0;
  const mk = (name, ms) => async () => {
    running += 1; maxRunning = Math.max(maxRunning, running);
    log.push(`${name}:inicio`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`${name}:fin`);
    running -= 1;
    return true;
  };
  // El de la Gen 3 tarda más que el especial: igual termina primero (no se pisan).
  await runNoticesInOrder({ gen3: mk('gen3', 30), special: mk('special', 1) });
  ok(log.join(' ') === 'gen3:inicio gen3:fin special:inicio special:fin', 'secuencia: el de la Gen 3 termina antes de que empiece el especial');
  ok(maxRunning === 1, 'secuencia: nunca hay dos chequeos a la vez');
}
{
  const log = [];
  await runNoticesInOrder({
    gen3: async () => { log.push('gen3'); throw new Error('falló'); },
    special: async () => { log.push('special'); },
  });
  ok(log.join(',') === 'gen3,special', 'secuencia: si falla el chequeo de la Gen 3 igual se chequea el especial');
}
{
  // Solo corresponde el especial (la Gen 3 no tiene aviso): se muestra sin esperar nada.
  const shown = [];
  await runNoticesInOrder({
    gen3: async () => false,
    special: async () => { shown.push('special'); return true; },
  });
  ok(shown.join(',') === 'special', 'secuencia: sin aviso de la Gen 3, el especial se muestra igual');
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

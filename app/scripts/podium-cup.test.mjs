// Tests del podio parcial de las copas (app/src/lib/podium.ts). node app/scripts/podium-cup.test.mjs
// Opcional: PODIUM_HEAD=<ruta a la versión anterior de podium.ts> para el diferencial contra esa versión.
import { pathToFileURL } from 'node:url';
import { computePodium } from '../src/lib/podium.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };

const mk = (i) => ({ participantId: 'p' + i, userId: 'u' + i, name: 'J' + i, avatarUserId: 'u' + i, bo3Won: 0, bo3Completed: 0, bo3WinRate: 0, matchesWon: 0, matchesCompleted: 0, matchWinRate: 0 });
const players = [1, 2, 3, 4, 5, 6].map(mk);
const group = (champ) => ({ id: 'g', group_type: 'bracket', round_number: 1, champion_user_id: champ, group_origin: 'knockout_bracket', participants: [1, 2, 3, 4].map((i) => ({ participant_id: 'p' + i, user_id: 'u' + i, seed: i })) });
const bm = (phase, a, b, w) => ({ bracket_phase: phase, participant_a_id: 'p' + a, participant_b_id: 'p' + b, winner_participant_id: w ? 'p' + w : null });
const run = (fmt, champ, bms, status = 'playing') =>
  computePodium(players, [], 6, null, group(champ), [], 'tiebreak', null, null, bms, fmt, null, 'bo1', status);
const ids = (s) => s.players.map((p) => p.participantId);
const shape = (ps) => ps.steps.map((s) => ids(s).join(','));

for (const fmt of ['knockout', 'zones_knockout']) {
  // (a) 3er puesto resuelto, final pendiente -> 3º en el podio; 1º y 2º vacíos; sin campeón
  const a = run(fmt, null, [bm('semi', 1, 2, 1), bm('semi', 3, 4, 3), bm('final', 1, 3, null), bm('third_place', 2, 4, 4)]);
  ok(shape(a)[0] === '' && shape(a)[1] === '' && shape(a)[2] === 'p4' && a.isFinal === false, `(a) ${fmt}: 3er puesto resuelto y final pendiente: sólo el 3º en el podio, sin campeón (${shape(a).join(' | ')})`);
  // (b) final resuelta (la base ya coronó al grupo), 3er puesto pendiente -> 1º y 2º
  const b = run(fmt, 'u1', [bm('semi', 1, 2, 1), bm('semi', 3, 4, 3), bm('final', 1, 3, 1), bm('third_place', 2, 4, null)]);
  ok(shape(b)[0] === 'p1' && shape(b)[1] === 'p3' && shape(b)[2] === '' && b.isFinal === false, `(b) ${fmt}: final resuelta y 3er puesto pendiente: 1º y 2º, 3º vacío (${shape(b).join(' | ')})`);
  // (b2) final resuelta pero el grupo todavía sin campeón cargado: igual muestra 1º y 2º por puesto resuelto
  const b2 = run(fmt, null, [bm('final', 1, 3, 1), bm('third_place', 2, 4, null)]);
  ok(shape(b2)[0] === 'p1' && shape(b2)[1] === 'p3', `(b2) ${fmt}: final resuelta aunque el grupo no tenga campeón: igual figuran 1º y 2º`);
  // (c) ambas resueltas -> podio completo
  const c = run(fmt, 'u1', [bm('semi', 1, 2, 1), bm('semi', 3, 4, 3), bm('final', 1, 3, 1), bm('third_place', 2, 4, 4)]);
  ok(shape(c).join('|') === 'p1|p3|p4' && c.isFinal === true, `(c) ${fmt}: final y 3er puesto resueltos: podio completo e isFinal`);
  // (d) Consuelo (mismo criterio: otro grupo, mismo cómputo) con 3er puesto resuelto
  const gc = { ...group(null), group_origin: 'knockout_second_chance' };
  const d = computePodium(players, [], 6, null, gc, [], 'tiebreak', null, null, [bm('final', 1, 3, null), bm('third_place', 2, 4, 2)], fmt, null, 'bo1', 'concluded');
  ok(shape(d).join('|') === '||p2' && d.isFinal === false, `(d) ${fmt}: Consuelo con 3er puesto resuelto y final pendiente: 3º, sin campeón`);
  // nada resuelto -> vacío como hasta ahora
  const e = run(fmt, null, [bm('semi', 1, 2, null), bm('semi', 3, 4, null)]);
  ok(shape(e).join('|') === '||' && e.isFinal === false, `(e) ${fmt}: sin ningún puesto resuelto: podio vacío`);
}

// Diferencial contra la versión anterior de podium.ts: Copa sola con copa resuelta completa y otros formatos no cambian.
if (process.env.PODIUM_HEAD) {
  const old = await import(pathToFileURL(process.env.PODIUM_HEAD).href);
  const states = [
    ['knockout', 'u1', [bm('semi', 1, 2, 1), bm('semi', 3, 4, 3), bm('final', 1, 3, 1), bm('third_place', 2, 4, 4)]],
    ['knockout', 'u3', [bm('final', 1, 3, 3), bm('third_place', 2, 4, 2)]],
    ['knockout', 'u1', [bm('final', 1, 3, 1), bm('third_place', 2, 4, null)]],
    ['knockout', null, [bm('semi', 1, 2, null)]],
    ['round_robin', null, [bm('semi', 1, 2, 1), bm('final', 1, 3, 1)]],
    ['round_robin', 'u1', [bm('final', 1, 3, 1), bm('third_place', 2, 4, 4)]],
    ['swiss', null, [bm('third_place', 2, 4, 4)]],
    ['swiss', 'u2', [bm('final', 2, 3, 2), bm('third_place', 1, 4, 4)]],
  ];
  let same = 0;
  for (const [fmt, champ, bms] of states) {
    const g = group(champ);
    const args = (fn) => fn(players, [], 6, null, g, [], 'tiebreak', null, null, bms, fmt, fmt === 'round_robin' ? 4 : null, 'bo1', 'playing');
    if (JSON.stringify(args(computePodium)) === JSON.stringify(args(old.computePodium))) same += 1;
  }
  ok(same === states.length, `diferencial: ${same}/${states.length} estados (Copa sola completa, otros formatos) idénticos a la versión anterior`);
  // y lo único que cambia: Copa con campeón vacío y algún puesto resuelto
  const g0 = group(null);
  const bms = [bm('final', 1, 3, null), bm('third_place', 2, 4, 4)];
  const before = old.computePodium(players, [], 6, null, g0, [], 'tiebreak', null, null, bms, 'knockout', null, 'bo1', 'playing');
  ok(shape(before).join('|') === '||', 'diferencial: antes, con la final sin resolver, el podio de la copa quedaba vacío aunque el 3er puesto estuviera resuelto');
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLAS`);
process.exit(fails === 0 ? 0 : 1);

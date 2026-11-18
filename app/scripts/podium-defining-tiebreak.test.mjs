// Tests del estado "definiendo desempate" del podio de todos contra todos (app/src/lib/podium.ts, computePodium + finalPending).
// node app/scripts/podium-defining-tiebreak.test.mjs
import { computePodium, PODIUM_DEFINING_TIEBREAK_TEXT } from '../src/lib/podium.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };

const mk = (i, won, completed) => ({
  participantId: 'p' + i, userId: 'u' + i, name: 'J' + i, avatarUserId: 'u' + i,
  bo3Won: won, bo3Completed: completed, bo3WinRate: completed ? won / completed : 0,
  matchesWon: won, matchesCompleted: completed, matchWinRate: completed ? won / completed : 0,
});
// 5 jugadores, todos los enfrentamientos jugados (sin pendientes)
const tie2 = [mk(1, 3, 4), mk(2, 3, 4), mk(3, 2, 4), mk(4, 1, 4), mk(5, 1, 4)];
const tie3 = [mk(1, 3, 4), mk(2, 3, 4), mk(3, 3, 4), mk(4, 1, 4), mk(5, 0, 4)];
const noTie = [mk(1, 4, 4), mk(2, 3, 4), mk(3, 2, 4), mk(4, 1, 4), mk(5, 0, 4)];
const firstIds = (ps) => ps.steps[0].players.map((p) => p.participantId).sort().join(',');
const empty = (ps) => ps.steps.every((s) => s.players.length === 0);

// computePodium(players, remaining, total, champion, group, tbMatches, decidedBy, polemica, recog, bracket, format, topSize, matchFormat, status, finalPending)
const run = (players, o = {}) =>
  computePodium(players, [], players.length, o.champion ?? null, o.group ?? null, o.tbMatches ?? [], o.decidedBy ?? null, null, null, o.bracket ?? [],
    o.format ?? 'round_robin', o.topSize ?? null, o.matchFormat ?? 'bo3', ('status' in o ? o.status : 'playing'), o.finalPending);

// --- la ventana: empate detectado, grupo todavía sin crear ---------------------------------------------------------------------------------
const w2 = run(tie2, { finalPending: true });
ok(w2.definingTiebreak === true && empty(w2) && w2.isFinal === false, 'RR BO3, empate de 2 por el 1º, final_pending y sin grupo: podio vacío "definiendo desempate"');
const w3 = run(tie3, { finalPending: true });
ok(w3.definingTiebreak === true && empty(w3), 'empate de 3 por el 1º: lo mismo');
ok(typeof PODIUM_DEFINING_TIEBREAK_TEXT === 'string' && PODIUM_DEFINING_TIEBREAK_TEXT.length > 10 && /desempate/i.test(PODIUM_DEFINING_TIEBREAK_TEXT), 'hay un texto breve y neutro para el estado');
// sin el flag (comportamiento anterior): el podio provisorio mostraba a los empatados compartiendo el 1º = el bug
const old2 = run(tie2);
ok(firstIds(old2) === 'p1,p2' && !old2.definingTiebreak, 'sin el flag (antes): los dos empatados compartían el primer puesto (la ventana del bug)');

// --- sin empate -------------------------------------------------------------------------------------------------------------------------------
const nt = run(noTie, { finalPending: false });
ok(firstIds(nt) === 'p1' && !nt.definingTiebreak, 'sin empate (final_pending false): podio normal con un solo 1º');
const nt2 = run(noTie, { finalPending: true, champion: 'u1', decidedBy: 'winrate' });
ok(firstIds(nt2) === 'p1' && !nt2.definingTiebreak, 'con campeón ya coronado, final_pending no vacía el podio');
const nt3 = run(noTie, { finalPending: undefined });
ok(firstIds(nt3) === 'p1', 'sin pasar el flag (otros llamadores, p. ej. cierre de temporada): igual que siempre');

// --- desempate en curso y resuelto -----------------------------------------------------------------------------------------------------------
const grp = (champ) => ({
  id: 'g', group_type: 'fourth_place', round_number: 1, champion_user_id: champ, group_origin: 'round_robin_first_place',
  participants: [1, 2].map((i) => ({ participant_id: 'p' + i, user_id: 'u' + i, seed: i })),
});
const inCourse = run(tie2, { group: grp(null), finalPending: true });
ok(empty(inCourse) && !inCourse.definingTiebreak, 'con el desempate EN CURSO (hay grupo): podio vacío por el camino de siempre, no por el flag');
const bm = (phase, a, b, w) => ({ bracket_phase: phase, participant_a_id: 'p' + a, participant_b_id: 'p' + b, winner_participant_id: w ? 'p' + w : null });
const resolved = run(tie2, { group: grp(null), champion: 'u2', decidedBy: 'tiebreak', bracket: [bm('final', 1, 2, 2)], finalPending: false });
ok(firstIds(resolved) === 'p2' && !resolved.definingTiebreak, 'con el desempate RESUELTO: el campeón queda solo en el 1º');
const resolved2 = run(tie2, { group: grp(null), champion: 'u2', decidedBy: 'tiebreak', bracket: [bm('final', 1, 2, 2)], finalPending: true });
ok(firstIds(resolved2) === 'p2' && !resolved2.definingTiebreak, 'aunque final_pending siguiera en true, con grupo y campeón no se vacía');

// --- el flag solo aplica con status playing ----------------------------------------------------------------------------------------------------
for (const st of ['completed', 'concluded', 'scheduled', 'drafting', 'cancelled', null, undefined]) {
  const r = run(tie2, { finalPending: true, status: st });
  ok(!r.definingTiebreak, `status ${String(st)}: no aplica el flag`);
}
const completed = run(noTie, { finalPending: true, status: 'completed', champion: 'u1', decidedBy: 'tiebreak' });
ok(firstIds(completed) === 'p1' && !completed.definingTiebreak, 'evento ya completed: podio normal');

// --- otros formatos: no aplica ---------------------------------------------------------------------------------------------------------------------
ok(!run(tie2, { finalPending: true, format: 'swiss' }).definingTiebreak, 'suizo: no aplica');
ok(!run(tie2, { finalPending: true, format: 'knockout' }).definingTiebreak, 'copa: no aplica');
const top4 = run(tie2, { finalPending: true, topSize: 4 });
ok(!top4.definingTiebreak && empty(top4), 'todos contra todos con top 4: sigue como siempre (vacío por su propia regla, sin el flag)');

console.log(fails ? `\n${fails} FALLAS` : '\nTodo OK');
process.exit(fails ? 1 : 0);

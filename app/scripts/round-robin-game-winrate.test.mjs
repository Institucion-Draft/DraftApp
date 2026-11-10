// Tests del desempate de ciclos por winrate de partidas (app/src/lib/podium.ts, paso 3 de resolveTieGroup).
// node app/scripts/round-robin-game-winrate.test.mjs
import {
  buildGameWinrateMap,
  computeFinalStandingsWithTiebreakSplit,
  rankRoundRobinBo1Standings,
} from '../src/lib/podium.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 7 jugadores, todos contra todos BO3 (21 pairings). Ciclo de tres a 4-2: T(omás) > E(steban) > J(uan) > T.
// Cada uno del ciclo le gana a 3 de los 4 de afuera y pierde con uno (T con X1, E con X2, J con X3).
const ids = ['T', 'E', 'J', 'X1', 'X2', 'X3', 'X4'];
const winners = [
  ['T', 'E'], ['E', 'J'], ['J', 'T'],
  ['X1', 'T'], ['T', 'X2'], ['T', 'X3'], ['T', 'X4'],
  ['X2', 'E'], ['E', 'X1'], ['E', 'X3'], ['E', 'X4'],
  ['X3', 'J'], ['J', 'X1'], ['J', 'X2'], ['J', 'X4'],
  ['X1', 'X2'], ['X2', 'X3'], ['X3', 'X4'], ['X4', 'X1'], ['X1', 'X3'], ['X2', 'X4'],
];
const pairings = winners.map(([w, l], i) => ({ id: 'pr' + i, participant_a_id: w, participant_b_id: l, w }));
// Marcadores: las victorias de T son 2-0; el resto 2-1 => winrate de partidas T .714 > J .556 > E .529.
const matches = [];
for (const pr of pairings) {
  const loserGames = pr.w === 'T' ? 0 : 1;
  const l = pr.participant_b_id;
  let n = 1;
  const add = (winner) => matches.push({ pairing_id: pr.id, winner_participant_id: winner, status: 'completed', match_type: 'draft', is_walkover: false, n: n++ });
  for (let g = 0; g < loserGames; g += 1) add(l);
  add(pr.w); add(pr.w);
}

const points = new Map(ids.map((id) => [id, 0]));
for (const pr of pairings) points.set(pr.w, points.get(pr.w) + 1);
const standingInputs = ids.map((id) => ({ participantId: id, points: points.get(id) }));
const results = pairings.map((pr) => ({
  participantAId: pr.participant_a_id, participantBId: pr.participant_b_id,
  winnerParticipantId: pr.w, isDraw: false, pointsA: 1, pointsB: 0,
}));

ok(['T', 'E', 'J'].every((id) => points.get(id) === 4), 'fixture: T, E y J terminan 4-2 (ciclo T>E>J>T)');

const gwr = buildGameWinrateMap(ids, pairings, matches);
ok(Math.abs(gwr.get('T') - 10 / 14) < 1e-9 && Math.abs(gwr.get('J') - 10 / 18) < 1e-9 && Math.abs(gwr.get('E') - 9 / 17) < 1e-9,
  `winrate de partidas T=${gwr.get('T').toFixed(3)} J=${gwr.get('J').toFixed(3)} E=${gwr.get('E').toFixed(3)}`);

// Con el mapa: el ciclo se ordena por winrate de partidas (T > J > E).
const withMap = rankRoundRobinBo1Standings(standingInputs, results, gwr);
ok(eq(withMap.slice(0, 3), ['T', 'J', 'E']), `con gameWinrateMap el ciclo sale T,J,E (${withMap.join(',')})`);

// Sin el mapa (comportamiento anterior): calidad de rivales / hash, NO por winrate de partidas.
const noMap = rankRoundRobinBo1Standings(standingInputs, results);
ok(!eq(noMap.slice(0, 3), ['T', 'J', 'E']), `sin gameWinrateMap el orden del ciclo es otro (${noMap.slice(0, 3).join(',')}): el test discrimina`);

// El resto de la tabla no cambia: X1 > X2 (3 pts, h2h), X3, X4.
ok(eq(withMap.slice(3), ['X1', 'X2', 'X3', 'X4']), `resto de la tabla intacto (${withMap.slice(3).join(',')})`);

// Walkovers: no cuentan en el winrate de partidas aunque sean muchas. Se le suman a E 20 partidas ganadas por walkover.
const walkovers = Array.from({ length: 20 }, (_, i) => ({
  pairing_id: pairings.find((p) => p.w === 'E' && p.participant_b_id === 'X4').id,
  winner_participant_id: 'E', status: 'completed', match_type: 'draft', is_walkover: true, n: 100 + i,
}));
const gwrWo = buildGameWinrateMap(ids, pairings, [...matches, ...walkovers]);
ok(ids.every((id) => gwrWo.get(id) === gwr.get(id)), 'las matches walkover no cambian ningún winrate de partidas');
const withWo = rankRoundRobinBo1Standings(standingInputs, results, gwrWo);
ok(eq(withWo, withMap), 'el orden con walkovers de por medio es el mismo');
// Contraprueba: si se contaran, E pasaría al frente (el test detecta la regresión).
const gwrCounted = buildGameWinrateMap(ids, pairings, [...matches, ...walkovers.map((m) => ({ ...m, is_walkover: false }))]);
ok(gwrCounted.get('E') > gwrCounted.get('T'), 'contraprueba: contadas como partidas reales, E pasaría a T');

// Mismo orden por la vía del desempate de 1er puesto (cutoffPosition 0): grupo empatado ordenado T,J,E.
const split = computeFinalStandingsWithTiebreakSplit(standingInputs, results, 0, gwr);
ok(eq(split.cutoffTieGroup, ['T', 'J', 'E']), `desempate de 1er puesto: grupo en disputa ordenado T,J,E (${split.cutoffTieGroup.join(',')})`);

if (fails > 0) { console.log(`\n${fails} FALLA(S)`); process.exit(1); }
console.log('\nTodos los tests OK');

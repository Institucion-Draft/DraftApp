// Script de verificación manual (no hay test runner configurado en el proyecto) para el
// motor de tanda1/tanda2 de round_robin_bo1_top4 en src/lib/podium.ts.
//
// Reproduce el escenario de cuádruple empate validado en su momento: Toxic y Martín
// claramente arriba, y estebanlogrande/Iván/Karen/Manu empatados en la frontera del top4
// (4 elementos en fourthPlaceTieGroup, no 3), incluyendo el caso en que uno de los 4 cae en
// posición "3ro" (índice 2, arriba de la frontera cutoffPosition=3) resuelto por hash
// arbitrario — por eso el corte tiene que barrerlo de vuelta hacia el grupo en disputa.
//
// Corre con la firma GENERALIZADA de computeFinalStandingsWithTiebreakSplit usando SOLO los
// defaults (sin cutoffPosition explícito, sin gameWinrateMap, sin isDraw/pointsA/pointsB en
// los pairings — BO1 puro, tal cual lo arma hoy EventDetailScreen.tsx/StandingsScreen.tsx).
//
// Uso: npx tsx app/scripts/gen-fourth-place-scenario.ts

import { computeFinalStandingsWithTiebreakSplit } from '../src/lib/podium';
import type { RoundRobinStandingInput, RoundRobinPairingResult } from '../src/lib/podium';

const PLAYERS = ['toxic', 'martin', 'esteban', 'ivan', 'karen', 'manu'] as const;

// BO1 round robin de 6 jugadores, 15 pairings, diseñado para que:
// - Toxic (4-1) y Martín (3-2) queden claramente arriba (posiciones 1 y 2, sin empate).
// - esteban/ivan/karen forman un ciclo perfecto entre sí (1 victoria y 1 derrota c/u dentro
//   del trío) y los 3 le ganan a manu; manu le gana a toxic y martín (los únicos 2 upsets) y
//   pierde el resto. Los 4 terminan con 2 puntos cada uno.
// - La calidad de rivales de esteban/ivan/karen empata exactamente entre sí (los 3 solo
//   vencieron a manu fuera de su ciclo interno) → el desempate de quién de los 3 queda
//   "3ro" cae en el hash arbitrario de resolveTieGroup, lo que hace que TODO el grupo de 4
//   (no solo 3) entre en fourthPlaceTieGroup, aunque uno de ellos quede en índice 2.
const RESULTS: Array<{ a: string; b: string; winner: string }> = [
  { a: 'toxic', b: 'martin', winner: 'toxic' },
  { a: 'toxic', b: 'esteban', winner: 'toxic' },
  { a: 'toxic', b: 'ivan', winner: 'toxic' },
  { a: 'toxic', b: 'karen', winner: 'toxic' },
  { a: 'toxic', b: 'manu', winner: 'manu' },
  { a: 'martin', b: 'esteban', winner: 'martin' },
  { a: 'martin', b: 'ivan', winner: 'martin' },
  { a: 'martin', b: 'karen', winner: 'martin' },
  { a: 'martin', b: 'manu', winner: 'manu' },
  { a: 'esteban', b: 'ivan', winner: 'esteban' },
  { a: 'esteban', b: 'karen', winner: 'karen' },
  { a: 'esteban', b: 'manu', winner: 'esteban' },
  { a: 'ivan', b: 'karen', winner: 'ivan' },
  { a: 'ivan', b: 'manu', winner: 'ivan' },
  { a: 'karen', b: 'manu', winner: 'karen' },
];

function computePoints(): Record<string, number> {
  const points: Record<string, number> = Object.fromEntries(PLAYERS.map((p) => [p, 0]));
  for (const r of RESULTS) points[r.winner] += 1;
  return points;
}

function main() {
  const points = computePoints();
  console.log('Puntos por jugador:', points);

  const standingInputs: RoundRobinStandingInput[] = PLAYERS.map((p) => ({
    participantId: p,
    points: points[p]!,
    leftEventAt: null,
  }));

  // Solo winnerParticipantId, como siempre (sin isDraw/pointsA/pointsB — BO1 puro).
  const pairings: RoundRobinPairingResult[] = RESULTS.map((r) => ({
    participantAId: r.a,
    participantBId: r.b,
    winnerParticipantId: r.winner,
  }));

  const { standings, fourthPlaceTieGroup, cutoffTieGroup } = computeFinalStandingsWithTiebreakSplit(
    standingInputs,
    pairings
  );

  console.log('\nstandings:', standings);
  console.log('fourthPlaceTieGroup:', fourthPlaceTieGroup);
  console.log('cutoffTieGroup:', cutoffTieGroup);

  const expectedTop2 = standings[0] === 'toxic' && standings[1] === 'martin';
  const expectedFour = ['esteban', 'ivan', 'karen', 'manu'].sort();
  const actualFour = [...fourthPlaceTieGroup].sort();
  const fourMatches = JSON.stringify(expectedFour) === JSON.stringify(actualFour);
  const aliasMatches = JSON.stringify(fourthPlaceTieGroup) === JSON.stringify(cutoffTieGroup);

  console.log('\n=== VERIFICACIÓN ===');
  console.log('Top 2 son toxic,martin en ese orden:', expectedTop2);
  console.log('fourthPlaceTieGroup es exactamente {esteban,ivan,karen,manu}:', fourMatches);
  console.log('fourthPlaceTieGroup === cutoffTieGroup (alias):', aliasMatches);

  if (!expectedTop2 || !fourMatches || !aliasMatches) {
    console.error('\n!!! El resultado no coincide con el escenario validado !!!');
    process.exitCode = 1;
  } else {
    console.log('\nOK.');
  }
}

main();

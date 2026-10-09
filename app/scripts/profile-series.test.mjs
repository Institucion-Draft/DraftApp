// Tests del contador de enfrentamientos del perfil (app/src/lib/profileSeriesCount.ts). node app/scripts/profile-series.test.mjs
import { countProfileSeries } from '../src/lib/profileSeriesCount.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };

// Modelo de referencia de cómo la base resuelve una serie (0095): partidas -> resultado oficial. Sólo arma los datos de prueba.
function series(format, games, walkoverWinner) {
  if (walkoverWinner) return { winner: walkoverWinner, draw: false };
  const a = games.filter((g) => g === 'X').length;
  const b = games.filter((g) => g === 'Y').length;
  if (format === 'bo1') return { winner: games[0] === 'X' ? 'X' : 'Y', draw: false };
  if (format === 'bo2') return a === 2 ? { winner: 'X', draw: false } : b === 2 ? { winner: 'Y', draw: false } : { winner: null, draw: true };
  return { winner: a >= 2 ? 'X' : 'Y', draw: false }; // bo3
}
const gamesFor = (format, who) => (format === 'bo1' ? [who] : format === 'bo2' ? [who, who] : [who, 'x', who].map((g) => (g === 'x' ? (who === 'X' ? 'Y' : 'X') : g)));
const pairing = (stage, a, b, res) => ({ stage, participant_a_id: a, participant_b_id: b, official_winner_participant_id: res.winner, official_draw: res.draw });
const count = (pid, fmt, pairings, bms) => countProfileSeries({ participantId: pid, competitionFormat: fmt, pairings, bracketMatches: bms });

for (const gf of ['bo1', 'bo2', 'bo3']) {
  for (const cf of ['bo1', 'bo3']) {
    // Yo (X) gano un grupo, pierdo otro, y gano una serie de Copa; en BO2 sumo además un 1-1.
    const g = [
      pairing('zone', 'X', 'P', series(gf, gamesFor(gf, 'X'))),
      pairing('zone', 'X', 'Q', series(gf, gamesFor(gf, 'Y'))),
      pairing('interzonal', 'R', 'X', series(gf, gamesFor(gf, 'X'))),
    ];
    let expC = 3, expW = 2;
    if (gf === 'bo2') { g.push(pairing('zone', 'X', 'S', series('bo2', ['X', 'Y']))); expC += 1; }
    const cupWin = series(cf, gamesFor(cf, 'X')).winner === 'X' ? 'X' : 'Y';
    const bms = [{ participant_a_id: 'X', participant_b_id: 'T', winner_participant_id: cupWin }];
    expC += 1; expW += 1;
    const r = count('X', 'zones_knockout', g, bms);
    ok(r.completed === expC && r.won === expW, `grupos ${gf} + Copa ${cf}: ${r.won}/${r.completed} (esperado ${expW}/${expC})`);
    if (gf === 'bo2') ok(g[3].official_draw === true && g[3].official_winner_participant_id == null, '  BO2 1-1 es empate (completado, no ganado)');

    // Con walkover por abandono en cada fase: el que se queda gana (X), el que se fue pierde (Z).
    const gw = [pairing('zone', 'X', 'Z', series(gf, [], 'X')), pairing('zone', 'Z', 'W', series(gf, [], 'W'))];
    const bw = [{ participant_a_id: 'X', participant_b_id: 'Z', winner_participant_id: 'X' }];
    const rx = count('X', 'zones_knockout', gw, bw);
    const rz = count('Z', 'zones_knockout', gw, bw);
    ok(rx.completed === 2 && rx.won === 2, `  walkover ${gf}/${cf}: el que se queda -> 2 ganados de 2 completados`);
    ok(rz.completed === 3 && rz.won === 0, `  walkover ${gf}/${cf}: el que se fue -> 0 ganados de 3 completados (2 grupos + 1 cruce)`);
  }
}

// Un par que se cruza en grupos y en Copa cuenta DOS enfrentamientos, no uno.
{
  const g = [pairing('zone', 'X', 'Y', { winner: 'Y', draw: false })];
  const bms = [{ participant_a_id: 'X', participant_b_id: 'Y', winner_participant_id: 'X' }];
  const r = count('X', 'zones_knockout', g, bms);
  ok(r.completed === 2 && r.won === 1, 'par que se cruza en grupo y en Copa: 2 enfrentamientos (1 ganado de 2)');
}

// Casos reales: Joni (4 perdidos en grupos, 1 ganado y 1 perdido en Consuelo) y Karen (2 ganados en grupos + 3 en Copa).
{
  const g = ['A', 'B', 'C', 'D'].map((o) => pairing('zone', 'J', o, { winner: o, draw: false }));
  const bms = [
    { participant_a_id: 'J', participant_b_id: 'E', winner_participant_id: 'J' },
    { participant_a_id: 'J', participant_b_id: 'F', winner_participant_id: 'F' },
  ];
  const r = count('J', 'zones_knockout', g, bms);
  ok(r.won === 1 && r.completed === 6, `Joni: ${r.won} ganado de ${r.completed} completados`);
  const g2 = [
    pairing('zone', 'K', 'A', { winner: 'K', draw: false }),
    pairing('interzonal', 'B', 'K', { winner: 'K', draw: false }),
    pairing('zone', 'K', 'G', { winner: 'G', draw: false }),
    pairing('interzonal', 'H', 'K', { winner: 'H', draw: false }),
  ];
  const b2 = ['C', 'D', 'E'].map((o) => ({ participant_a_id: 'K', participant_b_id: o, winner_participant_id: 'K' }));
  const r2 = count('K', 'zones_knockout', g2, b2);
  ok(r2.won === 5 && r2.completed === 7, `Karen: ${r2.won} ganados de ${r2.completed} completados`);
}

// Venganza, pairings de llaves y byes no cuentan; cruces sin resolver tampoco.
{
  const g = [
    pairing('revenge', 'X', 'P', { winner: 'X', draw: false }),
    pairing('bracket', 'X', 'Q', { winner: 'X', draw: false }),
    pairing('zone', 'X', 'R', { winner: null, draw: false }),
  ];
  const bms = [
    { participant_a_id: 'X', participant_b_id: null, winner_participant_id: 'X' }, // bye
    { participant_a_id: 'X', participant_b_id: 'Q', winner_participant_id: null }, // sin resolver
  ];
  const r = count('X', 'zones_knockout', g, bms);
  ok(r.completed === 0 && r.won === 0, 'venganza, pairing de llaves, bye y cruce sin resolver: no cuentan');
}

// Copa sola: sólo las llaves; no cambia.
{
  const g = [pairing('zone', 'X', 'P', { winner: 'X', draw: false })];
  const bms = [{ participant_a_id: 'X', participant_b_id: 'T', winner_participant_id: 'X' }];
  const r = count('X', 'knockout', g, bms);
  ok(r.completed === 1 && r.won === 1, 'Copa sola: sólo cuenta el cuadro');
}
// Otros formatos: todos los pairings con resultado oficial (comportamiento previo).
{
  const g = [pairing(null, 'X', 'P', { winner: 'X', draw: false }), pairing(null, 'X', 'Q', { winner: null, draw: true })];
  const r = count('X', 'round_robin', g, []);
  ok(r.completed === 2 && r.won === 1, 'otros formatos: sin cambios (ganados + empates)');
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLAS`);
process.exit(fails === 0 ? 0 : 1);

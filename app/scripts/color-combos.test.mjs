// Tests de las combinaciones de colores (app/src/lib/colorCombos.ts). node app/scripts/color-combos.test.mjs
// El helper recibe filas con la forma de v_player_color_combo_stats: { combo, decks_count, games_played, games_won }.
import { pickColorCombos, comboKey, COMBO_MIN_GAMES } from '../src/lib/colorCombos.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const row = (combo, decks_count, games_played, games_won) => ({ combo, decks_count, games_played, games_won });

ok(comboKey(['B', 'W', 'U']) === 'WUB' && comboKey(['G', 'W']) === 'WG' && comboKey([]) === '', 'la clave no depende del orden');

const rows = [row('WU', 3, 3, 2), row('WUB', 1, 3, 3), row('R', 1, 1, 1), row('G', 0, 0, 0)];
const r = pickColorCombos(rows);
ok(r.mostUsed.map((c) => c.key).join() === 'WU,WUB,R', 'más usada: por mazos (WU 3), desempate por partidas jugadas (WUB 3 antes que R 1)');
const wu = r.mostUsed[0];
ok(wu.decks === 3 && wu.played === 3 && wu.won === 2 && wu.winrate === 67, 'WU: 3 mazos, 2 de 3 partidas = 67%');
ok(r.bestWinrate.map((c) => c.key).join() === 'WUB,WU', `winrate: WUB 100% antes que WU 67%; R (1 partida) no llega al mínimo de ${COMBO_MIN_GAMES}`);
ok(r.mostUsed.length === 3, 'máximo 3');

// Desempate: mismos mazos -> más partidas jugadas primero, después orden estable por combo.
const t = pickColorCombos([row('W', 1, 3, 3), row('G', 1, 4, 4), row('R', 1, 3, 3)]);
ok(t.mostUsed.map((c) => c.key).join() === 'G,R,W', 'más usada, mismos mazos: más jugados (G:4), luego orden estable (R antes que W)');
ok(t.bestWinrate.map((c) => c.key).join() === 'G,R,W', 'winrate igual (100%): más jugados primero, después orden estable');

// Los bigint de la vista pueden llegar como string.
const s = pickColorCombos([row('UB', '2', '5', '4')]);
ok(s.mostUsed[0].decks === 2 && s.mostUsed[0].played === 5 && s.mostUsed[0].winrate === 80, 'acepta números como string (bigint)');

// Letras en otro orden o filas repetidas se unifican; combos vacíos se ignoran.
const u = pickColorCombos([row('UW', 1, 2, 1), row('WU', 1, 1, 1), row('', 5, 5, 5)]);
ok(u.mostUsed.length === 1 && u.mostUsed[0].key === 'WU' && u.mostUsed[0].decks === 2 && u.mostUsed[0].played === 3, 'letras en otro orden se unifican; combo vacío se ignora');

// Menos de 3 combinaciones / ninguna.
ok(pickColorCombos([row('U', 1, 0, 0)]).mostUsed.length === 1, 'con una sola combinación muestra una');
const e = pickColorCombos([]);
ok(e.mostUsed.length === 0 && e.bestWinrate.length === 0, 'sin filas: vacío');

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLAS`);
process.exit(fails === 0 ? 0 : 1);

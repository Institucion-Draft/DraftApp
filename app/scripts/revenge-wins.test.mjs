// Tests del conteo de venganzas del marcador (app/src/lib/bracketSeries.ts). node app/scripts/revenge-wins.test.mjs
import { countRevengeWins } from '../src/lib/bracketSeries.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const mk = (w, o = {}) => ({ match_type: 'revenge', status: 'completed', winner_participant_id: w, is_walkover: false, ...o });
const score = (ms) => [countRevengeWins(ms, 'A'), countRevengeWins(ms, 'B')];
const eq = (a, b) => a[0] === b[0] && a[1] === b[1];

ok(eq(score([mk('A')]), [1, 0]), '1-0');
ok(eq(score([mk('A'), mk('A')]), [2, 0]), '2-0');
ok(eq(score([mk('A'), mk('B'), mk('A')]), [2, 1]), '2-1');
ok(eq(score([mk('A'), mk('A'), mk('A')]), [3, 0]), '3-0');
ok(eq(score([mk('A'), mk('B'), mk('A'), mk('B'), mk('A')]), [3, 2]), '3-2');
ok(eq(score([mk('A'), mk('A'), mk('B'), mk('B'), mk('B')]), [2, 3]), 'cambio de liderazgo (A adelante, B pasa)');
ok(eq(score([mk('A'), mk('B', { status: 'aborted' }), mk('B', { status: 'in_progress' })]), [1, 0]), 'abortadas e in_progress no suman');
ok(eq(score([mk('A', { is_walkover: true }), mk('B')]), [1, 1]), 'walkover completo con ganador sí suma (criterio de los triggers)');
ok(eq(score([mk('A', { match_type: 'draft' }), mk('A', { match_type: 'tiebreak' }), mk('B')]), [0, 1]), 'sólo match_type revenge');
ok(eq(score([mk(null), mk('A')]), [1, 0]), 'sin ganador no suma');
ok(countRevengeWins([mk('A', { match_type: undefined })], 'A') === 0, 'sin match_type no cuenta (a diferencia de countSeriesWins)');

if (fails) { console.log(`\n${fails} fallas`); process.exit(1); }
console.log('\nTodo OK');

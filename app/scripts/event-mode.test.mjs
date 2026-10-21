// Tests de la modalidad de un evento (app/src/lib/eventMode.ts, formatEventMode): texto de la línea "Modalidad" de la
// pantalla del evento (y de las listas). node app/scripts/event-mode.test.mjs
import { register } from 'node:module';
// eventMode.ts importa './labels' sin extensión: se resuelve a .ts sólo para este test.
register('data:text/javascript,' + encodeURIComponent("export async function resolve(s,c,n){ try { return await n(s,c); } catch(e){ if (s.startsWith('.') && !/\.\w+$/.test(s)) return n(s+'.ts',c); throw e; } }"));
globalThis.__DEV__ = false;
const { formatEventMode: mode } = await import('../src/lib/eventMode.ts');

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const eq = (args, expected) => {
  const got = mode(...args);
  ok(got === expected, `${JSON.stringify(args)} -> "${got}"${got === expected ? '' : `  (esperado "${expected}")`}`);
};

// args: eventType, competitionFormat, topSize, matchFormat, topcutFormat
// Todos contra todos
for (const [mf, label] of [['bo1', 'BO1'], ['bo2', 'BO2'], ['bo3', 'BO3']]) {
  eq(['draft', 'round_robin', null, mf, null], `Todos contra todos · ${label}`);
  eq(['draft', 'round_robin', 4, mf, null], `Todos contra todos · ${label} + Top 4`);
  eq(['draft', 'swiss', null, mf, null], `Suizo · ${label}`);
  eq(['draft', 'swiss', 4, mf, null], `Suizo · ${label} + Top 4`);
  eq(['two_headed_giant', 'round_robin', null, mf, null], `Gigante de Dos Cabezas · Todos contra todos · ${label}`);
}
// El tipo de evento común (draft, torneo, pepidraft) no aparece: sólo la modalidad.
for (const et of ['draft', 'tournament', 'pepidraft', null]) eq([et, 'round_robin', null, 'bo3', null], 'Todos contra todos · BO3');
// Sin partida o con top 4 sin formato
eq(['draft', 'round_robin', null, null, null], 'Todos contra todos');
eq(['draft', 'swiss', null, null, null], 'Suizo');
eq(['draft', 'round_robin', 4, null, null], 'Todos contra todos · Top 4');
eq(['draft', 'round_robin', 0, 'bo1', null], 'Todos contra todos · BO1');
// Copa (sólo llaves)
eq(['draft', 'knockout', null, null, 'bo1'], 'Copa (solo mata-mata) · BO1');
eq(['draft', 'knockout', null, null, 'bo3'], 'Copa (solo mata-mata) · BO3');
eq(['draft', 'knockout', null, null, null], 'Copa (solo mata-mata)');
// Grupos + Copa
for (const mf of ['bo1', 'bo2', 'bo3']) for (const tc of ['bo1', 'bo3']) {
  eq(['draft', 'zones_knockout', null, mf, tc], `Grupos + Copa · Grupos ${mf.toUpperCase()} · Mata-mata ${tc.toUpperCase()}`);
}
eq(['draft', 'zones_knockout', null, 'bo3', null], 'Grupos + Copa · Grupos BO3');
eq(['draft', 'zones_knockout', null, null, 'bo1'], 'Grupos + Copa · Mata-mata BO1');
eq(['draft', 'zones_knockout', null, null, null], 'Grupos + Copa');

// Nulos y legados: nunca "undefined", "null" ni separadores colgados; vacío si no se puede determinar.
eq([null, null, null, null, null], '');
eq(['draft', null, null, null, null], '');
eq(['draft', undefined, undefined, undefined, undefined], '');
eq(['two_headed_giant', null, null, null, null], 'Gigante de Dos Cabezas');
eq(['draft', 'swiss_bo2', null, 'bo2', null], 'BO2');
eq(['draft', 'round_robin_bo1_top4', 4, 'bo1', null], 'BO1 + Top 4');

// Barrido de todas las combinaciones: ningún resultado contiene basura ni separadores mal puestos.
const eventTypes = ['draft', 'tournament', 'pepidraft', 'two_headed_giant', null, undefined, 'otro'];
const formats = ['round_robin', 'swiss', 'zones_knockout', 'knockout', 'swiss_bo2', 'round_robin_bo1_top4', '', null, undefined];
const matchFormats = ['bo1', 'bo2', 'bo3', null, undefined, ''];
const topSizes = [null, undefined, 0, 4, 8];
const topcuts = ['bo1', 'bo3', null, undefined, ''];
let bad = 0, n = 0;
for (const a of eventTypes) for (const b of formats) for (const c of topSizes) for (const d of matchFormats) for (const e of topcuts) {
  n += 1;
  const s = mode(a, b, c, d, e);
  const sinBasura = typeof s === 'string' && !/undefined|null|NaN/.test(s);
  const sinSeparadores = s === '' || (!s.startsWith(' ·') && !s.endsWith('·') && !s.endsWith(' ') && !s.startsWith(' ') && !s.includes(' ·  ·') && !s.includes('· ·'));
  if (!sinBasura || !sinSeparadores) { bad += 1; if (bad < 5) console.log('  mal:', JSON.stringify([a, b, c, d, e]), JSON.stringify(s)); }
}
ok(bad === 0, `barrido de ${n} combinaciones: sin "undefined"/"null"/"NaN" ni separadores colgados`);

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

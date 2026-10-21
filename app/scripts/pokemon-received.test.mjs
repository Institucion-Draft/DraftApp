// Tests de la sección "Pokemones" del perfil (app/src/lib/pokemonReceived.ts). node app/scripts/pokemon-received.test.mjs
import {
  unownFormFromPath, pokemonDisplayName, pokemonSpritePath, effectiveType,
  sortReceived, lastReceived, topTypeShare, formatTypeShare, formatEventDate, formatShortDateAR, lastRowLayout,
} from '../src/lib/pokemonReceived.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };

const row = (id, date, name, path, type, shiny = false, shinyPath = null) => ({
  id, eventId: 'e' + id, eventName: 'Evento ' + id, eventDate: date, name, storagePath: `default-avatars/${path}.png`,
  storagePathShiny: shinyPath ?? `default-avatars/shiny/${path}.png`, pokemonType: type, isShiny: shiny,
});

// Unown: forma por storage_path y nombre a mostrar.
ok(unownFormFromPath('default-avatars/unown.png') === 'a', 'unown.png = forma A');
ok(unownFormFromPath('default-avatars/shiny/unown-k.png') === 'k', 'unown-k.png = forma K (también la ruta shiny)');
ok(unownFormFromPath('default-avatars/unown-exclamation.png') === 'exclamation' && unownFormFromPath('default-avatars/unown-question.png') === 'question', 'formas ! y ?');
ok(unownFormFromPath('default-avatars/ditto.png') === null && unownFormFromPath('default-avatars/unowner.png') === null, 'no confunde otros nombres con Unown');
ok(pokemonDisplayName(row('1', null, 'Unown-K', 'unown-k', 'Psíquico')) === 'Unown (K)', 'Unown (K)');
ok(pokemonDisplayName(row('1', null, 'Unown', 'unown', 'Psíquico')) === 'Unown (A)', 'Unown original = Unown (A)');
ok(pokemonDisplayName(row('1', null, 'Unown-Exclamation', 'unown-exclamation', 'Psíquico')) === 'Unown (!)', 'Unown (!)');
ok(pokemonDisplayName(row('1', null, 'Unown-Question', 'unown-question', 'Psíquico')) === 'Unown (?)', 'Unown (?)');
ok(pokemonDisplayName(row('1', null, 'Ditto', 'ditto', 'Normal')) === 'Ditto', 'Ditto se muestra como Ditto');
ok(pokemonDisplayName(row('1', null, 'Mr-Mime', 'mr-mime', 'Psíquico')) === 'Mr-Mime', 'el resto muestra el nombre guardado');

// Sprite: shiny cuando corresponde.
{
  const n = row('1', null, 'Abra', 'abra', 'Psíquico', false);
  const s = row('2', null, 'Abra', 'abra', 'Psíquico', true);
  ok(pokemonSpritePath(n) === 'default-avatars/abra.png' && pokemonSpritePath(s) === 'default-avatars/shiny/abra.png', 'sprite normal y shiny');
  ok(pokemonSpritePath({ ...s, storagePathShiny: null }) === 'default-avatars/abra.png', 'shiny sin ruta shiny: cae al normal');
}

// Orden: más reciente primero; sin fecha al final; empate estable.
{
  const rows = [
    row('a', '2026-01-10T20:00:00Z', 'Abra', 'abra', 'Psíquico'),
    row('b', '2026-03-01T20:00:00Z', 'Eevee', 'eevee', 'Normal'),
    row('c', null, 'Mew', 'mew', 'Psíquico'),
    row('d', '2026-03-01T20:00:00Z', 'Ditto', 'ditto', 'Normal'),
  ];
  ok(sortReceived(rows).map((r) => r.id).join() === 'b,d,a,c', 'orden: más reciente primero, empate por id, sin fecha al final');
  ok(rows.map((r) => r.id).join() === 'a,b,c,d', 'no muta la lista original');
}
// Últimos 5.
{
  const rows = Array.from({ length: 8 }, (_, i) => row(String(i), `2026-0${i + 1}-01T00:00:00Z`, 'X', 'x', 'Normal'));
  ok(lastReceived(rows).map((r) => r.id).join() === '7,6,5,4,3', 'últimos 5: del más reciente al más antiguo');
  ok(lastReceived(rows.slice(0, 2)).length === 2 && lastReceived([]).length === 0, 'con menos de 5 (o ninguno) devuelve los que haya');
}
// Tipo más asignado.
{
  const rows = [
    row('1', null, 'A', 'a', 'Agua'), row('2', null, 'B', 'b', 'Agua'), row('3', null, 'C', 'c', 'Fuego'),
    row('4', null, 'D', 'd', 'Planta'), row('5', null, 'E', 'e', 'Agua'),
  ];
  const s = topTypeShare(rows);
  ok(s.types.join() === 'Agua' && s.count === 3 && s.total === 5 && s.percent === 60, 'Agua 3 de 5 = 60 %');
  ok(formatTypeShare(s).join() === 'Agua · 60 %', 'formato "Agua · 60 %"');
  const tie = topTypeShare([row('1', null, 'A', 'a', 'Fuego'), row('2', null, 'B', 'b', 'Agua'), row('3', null, 'C', 'c', 'Planta')]);
  ok(tie.types.join() === 'Agua,Fuego,Planta' && tie.percent === 33, 'empate triple: se muestran todos, ordenados, con el mismo porcentaje (33 %)');
  const tie2 = topTypeShare([row('1', null, 'A', 'a', 'Fuego'), row('2', null, 'B', 'b', 'Agua')]);
  ok(formatTypeShare(tie2).join('|') === 'Agua · 50 %|Fuego · 50 %', 'empate doble: Agua · 50 % y Fuego · 50 %');
  const unown = topTypeShare([row('1', null, 'Unown-K', 'unown-k', null), row('2', null, 'Unown', 'unown', 'Normal'), row('3', null, 'A', 'a', 'Agua')]);
  ok(unown.types.join() === 'Psíquico' && unown.count === 2 && unown.percent === 67, 'las formas de Unown cuentan como psíquico (aunque el tipo guardado falte o difiera)');
  ok(effectiveType(row('1', null, 'Unown-K', 'unown-k', 'Normal')) === 'Psíquico', 'tipo efectivo de Unown = Psíquico');
  ok(topTypeShare([]) === null && topTypeShare([row('1', null, 'A', 'a', null)]) === null, 'sin tipos conocidos: sin resultado');
  const sinTipo = topTypeShare([row('1', null, 'A', 'a', null), row('2', null, 'B', 'b', 'Agua')]);
  ok(sinTipo.total === 1 && sinTipo.percent === 100, 'las filas sin tipo no entran al total');
}
// Fecha.
ok(formatEventDate(null) === '' && formatEventDate('basura') === '' && /2026/.test(formatEventDate('2026-03-01T20:00:00Z')), 'formato de fecha (vacío si no hay o es inválida)');

// Fecha corta dd/mm/aa en hora de Argentina (UTC-3): el día no se corre por UTC.
ok(formatShortDateAR('2026-10-21T15:00:00Z') === '21/10/26', 'dd/mm/aa: 21/10/26');
ok(formatShortDateAR('2026-10-22T01:00:00Z') === '21/10/26', '01:00 UTC del 22 = 22:00 del 21 en Argentina -> 21/10/26');
ok(formatShortDateAR('2026-10-21T02:59:59Z') === '20/10/26' && formatShortDateAR('2026-10-21T03:00:00Z') === '21/10/26', 'el corte del día es 03:00 UTC');
ok(formatShortDateAR('2027-01-01T02:00:00Z') === '31/12/26', 'cruce de año: 31/12/26');
ok(formatShortDateAR('2026-03-05T12:00:00Z') === '05/03/26', 'ceros a la izquierda');
ok(formatShortDateAR(null) === '' && formatShortDateAR(undefined) === '' && formatShortDateAR('basura') === '', 'sin fecha o inválida: vacío');

// Fila de los 5 últimos: partes iguales, sin scroll, sprite escalado.
for (const [w, spr] of [[272, 48], [364, 56], [250, 44]]) {
  const l = lastRowLayout(w);
  ok(l.cell * 5 <= w && l.sprite + 0 <= l.cell && l.sprite === spr, `ancho ${w}: celda ${l.cell} x 5 <= ${w}, sprite ${l.sprite}`);
}
ok(lastRowLayout(272).sprite === 48, 'pantalla de 320 px (272 de ancho útil): sprite de 48 px');
ok(lastRowLayout(100).sprite >= 24, 'ancho extremo: piso de 24 px');

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

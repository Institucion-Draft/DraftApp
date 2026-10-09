// node app/scripts/zones-cup-highlight.test.mjs
import { consueloFits, cupHighlightOf, provisionalCupHighlights } from '../src/lib/zonesCupHighlight.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const zone = (prefix, n, complete) => ({ complete, players: Array.from({ length: n }, (_, i) => ({ participantId: prefix + (i + 1), rank: i + 1 })) });
const tags = (m, ids) => ids.map((id) => m.get(id) ?? '-').join(',');
const run = (zones, q, w) => {
  const N = zones.reduce((s, z) => s + z.players.length, 0);
  return provisionalCupHighlights({ zones, qualifiers: q, wildcards: w, playerCount: N, zonesCount: zones.length });
};

// (a) 3 zonas, una al 100% y dos incompletas: sólo se resaltan los de la zona completa
{
  const m = run([zone('A', 4, true), zone('B', 4, false), zone('C', 4, false)], 1, 0); // N=12, T=3, resto 9
  ok(tags(m, ['A1', 'A2', 'A3', 'A4']) === 'main,second,second,second', '(a) zona completa: 1º a la Copa, el resto a Consuelo (' + tags(m, ['A1', 'A2', 'A3', 'A4']) + ')');
  ok(tags(m, ['B1', 'B2', 'B3', 'B4', 'C1', 'C2', 'C3', 'C4']) === '-,-,-,-,-,-,-,-', '(a) las zonas incompletas no resaltan a nadie');
}
// (b) rank = q+1: con w > 0 no se resalta; con w = 0 va a Consuelo
{
  const z = [zone('A', 4, true), zone('B', 4, true), zone('C', 4, true)];
  const con = run(z, 1, 1); // N=12, T=4, resto 8
  ok(tags(con, ['A1', 'A2', 'A3', 'A4']) === 'main,-,second,second', '(b) w > 0: el 2º (q+1) queda sin resaltar; el resto a Consuelo (' + tags(con, ['A1', 'A2', 'A3', 'A4']) + ')');
  const sin = run(z, 2, 0); // N=12, T=6, resto 6
  ok(tags(sin, ['A1', 'A2', 'A3', 'A4']) === 'main,main,second,second', '(b) w = 0: el 3º (q+1) va a Consuelo (' + tags(sin, ['A1', 'A2', 'A3', 'A4']) + ')');
}
// (c) Consuelo no se arma (N - T < 4): sin resalte de Consuelo; la Copa sí se resalta
{
  const m = run([zone('A', 5, true), zone('B', 5, true)], 4, 0); // N=10, T=8, resto 2
  ok(consueloFits(10, 8) === false && tags(m, ['A1', 'A4', 'A5', 'B5']) === 'main,main,-,-', '(c) N-T < 4: los de afuera no se resaltan (' + tags(m, ['A1', 'A4', 'A5', 'B5']) + ')');
  ok(consueloFits(30, 8) === false && consueloFits(24, 8) === true && consueloFits(12, 8) === true && consueloFits(11, 8) === false, '(c) Consuelo sólo con N - T entre 4 y 16');
}
// (d) zonas desiguales 4-5-4
{
  const m = run([zone('A', 4, true), zone('B', 5, true), zone('C', 4, false)], 2, 1); // N=13, T=7, resto 6
  ok(tags(m, ['A1', 'A2', 'A3', 'A4']) === 'main,main,-,second', '(d) zona de 4 completa: 1º-2º Copa, 3º (q+1 con wildcard) sin resaltar, 4º Consuelo');
  ok(tags(m, ['B1', 'B2', 'B3', 'B4', 'B5']) === 'main,main,-,second,second', '(d) zona de 5 completa: 4º y 5º a Consuelo');
  ok(tags(m, ['C1', 'C2', 'C3', 'C4']) === '-,-,-,-', '(d) la zona de 4 incompleta no resalta');
}
// (e) copas ya armadas: la función no interviene (manda la membresía de los grupos de llaves); se verifica el contrato en el uso
{
  const armed = { main: new Set(['A1']), second: new Set(['A4']) };
  const pick = (cups, prov, id) => cupHighlightOf(cups, prov, id);
  const prov = run([zone('A', 4, true)], 2, 0);
  ok(pick(armed, prov, 'A1') === 'main' && pick(armed, prov, 'A2') === null && pick(armed, prov, 'A4') === 'second' && pick(null, prov, 'A2') === 'main',
    '(e) con copas armadas manda la membresía (A2 sin resaltar aunque el provisorio dijera Copa); sin armar, el provisorio');
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLAS`);
process.exit(fails === 0 ? 0 : 1);

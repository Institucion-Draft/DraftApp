// Tests del planificador de zonas (app/src/lib/zonesPlanner.ts). Sin framework: node app/scripts/zones-planner.test.mjs
import {
  buildZoneOption,
  consueloSizeFor,
  consueloWillBeCreated,
  copaSizeRank,
  enumerateZoneOptions,
  isEvenGroupPhase,
  recommendZoneOptions,
  zoneLayout,
} from '../src/lib/zonesPlanner.ts';
import { INTERZONAL_LABEL, buildZonesOfficialRows, pairingGroupLabel, shortGroupLabel, zonePhaseCompleteness, zonesGroupOrder } from '../src/lib/zonesPairingsList.ts';
import { ordinalMasculine, zoneConsueloTotalText, zoneFormatLine, zoneQualifiersToCupText, zoneConsueloText, zoneCopaText, zoneInterzonalText, zoneMatchesText, zoneOptionLines, zoneOptionText, zoneQualifiersText, zonesSchemaLayout, zonesSchemaModel } from '../src/lib/zonesPlannerText.ts';

let fails = 0;
const ok = (c, m) => {
  if (!c) fails += 1;
  console.log((c ? 'OK   ' : 'FAIL ') + m);
};

/** "Pareja" = todos con los mismos partidos y dentro de 3..7. */
const isPareja = (o) => isEvenGroupPhase(o) && o.matchesMin >= 3 && o.matchesMax <= 7;
const anyQW = (n, k, iz) => {
  const lay = zoneLayout(n, k);
  const min = Math.min(...lay.sizes);
  for (let q = 1; q <= min; q += 1) for (let w = 0; w < k; w += 1) {
    const o = buildZoneOption(n, k, q, w, iz);
    if (o.blockers.length === 0) return o;
  }
  return null;
};
/** Matches por jugador (min/max) de una configuración de zonas, independiente de q y w. */
const phase = (n, k, iz) => {
  const lay = zoneLayout(n, k);
  const per = lay.sizes.map((sz, i) => sz - 1 + (iz && (lay.bigZones === 0 || i >= lay.bigZones) ? 1 : 0));
  return { min: Math.min(...per), max: Math.max(...per), lay };
};

// ---------------------------------------------------------------------------------------------------
// Tabla de referencia
// ---------------------------------------------------------------------------------------------------
{
  const a = phase(8, 2, false);
  const b = phase(8, 2, true);
  ok(a.lay.sizes.join('-') === '4-4' && a.lay.mode === 'optional' && a.min === 3 && a.max === 3 && b.min === 4 && b.max === 4,
    'N=8, 2 zonas 4-4: interzonal opcional; 3 partidos (4 con interzonal)');
  const c = phase(10, 3, true);
  ok(c.lay.sizes.join('-') === '4-3-3' && c.lay.mode === 'mandatory' && c.min === 3 && c.max === 3,
    'N=10, 3 zonas 4-3-3: interzonal obligatorio, 3 partidos para todos');
  const d = phase(13, 3, true);
  ok(d.lay.sizes.join('-') === '5-4-4' && d.lay.mode === 'mandatory' && d.min === 4 && d.max === 4,
    'N=13, 3 zonas 5-4-4: interzonal obligatorio, 4 partidos para todos');
  const e = phase(15, 3, false);
  ok(e.lay.sizes.join('-') === '5-5-5' && e.lay.mode === 'impossible' && e.min === 4 && e.max === 4,
    'N=15, 3 zonas de 5: interzonal imposible (N impar), 4 partidos');
  const f = phase(22, 3, true);
  ok(f.lay.sizes.join('-') === '8-7-7' && f.lay.mode === 'mandatory' && f.min === 7 && f.max === 7,
    'N=22, 3 zonas 8-7-7: interzonal obligatorio, 7 partidos');
  for (const n of [9, 11, 23]) {
    const pareja = enumerateZoneOptions({ playerCount: n }).filter(isPareja);
    ok(pareja.length === 0, `N=${n}: ninguna opción de fase de grupos pareja (3..7 partidos iguales para todos)`);
    const rec = recommendZoneOptions({ playerCount: n });
    ok(rec.length > 0 && rec.every((o) => o.warnings.length > 0), `N=${n}: se devuelven las mejores disponibles, todas con advertencia (${rec.length})`);
  }
  for (const n of [8, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24]) {
    const pareja = enumerateZoneOptions({ playerCount: n }).filter(isPareja);
    ok(pareja.length > 0, `N=${n}: existe al menos una fase de grupos pareja`);
  }
}

// ---------------------------------------------------------------------------------------------------
// Invariantes N = 8..24, k = 2..4
// ---------------------------------------------------------------------------------------------------
{
  let bad = 0;
  const why = [];
  for (let n = 8; n <= 24; n += 1) {
    for (let k = 2; k <= 4; k += 1) {
      const lay = zoneLayout(n, k);
      const sum = lay.sizes.reduce((x, y) => x + y, 0);
      if (sum !== n || Math.max(...lay.sizes) - Math.min(...lay.sizes) > 1) { bad += 1; why.push(`reparto N=${n} k=${k}`); }
      // modo de interzonal
      const r = n % k;
      const s = Math.floor(n / k);
      const expectMode = r === 0 ? (n % 2 === 0 ? 'optional' : 'impossible') : (k - r >= 2 && ((k - r) * s) % 2 === 0 ? 'mandatory' : 'impossible');
      if (lay.mode !== expectMode) { bad += 1; why.push(`modo N=${n} k=${k}`); }
      const min = Math.min(...lay.sizes);
      // pedir interzonal imposible -> bloqueo; pedir false obligatorio -> se fuerza
      const reqTrue = buildZoneOption(n, k, 1, 0, true);
      if (lay.mode === 'impossible' && !reqTrue.blockers.some((b) => /imposible/i.test(b))) { bad += 1; why.push(`bloqueo interzonal N=${n} k=${k}`); }
      const reqFalse = buildZoneOption(n, k, 1, 0, false);
      if (lay.mode === 'mandatory' && !reqFalse.interzonal) { bad += 1; why.push(`forzado N=${n} k=${k}`); }
      // bloqueos de q
      if (!buildZoneOption(n, k, min + 1, 0, false).blockers.some((b) => /zona más chica/.test(b))) { bad += 1; why.push(`q>min N=${n} k=${k}`); }
      for (let q = 1; q <= min; q += 1) {
        for (let w = 0; w < k; w += 1) {
          const o = buildZoneOption(n, k, q, w, lay.mode === 'mandatory');
          const t = k * q + w;
          if (o.copaSize !== t || o.consueloSize !== Math.min(Math.max(n - t, 0), 16)) { bad += 1; why.push(`T N=${n}`); }
          const tBlocked = o.blockers.some((b) => /entre 4 y 16/.test(b));
          if (tBlocked !== (t < 4 || t > 16)) { bad += 1; why.push(`bloqueo T N=${n} k=${k} q=${q} w=${w}`); }
          if (o.warnings.some((x) => /Consuelo tendría menos/.test(x)) !== (n - t < 4) || o.warnings.some((x) => /admite 16/.test(x)) !== (n - t > 16)) { bad += 1; why.push(`aviso consuelo N=${n}`); }
          if (o.warnings.some((x) => /2\/3/.test(x)) !== (t * 3 > 2 * n)) { bad += 1; why.push(`aviso 2/3 N=${n}`); }
          // partidos
          const ph = phase(n, k, o.interzonal);
          if (o.matchesMin !== ph.min || o.matchesMax !== ph.max) { bad += 1; why.push(`partidos N=${n} k=${k}`); }
        }
      }
    }
  }
  ok(bad === 0, 'invariantes N=8..24 x k=2..4 (reparto, modo de interzonal, forzado/bloqueo, q, T, Consuelo, 2/3, partidos)' + (bad ? ' ' + why.slice(0, 5).join(', ') : ''));
}

// ---------------------------------------------------------------------------------------------------
// Recomendadas
// ---------------------------------------------------------------------------------------------------
{
  let bad = 0;
  const why = [];
  const rows = [];
  for (let n = 6; n <= 24; n += 1) {
    const rec = recommendZoneOptions({ playerCount: n });
    if (n < 8 && rec.length !== 0) { bad += 1; why.push(`N=${n} no debería tener recomendadas`); }
    if (n >= 8 && (rec.length < 1 || rec.length > 3)) { bad += 1; why.push(`N=${n} cantidad ${rec.length}`); }
    const keys = new Set(rec.map((o) => `${o.zonesCount}|${o.interzonal}|${o.qualifiers}|${o.wildcards}`));
    if (keys.size !== rec.length) { bad += 1; why.push(`N=${n} repetidas`); }
    if (rec.some((o) => o.blockers.length > 0)) { bad += 1; why.push(`N=${n} con bloqueos`); }
    const hasPareja = enumerateZoneOptions({ playerCount: n }).some(isPareja);
    if (n >= 8 && hasPareja && !rec[0] ) { bad += 1; why.push(`N=${n} sin primera`); }
    if (n >= 8 && hasPareja && !rec.every(isPareja)) { bad += 1; why.push(`N=${n} hay pareja pero recomienda no pareja`); }
    // el tope 2N/3 se respeta cuando se puede
    const cap = Math.floor((2 * n) / 3);
    for (const o of rec) {
      const cfgHasCapped = enumerateZoneOptions({ playerCount: n }).some((x) => x.zonesCount === o.zonesCount && x.interzonal === o.interzonal && x.copaSize <= cap);
      if (cfgHasCapped && o.copaSize > cap) { bad += 1; why.push(`N=${n} supera el tope 2N/3`); }
    }
    for (const o of rec) {
      rows.push({ N: n, zonas: o.zonesCount, tamaños: o.zoneSizes.join('-'), IZ: o.interzonal ? 'sí' : 'no', q: o.qualifiers, w: o.wildcards, 'partidos': o.matchesMin === o.matchesMax ? o.matchesMin : `${o.matchesMin}-${o.matchesMax}`, T: o.copaSize, Consuelo: o.consueloSize, 'rank T': copaSizeRank(o.copaSize), avisos: o.warnings.length });
    }
  }
  ok(bad === 0, 'recomendadas N=6..24: hasta 3, distintas, sin bloqueos, parejas cuando existen, tope 2N/3, vacías para N < 8' + (bad ? ' ' + why.slice(0, 5).join(', ') : ''));
  if (process.env.VERBOSE) console.table(rows);
}

// ---------------------------------------------------------------------------------------------------
// Adaptador de textos de las tarjetas y modelo del esquema (zonesPlannerText.ts)
// ---------------------------------------------------------------------------------------------------
{
  const names = { prima: 'Copa Quito', consuelo: 'Copa Consuelo' };
  const t = zoneOptionText(buildZoneOption(12, 3, 2, 2, false), names);
  ok(t.title === '3 zonas · 4-4-4', 'texto: título ' + t.title);
  ok(t.matches === 'Partidos por jugador en fase de grupos: 3', 'texto: partidos parejos');
  ok(t.interzonal === 'Interzonal: No', 'texto: sin interzonal');
  ok(t.qualifiers === '2 clasificados por grupo + los 2 mejores terceros', 'texto: clasificados con comodines');
  ok(t.copa === 'Jugadores a Copa Quito: 8', 'texto: Copa con sede');
  ok(t.consuelo === 'Jugadores a Copa Consuelo: 4', 'texto: Consuelo');
  ok(zoneOptionLines(t).length === 5 && zoneOptionLines(t)[2].includes('clasificados por grupo'), 'texto: 5 líneas en orden');
  const mand = buildZoneOption(10, 3, 2, 0, false);
  ok(zoneInterzonalText(mand) === 'Interzonal: Sí' && zoneMatchesText(mand) === 'Partidos por jugador en fase de grupos: 3', 'texto: interzonal obligatorio 4-3-3 sin rótulo');
  ok(zoneInterzonalText(buildZoneOption(8, 2, 2, 0, true)) === 'Interzonal: Sí', 'texto: interzonal opcional elegido sin rótulo');
  ok(zoneMatchesText(buildZoneOption(11, 2, 2, 0, false)) === 'Partidos por jugador en fase de grupos: 4/5', 'texto: partidos desiguales');
  ok(zoneQualifiersText(buildZoneOption(12, 3, 2, 0, false)) === '2 clasificados por grupo', 'texto: clasificados sin comodines');
  ok(zoneConsueloText(buildZoneOption(12, 3, 3, 0, false), names) === 'Jugadores a Copa Consuelo: 3 (no se arma)', 'texto: Consuelo con menos de 4');
  ok(zoneCopaText(buildZoneOption(12, 3, 2, 0, false), { prima: 'Copa', consuelo: 'Copa Consuelo' }) === 'Jugadores a Copa: 6', 'texto: Copa sin sede');

  // esquema visual
  const m1 = zonesSchemaModel(buildZoneOption(8, 2, 2, 0, true));
  ok(m1.sizes.join() === '4,4' && m1.arrows.length === 1 && m1.arrows[0].join() === '0,1' && m1.copaRows === 2 && m1.consueloRows === 2, 'esquema: 2 zonas iguales con interzonal -> una flecha entre las dos');
  const m2 = zonesSchemaModel(buildZoneOption(10, 3, 2, 0, false));
  ok(m2.sizes.join() === '4,3,3' && m2.arrows.length === 1 && m2.arrows[0].join() === '1,2', 'esquema: 4-3-3 obligatorio -> flecha SOLO entre las dos zonas chicas');
  const m3 = zonesSchemaModel(buildZoneOption(12, 3, 2, 0, true));
  ok(m3.arrows.length === 2 && m3.arrows[0].join() === '0,1' && m3.arrows[1].join() === '1,2', 'esquema: 3 zonas iguales con interzonal -> pares contiguos');
  const m4 = zonesSchemaModel(buildZoneOption(16, 4, 2, 0, true));
  ok(m4.arrows.length === 2 && m4.arrows[0].join() === '0,1' && m4.arrows[1].join() === '2,3', 'esquema: 4 zonas iguales con interzonal -> 0-1 y 2-3');
  const m5 = zonesSchemaModel(buildZoneOption(13, 3, 2, 1, false));
  ok(m5.sizes.join() === '5,4,4' && m5.wildcardRow.every(Boolean) && m5.arrows.length === 1 && m5.arrows[0].join() === '1,2', 'esquema: 5-4-4 con comodín (fila q+1 en las tres zonas) y flecha entre las chicas');
  const m6 = zonesSchemaModel(buildZoneOption(12, 3, 4, 0, false));
  ok(m6.wildcardRow.every((x) => !x) && !zonesSchemaModel(buildZoneOption(8, 2, 2, 0, false)).arrows.length, 'esquema: sin comodines no hay filas punteadas y sin interzonal no hay flechas');
}

// ---------------------------------------------------------------------------------------------------
// Posición de llaves y etiquetas del esquema (zonesSchemaLayout)
// ---------------------------------------------------------------------------------------------------
{
  const ROW = 12;
  const cases = [];
  for (let n = 4; n <= 32; n += 1) {
    for (let k = 2; k <= 4; k += 1) {
      const lay = zoneLayout(n, k);
      if (Math.min(...lay.sizes) < 2 || Math.max(...lay.sizes) > 8) continue;
      for (let q = 1; q <= 4; q += 1) {
        for (let w = 0; w <= 2; w += 1) {
          for (const iz of [false, true]) cases.push({ n, k, q, w, iz });
        }
      }
    }
  }
  let bad = 0, withConsuelo = 0, withoutConsuelo = 0;
  const why = [];
  for (const { n, k, q, w, iz } of cases) {
    const m = zonesSchemaModel(buildZoneOption(n, k, q, w, iz));
    for (const labelH of [13, 26, 39, 52]) {
      const L = zonesSchemaLayout(m, ROW, labelH, labelH);
      const tag = `N=${n} k=${k} q=${q} w=${w} label=${labelH}`;
      const copaBottom = L.copaLabel.top + L.copaLabel.height;
      // (a) la etiqueta de la Copa no queda por debajo de su llave
      if (copaBottom > L.copaBracket.top + L.copaBracket.height + 1e-9) { bad += 1; why.push('a ' + tag); }
      // primer renglón común sólo gris: después de la última fila resaltada o punteada de cualquier columna
      let lastMarked = -1;
      m.sizes.forEach((size, c) => {
        for (let r = 0; r < size; r += 1) {
          if (r < q || (r === q && m.wildcardRow[c])) lastMarked = Math.max(lastMarked, r);
        }
      });
      const grayStart = lastMarked + 1;
      if (L.consuelo) {
        withConsuelo += 1;
        // (b) la etiqueta de Consuelo no empieza antes del primer renglón gris común, y su llave encierra sólo grises
        if (L.consuelo.label.top < grayStart * ROW - 1e-9 || L.consuelo.bracket.top !== grayStart * ROW) { bad += 1; why.push('b ' + tag); }
        if (L.consuelo.bracket.height !== (m.sizes[0] - grayStart) * ROW) { bad += 1; why.push('b2 ' + tag); }
        // (c) nunca se solapan
        if (copaBottom > L.consuelo.label.top + 1e-9) { bad += 1; why.push('c ' + tag); }
        // el padding inferior alcanza para lo que sobresale
        if (L.consuelo.label.top + L.consuelo.label.height > L.height + L.padBottom + 1e-9) { bad += 1; why.push('pad-abajo ' + tag); }
      } else {
        withoutConsuelo += 1;
        // (d) sin Consuelo no hay llave ni etiqueta
        if (m.consueloCreated) { bad += 1; why.push('d ' + tag); }
      }
      // el padding superior alcanza para lo que sobresale hacia arriba
      if (L.copaLabel.top + L.padTop < -1e-9) { bad += 1; why.push('pad-arriba ' + tag); }
    }
  }
  ok(bad === 0 && withConsuelo > 0 && withoutConsuelo > 0, `layout del esquema: ${cases.length} combinaciones (zonas 2..4, tamaños 2..8, q 1..4, w 0..2, interzonal sí/no) x 4 alturas de etiqueta: Copa no queda bajo su llave, Consuelo no empieza antes del primer renglón gris común, nunca se solapan y sin Consuelo no se dibuja nada (${withConsuelo} con Consuelo, ${withoutConsuelo} sin)` + (bad ? ' ' + why.slice(0, 4).join(', ') : ''));
  const L3 = zonesSchemaLayout(zonesSchemaModel(buildZoneOption(8, 3, 2, 0, false)), ROW, 26, 26);
  ok(L3.consuelo === null, 'layout: 3 zonas 3-3-2 con 2 clasificados por zona (8 jugadores, Consuelo de 2): no se dibuja Consuelo');
}

// ---------------------------------------------------------------------------------------------------
// Lista de Enfrentamientos de Grupos + Copa (zonesPairingsList.ts)
// ---------------------------------------------------------------------------------------------------
{
  const names = new Map([['z1', 'A'], ['z2', 'B']]);
  ok(pairingGroupLabel('zone', 'z2', names) === 'Grupo B', 'lista: etiqueta de un pairing de zona (Grupo B)');
  ok(pairingGroupLabel('interzonal', null, names) === INTERZONAL_LABEL, 'lista: etiqueta de un interzonal');
  ok(pairingGroupLabel('revenge', null, names) === null && pairingGroupLabel(null, null, names) === null && pairingGroupLabel('zone', 'zx', names) === null, 'lista: otros stages o zona desconocida -> sin etiqueta');
  ok(['Grupo A', 'Grupo B', 'Grupo C', 'Grupo D', INTERZONAL_LABEL, null].map(shortGroupLabel).join() === 'GA,GB,GC,GD,I,', 'lista: abreviaturas del pie (GA, GB, GC, GD, I) y sin etiqueta -> null');
  ok(pairingGroupLabel('zone', 'z1', names) === 'Grupo A' && pairingGroupLabel('interzonal', null, names) === 'Interzonal', 'lista: las etiquetas completas siguen siendo "Grupo A" e "Interzonal" (headers y detalle)');
  const order = zonesGroupOrder(['A', 'B', 'C']);
  ok(order.join() === 'Grupo A,Grupo B,Grupo C,Interzonal', 'lista: orden de los headers en vivo (grupos y al final Interzonal)');
  const it = (id, status, groupLabel) => ({ id, status, groupLabel });
  // ya ordenado como la fase de liga: en vivo primero, después sin jugar, después terminados
  const items = [it('l1', 'in_progress', 'Grupo B'), it('l2', 'in_progress', 'Interzonal'), it('l3', 'in_progress', 'Grupo B'), it('s1', 'scheduled', 'Grupo A'), it('s2', 'scheduled', 'Interzonal'), it('c1', 'completed', 'Grupo B')];
  const rows = buildZonesOfficialRows(items, order);
  const kinds = rows.map((r) => (r.kind === 'header' ? 'H:' + r.title : r.item.id));
  ok(kinds.join() === 'H:Grupo B,l1,l3,H:Interzonal,l2,s1,s2,c1', 'lista: en vivo agrupadas bajo header (sólo Grupo B e Interzonal, que tienen una en vivo) y el resto en una sola lista sin headers (' + kinds.join() + ')');
  const noLive = buildZonesOfficialRows([it('s1', 'scheduled', 'Grupo A'), it('c1', 'completed', 'Grupo B')], order);
  ok(noLive.every((r) => r.kind === 'pairing') && noLive.length === 2, 'lista: sin partidas en vivo no hay ningún header');
  const onlyIz = buildZonesOfficialRows([it('l1', 'in_progress', 'Interzonal'), it('s1', 'scheduled', 'Grupo A')], order);
  ok(onlyIz.filter((r) => r.kind === 'header').map((r) => r.title).join() === 'Interzonal', 'lista: un interzonal en vivo muestra su header aunque nadie más juegue en vivo');
  ok(new Set(rows.map((r) => r.id)).size === rows.length, 'lista: ids de fila únicos');
  const gaps = rows.filter((r) => r.kind === 'pairing' && r.gapBefore).map((r) => r.id);
  ok(gaps.join() === 's1', 'lista: espacio vertical (gapBefore) sólo en la primera fila de la lista general, debajo del bloque en vivo');
  ok(noLive.every((r) => r.kind !== 'pairing' || !r.gapBefore), 'lista: sin bloque en vivo no hay espacio extra');
  ok(buildZonesOfficialRows([it('l1', 'in_progress', 'Grupo A')], order).every((r) => r.kind !== 'pairing' || !r.gapBefore), 'lista: sólo partidas en vivo -> no hay lista debajo ni espacio');
  const noLabel = buildZonesOfficialRows([it('l9', 'in_progress', null), it('s1', 'scheduled', 'Grupo A')], order);
  ok(noLabel.length === 2 && noLabel[0].kind === 'pairing', 'lista: una partida en vivo sin etiqueta queda arriba sin header');
}

// ---------------------------------------------------------------------------------------------------
// Completitud parcial por zona (pie de la tabla de posiciones)
// ---------------------------------------------------------------------------------------------------
{
  const mk = (stage, a, b, resolved = false, draw = false) => ({ stage, participant_a_id: a, participant_b_id: b, official_winner_participant_id: resolved ? a : null, official_draw: draw });
  const none = new Set();
  // 2 zonas de 5 con interzonal: 10 de zona + 5 interzonales = 15 por grupo
  const A = ['a1', 'a2', 'a3', 'a4', 'a5'], B = ['b1', 'b2', 'b3', 'b4', 'b5'];
  const zoneOf = new Map([...A.map((x) => [x, 'z1']), ...B.map((x) => [x, 'z2'])]);
  const pairs = (arr) => arr.flatMap((x, i) => arr.slice(i + 1).map((y) => [x, y]));
  const prs = [
    ...pairs(A).map(([x, y], i) => mk('zone', x, y, i < 6)),
    ...pairs(B).map(([x, y], i) => mk('zone', x, y, i < 2)),
    ...A.map((x, i) => mk('interzonal', x, B[i], i < 3)),
    mk('revenge', 'a1', 'b2', true), mk('bracket', 'a1', 'a2', true),
  ];
  const c1 = zonePhaseCompleteness('z1', prs, zoneOf, none);
  const c2 = zonePhaseCompleteness('z2', prs, zoneOf, none);
  ok(c1.total === 15 && c2.total === 15, 'completitud: 2 zonas de 5 con interzonal -> 15 por grupo (10 de zona + 5 interzonales; un interzonal cuenta en ambos)');
  ok(c1.done === 9 && c2.done === 5 && c1.done / c1.total !== c2.done / c2.total, 'completitud: dos grupos con distinta cantidad jugada muestran distinto % (' + c1.done + '/15 vs ' + c2.done + '/15), sin contar venganzas ni llaves');
  // zonas desiguales sin interzonal (11 jugadores en 6-5): cada zona compara sus propios partidos
  const U1 = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'], U2 = ['v1', 'v2', 'v3', 'v4', 'v5'];
  const zu = new Map([...U1.map((x) => [x, 'z1']), ...U2.map((x) => [x, 'z2'])]);
  const pu = [...pairs(U1).map(([x, y]) => mk('zone', x, y, true)), ...pairs(U2).map(([x, y], i) => mk('zone', x, y, i < 4))];
  const cu1 = zonePhaseCompleteness('z1', pu, zu, none), cu2 = zonePhaseCompleteness('z2', pu, zu, none);
  ok(cu1.total === 15 && cu1.done === 15 && cu2.total === 10 && cu2.done === 4, 'completitud: zonas desiguales 6-5 -> 15/15 y 4/10');
  // zonas desiguales con interzonal obligatorio (4-3-3): el interzonal sólo cuenta en las dos zonas chicas
  const Z1 = ['p1', 'p2', 'p3', 'p4'], Z2 = ['q1', 'q2', 'q3'], Z3 = ['r1', 'r2', 'r3'];
  const zz = new Map([...Z1.map((x) => [x, 'z1']), ...Z2.map((x) => [x, 'z2']), ...Z3.map((x) => [x, 'z3'])]);
  const pz = [...pairs(Z1).map(([x, y]) => mk('zone', x, y)), ...pairs(Z2).map(([x, y]) => mk('zone', x, y)), ...pairs(Z3).map(([x, y]) => mk('zone', x, y)), ...Z2.map((x, i) => mk('interzonal', x, Z3[i], true))];
  const cz = ['z1', 'z2', 'z3'].map((z) => zonePhaseCompleteness(z, pz, zz, none));
  ok(cz.map((c) => c.total).join() === '6,6,6' && cz.map((c) => c.done).join() === '0,3,3', 'completitud: 4-3-3 con interzonal entre las chicas -> 6/6/6 y el interzonal sólo suma en las zonas chicas (' + cz.map((c) => c.done + '/' + c.total).join(' ') + ')');
  // un par donde los dos se fueron cuenta cerrado; con uno solo ido (sin resolver) no
  const lp = [mk('zone', 'a1', 'a2'), mk('zone', 'a1', 'a3')];
  const cl = zonePhaseCompleteness('z1', lp, zoneOf, new Set(['a1', 'a2']));
  ok(cl.total === 2 && cl.done === 1, 'completitud: un par con los dos jugadores ido cuenta cerrado; con uno solo sin resolver no');
  ok(consueloWillBeCreated(12, 3, 2, 2) === true && consueloWillBeCreated(12, 3, 3, 0) === false && consueloWillBeCreated(16, 2, 4, 0) === true, 'consuelo: se arma sólo con N - T >= 4');
}

// Texto de clasificados con concordancia: q = 1..4 y w = 0..3 (tabla escrita a mano, no derivada de la función)
{
  const ORD = { 2: ['segundo', 'segundos'], 3: ['tercero', 'terceros'], 4: ['cuarto', 'cuartos'], 5: ['quinto', 'quintos'] };
  let allOk = true;
  const bad = [];
  for (let q = 1; q <= 4; q += 1) {
    for (let w = 0; w <= 3; w += 1) {
      const base = q === 1 ? '1 clasificado por grupo' : q + ' clasificados por grupo';
      const [sing, plur] = ORD[q + 1];
      const want = w === 0 ? base : w === 1 ? base + ' + el mejor ' + sing : base + ' + los ' + w + ' mejores ' + plur;
      const got = zoneQualifiersText({ qualifiers: q, wildcards: w });
      if (got !== want) { allOk = false; bad.push(q + '/' + w + ': ' + got + ' != ' + want); }
    }
  }
  ok(allOk, 'texto clasificados: 16 combinaciones q=1..4 x w=0..3 con singular/plural y ordinal ' + bad.join(' | '));
  ok(zoneQualifiersText({ qualifiers: 1, wildcards: 1 }) === '1 clasificado por grupo + el mejor segundo', 'texto: 1 clasificado por grupo + el mejor segundo');
  ok(zoneQualifiersText({ qualifiers: 2, wildcards: 1 }) === '2 clasificados por grupo + el mejor tercero', 'texto: 2 clasificados por grupo + el mejor tercero');
  ok(zoneQualifiersText({ qualifiers: 2, wildcards: 2 }) === '2 clasificados por grupo + los 2 mejores terceros', 'texto: 2 clasificados por grupo + los 2 mejores terceros');
  ok(zoneQualifiersText({ qualifiers: 2, wildcards: 0 }) === '2 clasificados por grupo', 'texto: 2 clasificados por grupo');
  ok(ordinalMasculine(3) === 'tercero' && ordinalMasculine(3, true) === 'terceros' && ordinalMasculine(7, true) === 'séptimos' && ordinalMasculine(12) === '12°', 'ordinal masculino');
  const names = { prima: 'Copa Quito', consuelo: 'Copa Consuelo' };
  ok(zoneQualifiersToCupText({ qualifiers: 2, wildcards: 1 }, names) === '2 clasificados por grupo + el mejor tercero a Copa Quito', 'texto: clasificados a Copa {sede}');
  ok(zoneQualifiersToCupText({ qualifiers: 2, wildcards: 0 }, names) === '2 clasificados por grupo a Copa Quito', 'texto: sin wildcards se omite el "+ ..."');
  ok(zoneConsueloTotalText(8, names) === '8 jugadores a Copa Consuelo', 'texto: total a Consuelo');
  ok(zoneFormatLine('BO1', 'BO3') === 'Grupos BO1 · Llaves BO3', 'texto: modalidad "Grupos {BO} · Llaves {BO}"');
}

// Consuelo con más de 16 no clasificados: M = min(N - T, 16)
{
  const big = buildZoneOption(26, 4, 2, 0, false); // T = 8, sobran 18
  ok(big.consueloSize === 16 && big.consueloCreated === true && big.warnings.some((x) => /admite 16/.test(x)), 'Consuelo con 18 sobrantes: se muestran 16, se arma y avisa que el resto queda sin copa');
  ok(consueloWillBeCreated(26, 4, 2, 0) === true && consueloWillBeCreated(26, 4, 3, 0) === true, 'consueloWillBeCreated con N - T > 16: se arma (M = min(N - T, 16))');
  ok(consueloSizeFor(26, 8) === 16 && consueloSizeFor(20, 8) === 12 && consueloSizeFor(10, 8) === 2 && consueloSizeFor(5, 8) === 0, 'consueloSizeFor: min(N - T, 16), nunca negativo');
  const t = zoneOptionText(big, { prima: 'Copa Quito', consuelo: 'Copa Consuelo' });
  ok(t.consuelo === 'Jugadores a Copa Consuelo: 16' && zoneConsueloTotalText(big.consueloSize, { prima: 'Copa', consuelo: 'Copa Consuelo' }) === '16 jugadores a Copa Consuelo', 'textos: el total a Consuelo muestra 16');
}

console.log(fails === 0 ? '\nTODO OK' : `\nHAY ${fails} FALLAS`);
process.exit(fails === 0 ? 0 : 1);

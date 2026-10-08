// Tests del planificador de zonas (app/src/lib/zonesPlanner.ts). Sin framework: node app/scripts/zones-planner.test.mjs
import {
  buildZoneOption,
  copaSizeRank,
  enumerateZoneOptions,
  isEvenGroupPhase,
  recommendZoneOptions,
  zoneLayout,
} from '../src/lib/zonesPlanner.ts';

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
          if (o.copaSize !== t || o.consueloSize !== n - t) { bad += 1; why.push(`T N=${n}`); }
          const tBlocked = o.blockers.some((b) => /entre 4 y 16/.test(b));
          if (tBlocked !== (t < 4 || t > 16)) { bad += 1; why.push(`bloqueo T N=${n} k=${k} q=${q} w=${w}`); }
          if (o.warnings.some((x) => /Consuelo/.test(x)) !== (n - t < 4)) { bad += 1; why.push(`aviso consuelo N=${n}`); }
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

console.log(fails === 0 ? '\nTODO OK' : `\nHAY ${fails} FALLAS`);
process.exit(fails === 0 ? 0 : 1);

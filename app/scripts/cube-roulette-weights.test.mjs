// Tests de las probabilidades pesadas de la ruleta de cubos (app/src/lib/cubeRouletteWeights.ts).
// node app/scripts/cube-roulette-weights.test.mjs
import {
  DEFAULT_CUBE_WEIGHT_PARAMS as D,
  cubeExitWeight,
  cubeRouletteProbabilities as probs,
  formatPercent1,
  pickWeighted,
  sanitizeCubeWeightParams,
} from '../src/lib/cubeRouletteWeights.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m}: ${a.toFixed(4)} ~ ${b}`);
const sum = (o) => Object.values(o).reduce((s, v) => s + v, 0);

// Caso base: N=5, A hace 1, B hace 2, C hace 3, D hace 5 (hace 4 hubo un cubo que ya no está en la ruleta), E nunca.
{
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const history = ['A', 'B', 'C', 'GONE', 'D'];
  const r = probs(ids, history, D, true);
  const pct = (id) => r.cubes[id] * 100;
  near(r.weights.A, 0.05, 0.005, 'peso A');
  near(r.weights.B, 0.61, 0.005, 'peso B');
  near(r.weights.C, 0.86, 0.005, 'peso C');
  near(r.weights.D, 0.96, 0.005, 'peso D');
  ok(r.weights.E === 1, 'peso E (nunca salió) = 1');
  near(pct('A'), 1.0, 0.1, 'P(A) %');
  near(pct('B'), 12.5, 0.1, 'P(B) %');
  near(pct('C'), 17.7, 0.1, 'P(C) %');
  near(pct('D'), 19.7, 0.1, 'P(D) %');
  near(pct('E'), 20.5, 0.1, 'P(E) %');
  near(r.fixed * 100, 14.2857, 0.001, 'Todos fuman / Jugador elige: 1/(N+2) cada uno');
  near(sum(r.cubes) + 2 * r.fixed, 1, 1e-12, 'las probabilidades suman 1');
  ok(formatPercent1(r.cubes.B) === '12.5%' && formatPercent1(r.fixed) === '14.3%', 'formato de % con 1 decimal');
}

// Varias salidas del mismo cubo: d=1 y d=3. N=5 -> tau = 0.8333.
{
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const history = ['A', 'B', 'A'];
  near(probs(ids, history, D).weights.A, 0.043, 0.001, "modo 'prod' (d=1 y d=3)");
  near(probs(ids, history, { ...D, mode: 'last' }).weights.A, 0.05, 1e-9, "modo 'last' (sólo la más reciente)");
  // En 'last', el orden importa: la más reciente es history[0].
  near(probs(ids, ['B', 'A', 'A'], { ...D, mode: 'last' }).weights.A, cubeExitWeight(2, 0.05, 5 / 6), 1e-9, "modo 'last' toma la salida más reciente");
}

// Toggle desactivado: uniforme 1/(N+2), con o sin historial.
{
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const r = probs(ids, ['A', 'B', 'C'], D, false);
  ok(ids.every((id) => Math.abs(r.cubes[id] - 1 / 7) < 1e-12) && Math.abs(r.fixed - 1 / 7) < 1e-12, 'toggle off: todo 1/(N+2)');
}

// N=25 con una salida a d=5: tau = 25/6 -> peso ~0.51.
{
  const ids = Array.from({ length: 25 }, (_, i) => `c${i}`);
  near(probs(ids, [null, null, null, null, 'c3'], D).weights.c3, 0.51, 0.005, 'N=25, d=5');
}

// tau mínimo: con N chico manda tau_min (N=3 -> N/k = 0.5 < 0.75).
{
  const r = probs(['A', 'B', 'C'], ['B'], D);
  near(r.weights.B, 0.05, 1e-12, 'd=1 siempre vale m');
  const r2 = probs(['A', 'B', 'C'], [null, 'B'], D);
  near(r2.weights.B, cubeExitWeight(2, 0.05, 0.75), 1e-12, 'N chico usa tau_min');
}

// Historial: eventos sin cubo (null) cuentan como eventos pero no pesan; cubos fuera de la ruleta se ignoran.
{
  const r = probs(['A', 'B'], ['GONE', 'GONE2', null], D);
  ok(r.weights.A === 1 && r.weights.B === 1, 'sin cubos de la ruleta en el historial: todos pesan 1');
  near(sum(r.cubes) + 2 * r.fixed, 1, 1e-12, 'suma 1 con historial ajeno');
}

// Ruleta sin cubos: sólo las dos opciones fijas.
{
  const r = probs([], ['A'], D);
  ok(Object.keys(r.cubes).length === 0 && Math.abs(r.fixed - 0.5) < 1e-12, 'N=0: 1/2 cada opción fija');
}

// Parámetros inválidos -> defaults (campo por campo).
{
  ok(JSON.stringify(sanitizeCubeWeightParams(null)) === JSON.stringify(D), 'sin fila: defaults');
  ok(JSON.stringify(sanitizeCubeWeightParams({ m: -0.1, k: 0, tau_min: -1, accumulation_mode: 'x' })) === JSON.stringify(D), 'todo inválido: defaults');
  ok(JSON.stringify(sanitizeCubeWeightParams({ m: 1.5, k: NaN, tau_min: 0, accumulation_mode: null })) === JSON.stringify(D), 'fuera de rango / NaN / null: defaults');
  const p = sanitizeCubeWeightParams({ m: '0.2', k: 4, tau_min: 1, accumulation_mode: 'last' });
  ok(p.m === 0.2 && p.k === 4 && p.tauMin === 1 && p.mode === 'last', 'valores válidos (numeric llega como string) se respetan');
  const mixed = sanitizeCubeWeightParams({ m: 0.1, k: -3, tau_min: 2, accumulation_mode: 'bad' });
  ok(mixed.m === 0.1 && mixed.k === D.k && mixed.tauMin === 2 && mixed.mode === 'prod', 'inválido sólo cae al default en su campo');
  // probs() con parámetros rotos no explota ni devuelve NaN.
  const r = probs(['A', 'B'], ['A'], { m: NaN, k: 0, tauMin: -1, mode: 'zzz' });
  ok(Object.values(r.cubes).every(Number.isFinite), 'probs() con parámetros inválidos usa defaults');
  near(sanitizeCubeWeightParams({ m: 0 }).m, 0, 0, 'm = 0 es válido');
  near(sanitizeCubeWeightParams({ m: 1 }).m, 1, 0, 'm = 1 es válido (sin penalización)');
}

// pickWeighted: respeta las proporciones y los bordes.
{
  ok(pickWeighted([0.2, 0.3, 0.5], 0) === 0 && pickWeighted([0.2, 0.3, 0.5], 0.19) === 0, 'pickWeighted: primer tramo');
  ok(pickWeighted([0.2, 0.3, 0.5], 0.2) === 1 && pickWeighted([0.2, 0.3, 0.5], 0.49) === 1, 'pickWeighted: segundo tramo');
  ok(pickWeighted([0.2, 0.3, 0.5], 0.5) === 2 && pickWeighted([0.2, 0.3, 0.5], 0.9999) === 2, 'pickWeighted: tercer tramo');
  ok(pickWeighted([0, 1], 0.5) === 1, 'pickWeighted: peso 0 nunca sale');
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const r = probs(ids, ['A', 'B', 'C', null, 'D'], D);
  const arr = [...ids.map((i) => r.cubes[i]), r.fixed, r.fixed];
  const counts = new Array(arr.length).fill(0);
  const N = 200000;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let i = 0; i < N; i += 1) counts[pickWeighted(arr, rnd())] += 1;
  ok(arr.every((p, i) => Math.abs(counts[i] / N - p) < 0.006), 'pickWeighted: frecuencias ~ probabilidades (200k tiradas)');
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLAS`);
process.exit(fails === 0 ? 0 : 1);

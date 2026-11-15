// Tests de la lógica de cubos habilitados (app/src/lib/cubeEnabled.ts) y de las probabilidades de la ruleta con N reducido.
// node app/scripts/cube-enabled.test.mjs
import {
  isCubeEnabled,
  filterEnabledCubes,
  enabledCubeCount,
  canDisableCube,
} from '../src/lib/cubeEnabled.ts';
import { cubeRouletteProbabilities, DEFAULT_CUBE_WEIGHT_PARAMS } from '../src/lib/cubeRouletteWeights.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

const cubes = [
  { id: 'a', name: 'A', is_enabled: true },
  { id: 'b', name: 'B', is_enabled: false },
  { id: 'c', name: 'C' },               // sin el flag (consulta o APK que no lo conoce): habilitado
  { id: 'd', name: 'D', is_enabled: null },
  { id: 'e', name: 'E', is_enabled: false },
];

// --- filtro de habilitados --------------------------------------------------------------------------------------------------------
ok(isCubeEnabled({ is_enabled: true }) && isCubeEnabled({}) && isCubeEnabled({ is_enabled: null }) && !isCubeEnabled({ is_enabled: false }), 'habilitado = todo salvo is_enabled === false (sin flag cuenta como habilitado)');
ok(filterEnabledCubes(cubes).map((c) => c.id).join() === 'a,c,d', 'el filtro deja solo los habilitados y conserva el orden');
ok(enabledCubeCount(cubes) === 3 && enabledCubeCount([]) === 0, 'cuenta de habilitados');
ok(filterEnabledCubes([]).length === 0, 'lista vacía: sin cubos');
ok(filterEnabledCubes(cubes) !== cubes && cubes.length === 5, 'el filtro no muta la lista original');

// --- último habilitado ----------------------------------------------------------------------------------------------------------------
ok(canDisableCube(cubes, 'a') === true, 'con 3 habilitados se puede deshabilitar uno');
const dos = [{ id: 'a', is_enabled: true }, { id: 'b', is_enabled: true }, { id: 'x', is_enabled: false }];
ok(canDisableCube(dos, 'a') === true, 'con 2 habilitados se puede deshabilitar uno (queda 1)');
const uno = [{ id: 'a', is_enabled: true }, { id: 'x', is_enabled: false }];
ok(canDisableCube(uno, 'a') === false, 'el ÚLTIMO habilitado no se puede deshabilitar');
ok(canDisableCube(uno, 'x') === true, 'uno ya deshabilitado: nada que impedir');
ok(canDisableCube([{ id: 'solo' }], 'solo') === false, 'un único cubo (sin flag = habilitado): no se puede deshabilitar');
ok(canDisableCube(uno, 'zzz') === false, 'cubo que no está en la lista: no');

// --- probabilidades con N reducido ----------------------------------------------------------------------------------------------------
const P = DEFAULT_CUBE_WEIGHT_PARAMS;
const todos = ['a', 'b', 'c', 'd', 'e'];
const hab = filterEnabledCubes(cubes).map((c) => c.id);   // a, c, d
const p5 = cubeRouletteProbabilities(todos, [], P, true);
const p3 = cubeRouletteProbabilities(hab, [], P, true);
ok(near(p5.fixed, 1 / 12) && near(p3.fixed, 1 / 8), 'N = 5 -> "Jugador elige"/"Todos fuman" 1/12 c/u; N = 3 (habilitados) -> 1/8 c/u');
ok(Object.keys(p3.cubes).sort().join() === 'a,c,d', 'las probabilidades solo tienen a los habilitados: un deshabilitado no puede salir (no tiene entrada)');
ok(near(sum(p3.cubes) + 2 * p3.fixed, 1), 'con N reducido todo suma 1 (cubos habilitados + las dos opciones fijas)');
ok(hab.every((id) => near(p3.cubes[id], 1 / 4)), 'sin historial los 3 habilitados valen 1/(N+1) = 1/4 cada uno');
ok(near(cubeRouletteProbabilities(hab, [], P, false).cubes.a, 1 / 4), 'modo uniforme: también 1/(N+1) con el N de habilitados');
// historial: un cubo deshabilitado que salió ocupa su lugar en el conteo de eventos pero no pesa
const hist = ['b', 'a', 'e', 'c'];   // el evento anterior fue el cubo deshabilitado b
const pw = cubeRouletteProbabilities(hab, hist, P, true);
ok(near(sum(pw.cubes) + 2 * pw.fixed, 1), 'con historial que incluye cubos deshabilitados: sigue sumando 1');
ok(!('b' in pw.cubes) && !('e' in pw.cubes), 'el historial de cubos deshabilitados no les da probabilidad');
ok(pw.cubes.a < pw.cubes.d && pw.cubes.c < pw.cubes.d, 'los que salieron hace poco pesan menos que el que nunca salió (d)');
// N = 1 y N = 0
const p1 = cubeRouletteProbabilities(['a'], [], P, true);
ok(near(p1.cubes.a, 1 / 2) && near(p1.fixed, 1 / 4), 'N = 1: el cubo vale 1/2 y cada opción fija 1/4');
const p0 = cubeRouletteProbabilities([], [], P, true);
ok(Object.keys(p0.cubes).length === 0 && near(p0.fixed, 1 / 2), 'N = 0: ningún cubo puede salir (por eso la app bloquea deshabilitar el último)');

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

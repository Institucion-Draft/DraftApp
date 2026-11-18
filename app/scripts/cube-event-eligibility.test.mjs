// Tests de la elegibilidad de cubos por evento (app/src/lib/cubeEnabled.ts, 0163) y de los permisos por rol (eventPermissions.ts).
// node app/scripts/cube-event-eligibility.test.mjs
import {
  eventCubeRows,
  effectiveEligibleCubes,
  isEligibleInEvent,
  canTurnOffCubeInEvent,
  NO_ELIGIBLE_CUBES_NOTICE,
  EVENT_LAST_ELIGIBLE_MESSAGE,
} from '../src/lib/cubeEnabled.ts';
import { cubeRouletteProbabilities, DEFAULT_CUBE_WEIGHT_PARAMS } from '../src/lib/cubeRouletteWeights.ts';
import { canEditCubeAvailabilityIn } from '../src/lib/eventPermissions.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const ids = (xs) => xs.map((c) => c.id).join(',');
const ov = (cube_id, is_enabled) => ({ cube_id, is_enabled });

const cubes = [
  { id: 'a', name: 'A', is_enabled: true },
  { id: 'b', name: 'B', is_enabled: false },   // apagado en el global
  { id: 'c', name: 'C' },                        // sin flag: habilitado
  { id: 'd', name: 'D', is_enabled: null },
  { id: 'e', name: 'E', is_enabled: true },
];

// --- los cuatro casos global/evento ------------------------------------------------------------------------------------------------------
ok(isEligibleInEvent({ is_enabled: true }, null) === true, 'global prendido, sin cambio propio: elegible (hereda)');
ok(isEligibleInEvent({ is_enabled: false }, null) === false, 'global apagado, sin cambio propio: no elegible (hereda)');
ok(isEligibleInEvent({ is_enabled: false }, true) === true, 'global apagado, PRENDIDO en el evento: elegible');
ok(isEligibleInEvent({ is_enabled: true }, false) === false, 'global prendido, APAGADO en el evento: no elegible');
ok(isEligibleInEvent({ is_enabled: true }, true) && !isEligibleInEvent({ is_enabled: false }, false), 'el estado propio igual al global da lo mismo');
ok(isEligibleInEvent({}, null) && isEligibleInEvent({ is_enabled: null }, undefined), 'sin flag global: cuenta como habilitado');

// --- lista efectiva ----------------------------------------------------------------------------------------------------------------------
ok(ids(effectiveEligibleCubes(cubes, [])) === 'a,c,d,e', 'sin cambios propios: lo habilitado en el global (evento nuevo)');
ok(ids(effectiveEligibleCubes(cubes, [ov('c', false)])) === 'a,d,e', 'apagar uno en el evento lo saca, conservando el orden');
ok(ids(effectiveEligibleCubes(cubes, [ov('b', true)])) === 'a,b,c,d,e', 'prender en el evento uno apagado en el global lo suma');
ok(ids(effectiveEligibleCubes(cubes, [ov('b', true), ov('a', false)])) === 'b,c,d,e', 'combinado: prende B y apaga A');
ok(ids(effectiveEligibleCubes(cubes, [ov('a', true), ov('b', false)])) === 'a,c,d,e', 'un cambio propio igual al global no altera nada');
ok(ids(effectiveEligibleCubes(cubes, [ov('zzz', true)])) === 'a,c,d,e', 'un cambio propio de un cubo que ya no está en la lista no molesta');
ok(ids(effectiveEligibleCubes(cubes, new Set([]))) === 'a,c,d,e', 'acepta cualquier iterable');
// lectura en vivo: los que no tienen cambio propio siguen al global; los que sí, no
const apagadoA = cubes.map((c) => (c.id === 'a' ? { ...c, is_enabled: false } : c));
ok(ids(effectiveEligibleCubes(apagadoA, [])) === 'c,d,e', 'si el global apaga un cubo sin cambio propio, el evento lo ve apagado');
ok(ids(effectiveEligibleCubes(apagadoA, [ov('a', true)])) === 'a,c,d,e', 'si el evento tenía A prendido, sigue prendido aunque el global lo apague');
const prendidoB = cubes.map((c) => (c.id === 'b' ? { ...c, is_enabled: true } : c));
ok(ids(effectiveEligibleCubes(prendidoB, [ov('b', false)])) === 'a,c,d,e', 'si el evento tenía B apagado, sigue apagado aunque el global lo prenda');
ok(ids(effectiveEligibleCubes(prendidoB, [])) === 'a,b,c,d,e', 'y sin cambio propio, B aparece al prenderlo en el global');
ok(ids(effectiveEligibleCubes(cubes, [ov('a', false), ov('c', false), ov('d', false), ov('e', false)])) === '', 'todo apagado: nada elegible');

// --- filas para la pantalla --------------------------------------------------------------------------------------------------------------
const rows = eventCubeRows(cubes, [ov('c', false), ov('b', true)]);
const r = (id) => rows.find((x) => x.id === id);
ok(r('a').eligible && r('a').globalEnabled && r('a').override === null, 'fila: sin cambio propio hereda el global');
ok(!r('c').eligible && r('c').globalEnabled && r('c').override === false, 'fila: apagado en el evento aunque el global esté prendido');
ok(r('b').eligible && !r('b').globalEnabled && r('b').override === true, 'fila: prendido en el evento aunque el global esté apagado (switch activo)');
ok(rows.length === cubes.length && ids(rows) === 'a,b,c,d,e', 'la pantalla lista TODOS los cubos, en orden');

// --- último cubo elegible ----------------------------------------------------------------------------------------------------------------
ok(canTurnOffCubeInEvent(rows, 'a'), 'se puede apagar un cubo si queda otro elegible');
const casiVacio = eventCubeRows(cubes, [ov('a', false), ov('c', false), ov('d', false)]);   // elegible: solo e
ok(!canTurnOffCubeInEvent(casiVacio, 'e'), 'no se puede apagar el ÚLTIMO elegible');
ok(canTurnOffCubeInEvent(casiVacio, 'c'), 'uno que ya no es elegible: no hay nada que impedir');
ok(canTurnOffCubeInEvent(casiVacio, 'b'), 'uno apagado en el global (no elegible) tampoco se bloquea');
const soloPrendidoPorEvento = eventCubeRows([{ id: 'x', is_enabled: false }, { id: 'y', is_enabled: false }], [ov('x', true)]);
ok(!canTurnOffCubeInEvent(soloPrendidoPorEvento, 'x'), 'si el único elegible es uno prendido por el evento, tampoco se puede apagar');
ok(!canTurnOffCubeInEvent(rows, 'nope'), 'un cubo fuera de la lista no se puede apagar');
ok(!canTurnOffCubeInEvent(eventCubeRows([{ id: 'x' }], []), 'x'), 'con un solo cubo no se puede apagar');

// --- N de las probabilidades ponderadas ------------------------------------------------------------------------------------------------
const P = DEFAULT_CUBE_WEIGHT_PARAMS;
const elig = effectiveEligibleCubes(cubes, [ov('c', false), ov('b', true)]).map((c) => c.id);   // a,b,d,e => N = 4
const prob = cubeRouletteProbabilities(elig, [], P, true);
ok(Object.keys(prob.cubes).length === 4 && near(prob.fixed, 1 / (2 * 5)), 'las probabilidades usan la N de los efectivamente elegibles (4, fijo 1/10)');
ok(near(Object.values(prob.cubes).reduce((a, b) => a + b, 0) + 2 * prob.fixed, 1), 'las probabilidades de los cubos + los dos fijos suman 1');
ok('b' in prob.cubes && !('c' in prob.cubes), 'el prendido por el evento tiene probabilidad; el apagado por el evento no');
ok(Object.keys(cubeRouletteProbabilities([], [], P, true).cubes).length === 0, 'sin elegibles no hay probabilidades (la ruleta no gira)');

// --- permisos por rol ----------------------------------------------------------------------------------------------------------------------
const uid = 'u1';
const g = (role) => canEditCubeAvailabilityIn('global', { workspaceRole: role, eventOrganizerUserId: uid, userId: uid });
ok(g('organizer') && !g('member') && !g(null), 'modo global: solo el organizador del workspace (la posta NO alcanza)');
const e = (role, posta, user = uid) => canEditCubeAvailabilityIn('event', { workspaceRole: role, eventOrganizerUserId: posta, userId: user });
ok(e('organizer', 'otro'), 'modo evento: el organizador del workspace edita aunque no tenga la posta');
ok(e('member', uid), 'modo evento: member con la posta edita (Martín)');
ok(!e('member', 'otro'), 'modo evento: member sin la posta NO edita');
ok(!e('member', uid, null) && !e(null, null, null), 'modo evento: sin sesión, no edita');

// --- avisos --------------------------------------------------------------------------------------------------------------------------------------
ok(/Habilitar\/Deshabilitar cubos/.test(NO_ELIGIBLE_CUBES_NOTICE) && !/general|global|organizador del workspace/i.test(NO_ELIGIBLE_CUBES_NOTICE), 'aviso de ruleta sin cubos: remite a "Habilitar/Deshabilitar cubos" y no menciona el global');
ok(!/global|general/i.test(EVENT_LAST_ELIGIBLE_MESSAGE), 'aviso del último cubo: sin explicaciones del global');

console.log(fails ? `\n${fails} FALLAS` : '\nTodo OK');
process.exit(fails ? 1 : 0);

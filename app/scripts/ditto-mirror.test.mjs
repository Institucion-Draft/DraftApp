// Tests de a quién copia cada Ditto en el life tracker (app/src/lib/dittoMirror.ts). node app/scripts/ditto-mirror.test.mjs
import { resolveDittoMirrors, dittoMirrorKey, dittoSpritePlan, DITTO_TRANSFORM_DELAY_MS, DITTO_TRANSFORM_DURATION_MS } from '../src/lib/dittoMirror.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };

const slot = (participantId, avatarName, extra = {}) => ({
  participantId, member: extra.member ?? 'a', avatarName, hasCustomAvatar: extra.custom ?? false,
});
const key = (pid, m = 'a') => dittoMirrorKey(pid, m);

// Ditto vs normal: el Ditto copia al rival; el rival no cambia.
{
  const r = resolveDittoMirrors('m1', [slot('pA', 'Ditto')], [slot('pB', 'Pikachu')]);
  ok(r.size === 1, 'Ditto vs normal: una sola entrada');
  ok(r.get(key('pA'))?.participantId === 'pB' && r.get(key('pA'))?.isMemberB === false, 'Ditto vs normal: copia al rival');
  ok(!r.has(key('pB')), 'Ditto vs normal: el rival normal no copia a nadie');
}
// normal vs Ditto (lado B).
{
  const r = resolveDittoMirrors('m1', [slot('pA', 'Pikachu')], [slot('pB', 'ditto')]);
  ok(r.get(key('pB'))?.participantId === 'pA', 'normal vs Ditto: el Ditto del lado B copia al lado A (name en minúscula)');
  ok(!r.has(key('pA')), 'normal vs Ditto: el normal no copia');
}
// Rival sin Pokémon / sin nombre.
{
  const r = resolveDittoMirrors('m1', [slot('pA', 'Ditto')], [slot('pB', null)]);
  ok(r.size === 0, 'rival sin Pokémon: el Ditto se queda Ditto');
  const r2 = resolveDittoMirrors('m1', [slot('pA', 'Ditto')], [slot('pB', '  ')]);
  ok(r2.size === 0, 'rival con nombre vacío: el Ditto se queda Ditto');
}
// Rival con avatar custom.
{
  const r = resolveDittoMirrors('m1', [slot('pA', 'Ditto')], [slot('pB', 'Pikachu', { custom: true })]);
  ok(r.size === 0, 'rival con avatar custom: el Ditto se queda Ditto');
}
// Ditto con avatar custom propio: ya no se ve como Ditto, no copia.
{
  const r = resolveDittoMirrors('m1', [slot('pA', 'Ditto', { custom: true })], [slot('pB', 'Pikachu')]);
  ok(r.size === 0, 'Ditto con avatar custom propio: no copia');
}
// Defensivo: Ditto vs Ditto, sin cadenas.
{
  const r = resolveDittoMirrors('m1', [slot('pA', 'Ditto')], [slot('pB', 'Ditto')]);
  ok(r.size === 0, 'Ditto vs Ditto: ninguno copia, los dos quedan Ditto');
}
// Sin rivales.
ok(resolveDittoMirrors('m1', [slot('pA', 'Ditto')], []).size === 0, 'sin rivales: no copia');

// 2HG: elección estable y que alcanza a los dos rivales.
{
  const sideA = [slot('tA', 'Ditto'), slot('tA', 'Eevee', { member: 'b' })];
  const sideB = [slot('tB', 'Pikachu'), slot('tB', 'Mew', { member: 'b' })];
  const first = resolveDittoMirrors('match-fijo', sideA, sideB).get(key('tA', 'a'));
  let estable = true;
  for (let i = 0; i < 50; i += 1) {
    const t = resolveDittoMirrors('match-fijo', sideA, sideB).get(key('tA', 'a'));
    if (!t || t.participantId !== first.participantId || t.isMemberB !== first.isMemberB) estable = false;
  }
  ok(first != null && estable, '2HG: mismo input -> mismo resultado (50 corridas)');
  ok(first.participantId === 'tB', '2HG: copia a un miembro del equipo rival');

  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const t = resolveDittoMirrors(`match-${i}`, sideA, sideB).get(key('tA', 'a'));
    seen.add(t.isMemberB ? 'b' : 'a');
  }
  ok(seen.has('a') && seen.has('b'), '2HG: con distintos ids de partida se eligen ambos rivales');

  // El resultado no depende del orden en que se consulten los lados ni de datos ajenos.
  const swapped = resolveDittoMirrors('match-fijo', sideB, sideA).get(key('tA', 'a'));
  ok(swapped.participantId === first.participantId && swapped.isMemberB === first.isMemberB, '2HG: invariante al intercambiar los lados');
}
// 2HG: el rival elegido es Ditto -> el Ditto se queda Ditto (sin cadena); el otro rival sigue copiable.
{
  const sideA = [slot('tA', 'Ditto')];
  const sideB = [slot('tB', 'Ditto'), slot('tB', 'Pikachu', { member: 'b' })];
  let sinCadena = true;
  for (let i = 0; i < 100; i += 1) {
    const t = resolveDittoMirrors(`m-${i}`, sideA, sideB).get(key('tA'));
    if (t && !t.isMemberB) sinCadena = false; // nunca debe apuntar al Ditto
  }
  ok(sinCadena, '2HG: nunca copia a un rival que también es Ditto');
}
// 2HG: dos Ditto en el mismo equipo eligen de forma independiente pero estable.
{
  const sideA = [slot('tA', 'Ditto'), slot('tA', 'Ditto', { member: 'b' })];
  const sideB = [slot('tB', 'Pikachu'), slot('tB', 'Mew', { member: 'b' })];
  const r1 = resolveDittoMirrors('mx', sideA, sideB);
  const r2 = resolveDittoMirrors('mx', sideA, sideB);
  ok(r1.has(key('tA', 'a')) && r1.has(key('tA', 'b')), '2HG: ambos miembros Ditto del mismo equipo copian');
  ok(JSON.stringify([...r1]) === JSON.stringify([...r2]), '2HG: dos Ditto del mismo equipo, resultado estable');
}

// ── Fases del sprite: antes del cartel, durante, y después ───────────────────────────────────────────────────
{
  const plan = (starterPending, starterSeenThisSession, transformDelayElapsed) =>
    dittoSpritePlan({ starterPending, starterSeenThisSession, transformDelayElapsed });
  // Cartel abierto desde el inicio de la sesión: Ditto se ve como Ditto, sin animar (aunque el flag de pausa esté en true).
  for (const seen of [false, true]) for (const el of [false, true]) {
    const r = plan(true, seen, el);
    ok(r.phase === 'before' && !r.showMirror && !r.animate, `cartel abierto (seen=${seen}, pausa=${el}): Ditto propio, sin animar`);
  }
  // Cartel resuelto en esta sesión: sigue Ditto hasta que pasa la pausa; después copia y anima.
  const w = plan(false, true, false);
  ok(w.phase === 'waiting' && !w.showMirror && !w.animate, 'cartel resuelto, durante la pausa: sigue siendo Ditto');
  const tf = plan(false, true, true);
  ok(tf.phase === 'transform' && tf.showMirror && tf.animate, 'cartel resuelto, pasada la pausa: sprite del rival con animación');
  // Partida ya empezada (nunca hubo cartel en esta sesión): copiado directo, sin animación.
  for (const el of [false, true]) {
    const d = plan(false, false, el);
    ok(d.phase === 'direct' && d.showMirror && !d.animate, `sin cartel en la sesión (pausa=${el}): copiado directo, sin animación`);
  }
  // Sólo anima en la fase transform.
  const all = [];
  for (const p of [false, true]) for (const s of [false, true]) for (const e of [false, true]) all.push(plan(p, s, e));
  ok(all.filter((x) => x.animate).length === 1 && all.every((x) => !x.animate || x.phase === 'transform'), 'de las 8 combinaciones sólo una anima, y es la fase transform');
  ok(all.every((x) => !x.animate || x.showMirror), 'nunca se anima sin mostrar el espejo');
  ok(DITTO_TRANSFORM_DELAY_MS === 1000 && DITTO_TRANSFORM_DURATION_MS >= 600 && DITTO_TRANSFORM_DURATION_MS <= 800, 'pausa ~1 s y duración 600-800 ms');
  // Secuencia completa en el tiempo: before -> waiting -> transform.
  const seq = [plan(true, false, false), plan(true, true, false), plan(false, true, false), plan(false, true, true)].map((x) => x.phase);
  ok(seq.join(',') === 'before,before,waiting,transform', 'secuencia: cartel -> pausa -> transformación');
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

// Tests de la lógica pura del sorteo de lugares (app/src/lib/eventSeating.ts). node app/scripts/event-seating.test.mjs
import {
  oppositeDirection, packDirection, mateDirection, tableLayout, seatSlots, adjacentSameTeam,
  isSeatingCurrent, seatingButton, seatingBlocksStart, seatingScreenMode, seatingPersons, rouletteDelays, rouletteSeat,
  timerVortexDirections, timerIsActive, timerVorticesVisible, timerVorticesSpinning,
  TIMER_VORTEX_SIZE, TIMER_VORTEX_GAP, timerVorticesRowWidth, isDraftStarted,
} from '../src/lib/eventSeating.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const desc = (n) => seatSlots(n).map((s) => `${s.seat}:${s.zone[0]}${s.zone === 'right' || s.zone === 'left' ? s.row : ''}`).join(' ');

// ── Geometría ─────────────────────────────────────────────────────────────────────────────────────────────────
const L = (n) => { const l = tableLayout(n); return `${l.top}/${l.bottom}/${l.perSide}`; };
ok(L(2) === '1/1/0', 'n=2: las dos cabeceras, sin lados');
ok(L(3) === '1/0/1', 'n=3: una cabecera y uno por lado');
ok(L(4) === '1/1/1', 'n=4: dos cabeceras y uno por lado');
ok(L(5) === '1/0/2', 'n=5: una cabecera y dos por lado');
ok(L(6) === '1/1/2', 'n=6: dos cabeceras y dos por lado');
ok(L(7) === '1/0/3', 'n=7: una cabecera y tres por lado');
ok(L(8) === '1/1/3', 'n=8: dos cabeceras y tres por lado');
ok(L(16) === '1/1/7' && L(24) === '1/1/11', 'n=16 (máximo de la Copa) y n=24');
ok(desc(2) === '1:t 2:b', 'numeración n=2: 1 arriba, 2 abajo');
ok(desc(3) === '1:t 2:r0 3:l0', 'numeración n=3 (horaria): 1 arriba, 2 a la derecha, 3 a la izquierda');
ok(desc(4) === '1:t 2:r0 3:b 4:l0', 'numeración n=4: arriba, derecha, abajo, izquierda');
ok(desc(5) === '1:t 2:r0 3:r1 4:l1 5:l0', 'numeración n=5: derecha de arriba a abajo, izquierda de abajo a arriba');
ok(desc(6) === '1:t 2:r0 3:r1 4:b 5:l1 6:l0', 'numeración n=6');
ok(desc(8) === '1:t 2:r0 3:r1 4:r2 5:b 6:l2 7:l1 8:l0', 'numeración n=8');
for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 20, 24, 32]) {
  const slots = seatSlots(n);
  const l = tableLayout(n);
  const seats = slots.map((s) => s.seat);
  const cnt = (z) => slots.filter((s) => s.zone === z).length;
  const good = slots.length === n && seats.every((s, i) => s === i + 1) && cnt('left') === cnt('right') && cnt('left') === l.perSide
    && cnt('top') === 1 && cnt('bottom') === (n % 2 === 0 ? 1 : 0)
    && new Set(slots.filter((s) => s.zone === 'left').map((s) => s.row)).size === l.perSide;
  ok(good, `n=${n}: ${n} lugares 1..n, lados iguales (${l.perSide}), cabeceras ${l.top}+${l.bottom}`);
}
ok(seatSlots(0).length === 0 && seatSlots(1).length === 1, 'n=0 y n=1 no rompen');

// ── Sentido de los sobres ─────────────────────────────────────────────────────────────────────────────────────
ok(oppositeDirection('cw') === 'ccw' && oppositeDirection('ccw') === 'cw', 'opuesto');
for (const first of ['cw', 'ccw']) {
  const o = oppositeDirection(first);
  ok([1, 2, 3, 4, 5, 6].map((i) => packDirection(first, i)).join() === [first, o, first, o, first, o].join(), `sobres alternan desde ${first}: sobre 1 = ${first}, 2 = ${o}, 3 = ${first}...`);
  ok([1, 2, 3, 4].every((i) => mateDirection(first, i) === oppositeDirection(packDirection(first, i))), `mate/cigarro siempre opuestos a los sobres de ese sobre (primero ${first})`);
}
ok(packDirection('cw', 0) === 'cw' && packDirection('cw', -3) === 'cw' && packDirection('cw', NaN) === 'cw' && packDirection('ccw', 2.7) === 'cw', 'índices inválidos se tratan como el sobre 1 (y se trunca)');

// ── Adyacencia 2HG ────────────────────────────────────────────────────────────────────────────────────────────
ok(adjacentSameTeam(['a', 'b', 'a', 'b']) === 0, 'alternado: sin adyacentes');
ok(adjacentSameTeam(['a', 'a', 'b', 'b']) === 2, 'a a b b en círculo: 2 pares (a-a y b-b)');
ok(adjacentSameTeam(['a', 'b', 'b', 'a']) === 2, 'el cierre n con 1 también cuenta (a ... a)');
ok(adjacentSameTeam([1, 2, 3, 1, 2, 3]) === 0 && adjacentSameTeam([1, 2, 3, 3, 2, 1]) === 2, 'n=6');
ok(adjacentSameTeam([1, 1]) === 1 && adjacentSameTeam([1]) === 0 && adjacentSameTeam([]) === 0, 'n=2 cuenta una vez; n<2 nada');

// ── Vigencia y botones ────────────────────────────────────────────────────────────────────────────────────────
const cur = { is_current: true }, stale = { is_current: false };
ok(isSeatingCurrent(cur) && !isSeatingCurrent(stale) && !isSeatingCurrent(null) && !isSeatingCurrent(undefined), 'sorteo vigente: sólo is_current === true');
const btn = (o) => seatingButton(o).kind;
const base = { enabled: true, canManage: false, draftStarted: false, seating: null };
ok(btn({ ...base, enabled: false, canManage: true }) === 'none' && btn({ ...base, enabled: false, seating: cur }) === 'none', 'toggle OFF: sin botón');
ok(btn({ ...base, canManage: true }) === 'draw' && seatingButton({ ...base, canManage: true }).label === 'Sortear lugares en la mesa', 'gestiona, antes de arrancar: "Sortear lugares en la mesa"');
ok(btn({ ...base, canManage: true, seating: cur }) === 'draw' && btn({ ...base, canManage: true, seating: stale }) === 'draw', 'gestiona: sigue pudiendo sortear con vigente u obsoleto');
ok(btn({ ...base }) === 'none', 'los demás: sin botón mientras no haya sorteo publicado');
ok(btn({ ...base, seating: cur }) === 'assignment' && seatingButton({ ...base, seating: cur }).label === 'Asignación de lugares en la mesa', 'los demás con vigente: "Asignación de lugares en la mesa"');
ok(btn({ ...base, seating: stale }) === 'assignment', 'los demás con sorteo obsoleto: el botón NO se oculta');
ok(btn({ ...base, canManage: true, draftStarted: true, seating: cur }) === 'positions' && seatingButton({ ...base, canManage: true, draftStarted: true, seating: cur }).label === 'Posiciones en la mesa', 'draft arrancado, gestiona: "Posiciones en la mesa" (sólo lectura)');
ok(btn({ ...base, draftStarted: true, seating: cur }) === 'assignment', 'draft arrancado, los demás: "Asignación de lugares en la mesa"');
ok(btn({ ...base, draftStarted: true }) === 'none', 'draft arrancado sin sorteo: sin botón para los demás');
ok(btn({ ...base, canManage: true, draftStarted: true }) === 'none', 'draft arrancado o terminado SIN sorteo: tampoco hay botón para quien gestiona');
ok(seatingBlocksStart({ enabled: true, seating: null }) && seatingBlocksStart({ enabled: true, seating: stale }) && !seatingBlocksStart({ enabled: true, seating: cur }) && !seatingBlocksStart({ enabled: false, seating: null }), 'arrancar: bloqueado con toggle ON sin sorteo vigente; libre con toggle OFF');

// ── Modo de la pantalla ───────────────────────────────────────────────────────────────────────────────────────
const mode = (o) => seatingScreenMode({ canManage: false, hasPending: false, current: null, animating: false, ...o });
ok(mode({ animating: true, canManage: true }) === 'animating', 'animando');
ok(mode({ canManage: true, hasPending: true }) === 'pending', 'el organizador vuelve con un sorteo sin publicar: pendiente (estático, se publica)');
ok(mode({ hasPending: true, current: cur }) === 'current', 'los demás nunca ven el pendiente');
ok(mode({ current: cur }) === 'current' && mode({ current: cur, canManage: true }) === 'current', 'vigente: mesa estática');
ok(mode({ current: stale }) === 'stale' && mode({ current: stale, canManage: true }) === 'empty', 'obsoleto: aviso para los demás; mesa vacía para el organizador');
ok(mode({}) === 'empty', 'sin sorteo: mesa vacía');

// ── Personas ──────────────────────────────────────────────────────────────────────────────────────────────────
{
  const rows = [
    { id: 'p1', user_id: 'u1', role: 'player', left_event_at: null, member_b_user_id: null },
    { id: 'p2', user_id: 'u2', role: 'player', left_event_at: null, member_b_user_id: 'u3' },
    { id: 'p3', user_id: 'u4', role: 'ghost', left_event_at: null, member_b_user_id: null },
    { id: 'p4', user_id: 'u5', role: 'player', left_event_at: '2026-01-01', member_b_user_id: null },
  ];
  const p = seatingPersons(rows);
  ok(p.map((x) => `${x.participantId}${x.member}:${x.userId}`).join() === 'p1a:u1,p2a:u2,p2b:u3', 'personas: jugadores activos; el equipo 2HG aporta a su miembro B; ghost y retirados no');
}

// ── Ruleta ────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const d = rouletteDelays();
  const sum = d.reduce((a, b) => a + b, 0);
  ok(sum === 3000, `la ruleta dura ~3 s (${sum} ms en ${d.length} pasos)`);
  ok(d.every((x, i) => i === 0 || x >= d[i - 1]), 'las pausas crecen: arranca rápida y frena');
  for (const n of [2, 3, 5, 8, 16]) {
    let allPerm = true, endsOk = true;
    const steps = d.length;
    for (let step = 0; step <= steps; step += 1) {
      const seen = new Set(Array.from({ length: n }, (_, i) => rouletteSeat(i + 1, n, step, steps)));
      if (seen.size !== n || [...seen].some((s) => s < 1 || s > n)) allPerm = false;
    }
    for (let seat = 1; seat <= n; seat += 1) if (rouletteSeat(seat, n, steps, steps) !== seat) endsOk = false;
    ok(allPerm && endsOk, `n=${n}: en cada paso los lugares mostrados son una permutación y el último paso es el resultado real`);
  }
  ok(rouletteSeat(1, 4, 0, 5) !== 1 || rouletteSeat(2, 4, 0, 5) !== 2, 'al empezar los avatares están desplazados respecto del resultado');
}

// ── Cronómetro: sentidos y visibilidad ───────────────────────────────────────────────────────────────────────────
for (const first of ['cw', 'ccw']) {
  const other = first === 'cw' ? 'ccw' : 'cw';
  const seq = [1, 2, 3, 4, 5, 6].map((i) => timerVortexDirections(first, i));
  ok(seq.map((d) => d.packs).join() === [first, other, first, other, first, other].join(), `primer sentido ${first}: 🃏 alterna sobre a sobre (1=${first}, 2=${other}, 3=${first}...)`);
  ok(seq.every((d) => d.mate === (d.packs === 'cw' ? 'ccw' : 'cw') && d.cigar === d.mate), `primer sentido ${first}: 🧉 y 🚬 siempre opuestos a 🃏 en cada sobre`);
  ok(timerVortexDirections(first, 1).packs === first && timerVortexDirections(first, 1).mate === other, `sobre 1 con ${first}: 🃏 ${first}, 🧉/🚬 ${other}`);
}
ok(timerVortexDirections('cw', 0).packs === 'cw', 'sobre inválido (0) se trata como el sobre 1');
ok(timerIsActive('waiting') && timerIsActive('counting') && !timerIsActive('loading') && !timerIsActive('done') && !timerIsActive(''), 'cronómetro activo: waiting o counting; no loading ni done');
{
  const vis = (o) => timerVorticesVisible({ phase: 'counting', enabled: true, seating: cur, ...o });
  ok(vis({}) === true && vis({ phase: 'waiting' }) === true, 'visibles con cronómetro en curso + toggle + sorteo vigente');
  ok(vis({ phase: 'done' }) === false && vis({ phase: 'loading' }) === false, 'ocultos con el cronómetro finalizado o cargando');
  ok(vis({ enabled: false }) === false, 'ocultos con el toggle OFF');
  ok(vis({ seating: null }) === false && vis({ seating: undefined }) === false && vis({ seating: stale }) === false, 'ocultos sin sorteo vigente (nunca hubo, falló la lectura u obsoleto)');
  const spin = (o) => timerVorticesSpinning({ phase: 'counting', paused: false, focused: true, ...o });
  ok(spin({}) === true && spin({ paused: true }) === false && spin({ phase: 'waiting' }) === false && spin({ focused: false }) === false && spin({ phase: 'done' }) === false, 'giran sólo contando, sin pausa y con foco');
}

// ── Tamaño de los mini vórtices del cronómetro ───────────────────────────────────────────────────────────────────
{
  ok(TIMER_VORTEX_SIZE === 44 && TIMER_VORTEX_GAP === 6, 'mini vórtices de 44 px con 6 px de separación');
  const row = timerVorticesRowWidth();
  ok(row === 144, `la hilera mide 3 x 44 + 2 x 6 = ${row} px`);
  // Pantalla de 320 px: el cronómetro tiene 20 px de padding por lado (280 útiles) y "← Volver" ocupa ~90 px.
  ok(row + 90 <= 320 - 40, `entra en 320 px junto a "← Volver" (${row} + 90 <= 280)`);
}

// ── isDraftStarted y botones por estado del evento ───────────────────────────────────────────────────────────────
{
  const T = '2026-10-21T12:00:00Z';
  const started = (status, draft_started_at) => isDraftStarted({ status, draft_started_at });
  ok(started('scheduled', null) === false, 'scheduled sin draft_started_at: no arrancó');
  ok(started('scheduled', T) === true, 'scheduled con draft_started_at: arrancó (misma condición que la base)');
  for (const st of ['drafting', 'playing', 'completed', 'concluded']) {
    ok(started(st, T) === true && started(st, null) === true, `${st}: arrancó, con o sin draft_started_at`);
  }
  ok(started('playing', null) === true, 'playing con draft_started_at null (el caso del bug): ya arrancó');
  ok(started('cancelled', null) === true && started('cancelled', T) === true, 'cancelled no cuenta como "por arrancar" (sus botones se ocultan aparte)');
  ok(started(null, null) === false && started(undefined, undefined) === false, 'sin datos: no arrancó');

  // Botón que sale para cada combinación de estado x draft_started_at x rol x sorteo.
  const label = (o) => { const b = seatingButton(o); return b.kind === 'none' ? 'ninguno' : b.label; };
  const cases = [];
  for (const [status, dsa] of [['scheduled', null], ['scheduled', T], ['drafting', T], ['playing', T], ['playing', null], ['completed', T], ['completed', null], ['concluded', T], ['concluded', null]]) {
    for (const seating of [null, cur, stale]) {
      for (const canManage of [true, false]) {
        const draftStarted = isDraftStarted({ status, draft_started_at: dsa });
        cases.push({ status, dsa, seating, canManage, got: label({ enabled: true, canManage, draftStarted, seating }) });
      }
    }
  }
  const exp = (c) => {
    const startedNow = isDraftStarted({ status: c.status, draft_started_at: c.dsa });
    if (!startedNow) return c.canManage ? 'Sortear lugares en la mesa' : (c.seating ? 'Asignación de lugares en la mesa' : 'ninguno');
    if (!c.seating) return 'ninguno';
    return c.canManage ? 'Posiciones en la mesa' : 'Asignación de lugares en la mesa';
  };
  ok(cases.every((c) => c.got === exp(c)), `${cases.length} combinaciones estado x draft_started_at x rol x sorteo dan el botón esperado`);
  const find = (status, dsa, seating, canManage) => cases.find((c) => c.status === status && c.dsa === dsa && c.seating === seating && c.canManage === canManage).got;
  ok(find('playing', null, cur, true) === 'Posiciones en la mesa', 'organizador, playing con draft_started_at null y sorteo: "Posiciones en la mesa" (ya no "Sortear")');
  ok(find('completed', null, cur, true) === 'Posiciones en la mesa' && find('completed', T, cur, true) === 'Posiciones en la mesa', 'organizador, completed: "Posiciones en la mesa"');
  ok(find('concluded', null, cur, true) === 'Posiciones en la mesa', 'organizador, concluded: "Posiciones en la mesa"');
  ok(find('drafting', T, cur, true) === 'Posiciones en la mesa', 'organizador, drafting: "Posiciones en la mesa"');
  ok(find('completed', T, null, true) === 'ninguno' && find('playing', null, null, true) === 'ninguno', 'organizador, evento arrancado o terminado sin sorteo: ningún botón');
  ok(find('scheduled', null, null, true) === 'Sortear lugares en la mesa' && find('scheduled', null, cur, true) === 'Sortear lugares en la mesa', 'organizador, scheduled: "Sortear lugares en la mesa"');
  ok(find('scheduled', T, cur, true) === 'Posiciones en la mesa', 'organizador, scheduled con draft_started_at: ya arrancó -> "Posiciones en la mesa"');
  ok(find('playing', null, cur, false) === 'Asignación de lugares en la mesa' && find('completed', T, cur, false) === 'Asignación de lugares en la mesa' && find('drafting', T, stale, false) === 'Asignación de lugares en la mesa', 'jugador común con sorteo: "Asignación de lugares en la mesa" en cualquier estado');
  ok(find('completed', T, null, false) === 'ninguno' && find('scheduled', null, null, false) === 'ninguno', 'jugador común sin sorteo: ningún botón');
  ok(find('scheduled', null, stale, false) === 'Asignación de lugares en la mesa', 'jugador común con sorteo obsoleto: el botón no se oculta');
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

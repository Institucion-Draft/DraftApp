// node app/scripts/cup-reached.test.mjs
import { cupReachedInstance, cupReachedText } from '../src/lib/cupReachedInstance.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };

// Orden estándar de siembra para un cuadro de p (potencia de 2): cruces de primera ronda = (ord[2i], ord[2i+1])
function seedOrder(p) {
  let ord = [1];
  while (ord.length < p) {
    const n = ord.length * 2;
    ord = ord.flatMap((s) => [s, n + 1 - s]);
  }
  return ord;
}

/** Arma los slots de una Copa de n jugadores ('s1'..'sn'); gana el de menor seed salvo `wins` ('sA-sB' -> ganador). */
function cup(n, { wins = {}, pendingFinal = false, pendingThird = false } = {}) {
  const P = [4, 8, 16].find((x) => x >= n);
  const rounds = P === 16 ? ['round_of_16', 'quarter', 'semi', 'final'] : P === 8 ? ['quarter', 'semi', 'final'] : ['semi', 'final'];
  const ord = seedOrder(P);
  const id = (s) => (s <= n ? 's' + s : null);
  const slots = [];
  let cur = [];
  for (let i = 0; i < P / 2; i += 1) {
    const a = ord[2 * i];
    const b = ord[2 * i + 1];
    const bye = a > n || b > n;
    const real = a > n ? b : a;
    const sl = {
      round_key: rounds[0],
      participant_a_id: bye ? id(real) : id(a),
      participant_b_id: bye ? null : id(b),
      is_bye: bye,
      winner_participant_id: bye ? id(real) : null,
    };
    cur.push(sl);
    slots.push(sl);
  }
  const pick = (a, b) => {
    const forced = wins[a + '-' + b] ?? wins[b + '-' + a];
    if (forced) return forced;
    return Number(a.slice(1)) < Number(b.slice(1)) ? a : b;
  };
  const resolve = (sl) => {
    if (sl.winner_participant_id == null) sl.winner_participant_id = pick(sl.participant_a_id, sl.participant_b_id);
  };
  for (let r = 0; r < rounds.length; r += 1) {
    if (r > 0) {
      const next = [];
      for (let i = 0; i < cur.length / 2; i += 1) {
        const sl = { round_key: rounds[r], participant_a_id: null, participant_b_id: null, is_bye: false, winner_participant_id: null };
        next.push(sl);
        slots.push(sl);
      }
      cur.forEach((s, i) => {
        const target = next[Math.floor(i / 2)];
        if (i % 2 === 0) target.participant_a_id = s.winner_participant_id;
        else target.participant_b_id = s.winner_participant_id;
      });
      cur = next;
    }
    if (rounds[r] === 'final' && pendingFinal) break;
    for (const s of cur) if (!s.is_bye) resolve(s);
    if (rounds[r] === 'semi') {
      const losers = cur.map((s) => (s.winner_participant_id === s.participant_a_id ? s.participant_b_id : s.participant_a_id));
      const third = { round_key: 'third_place', participant_a_id: losers[0], participant_b_id: losers[1], is_bye: false, winner_participant_id: null };
      slots.push(third);
      if (!pendingThird) resolve(third);
    }
  }
  return slots;
}
const main = (slots) => ({ origin: 'knockout_bracket', slots });
const second = (slots) => ({ origin: 'knockout_second_chance', slots });
// Los helpers reales (cupPrimaName, CUP_CONSUELO_NAME, resolveGenderedText) se inyectan; acá van sus equivalentes.
const txt = (p, groups, isZones = false, o = { venueName: 'Quito' }) => {
  const r = cupReachedInstance({ participantId: p, groups, isZones });
  if (!r) return null;
  return cupReachedText(r, {
    mainName: o.venueName ? 'Copa ' + o.venueName : 'Copa',
    consueloName: 'Copa Consuelo',
    gendered: (m, f) => (o.gender === 'female' ? f : m),
  });
};

// Copa de 8
{
  const g = [main(cup(8))];
  const t = (p) => txt(p, g);
  ok(t('s1') === 'Campeón Copa Quito' && t('s2') === 'Subcampeón Copa Quito', 'Copa de 8: campeón y subcampeón (' + t('s1') + ' / ' + t('s2') + ')');
  ok(t('s3') === '3er puesto Copa Quito' && t('s4') === '4to puesto Copa Quito', 'Copa de 8: 3er y 4to puesto');
  ok(['s5', 's6', 's7', 's8'].every((p) => t(p) === 'Eliminado en cuartos de Copa Quito'), 'Copa de 8: los cuatro perdedores de cuartos');
}
// Copa de 7 (bye para el seed 1)
{
  const g = [main(cup(7))];
  const t = (p) => txt(p, g);
  ok(t('s1') === 'Campeón Copa Quito', 'Copa de 7: el jugador con bye llega a campeón');
  ok(['s5', 's6', 's7'].every((p) => t(p) === 'Eliminado en cuartos de Copa Quito'), 'Copa de 7: los tres perdedores de cuartos');
  const g2 = [main(cup(7, { wins: { 's1-s4': 's4', 's1-s3': 's3' } }))];
  ok(txt('s1', g2) === '4to puesto Copa Quito', 'Copa de 7: el bye que pierde la semifinal queda 4º por el partido por el 3er puesto (' + txt('s1', g2) + ')');
  const onlyBye = [main([{ round_key: 'quarter', participant_a_id: 's1', participant_b_id: null, is_bye: true, winner_participant_id: 's1' }])];
  ok(txt('s1', onlyBye) === 'En cuartos de Copa Quito', 'Copa de 7: el bye cuenta como haber alcanzado cuartos');
}
// Consuelo de 5 y de 6
{
  const g5 = [main(cup(8)), second(cup(5))];
  ok(txt('s5', [g5[1]]) === 'Eliminado en cuartos de Copa Consuelo', 'Consuelo de 5: el perdedor del único cuarto real (' + txt('s5', [g5[1]]) + ')');
  ok(txt('s1', [g5[1]]) === 'Campeón Copa Consuelo', 'Consuelo de 5: el campeón con bye (' + txt('s1', [g5[1]]) + ')');
  const g6 = [second(cup(6))];
  ok(['s5', 's6'].every((p) => txt(p, g6) === 'Eliminado en cuartos de Copa Consuelo'), 'Consuelo de 6: los dos perdedores de cuartos reales');
  ok(txt('s3', g6) === '3er puesto Copa Consuelo' && txt('s4', g6) === '4to puesto Copa Consuelo', 'Consuelo de 6: 3er y 4to puesto');
}
// jugador que no pasó a ninguna copa
{
  const g = [main(cup(8))];
  ok(txt('x9', g, true) === 'Fase de grupos', 'Grupos + Copa: jugador que no está en ninguna copa -> "Fase de grupos"');
  ok(txt('x9', g, false) === null, 'Copa sola: sin copa devuelve null (el llamador conserva su texto)');
}
// final y 3er puesto pendientes
{
  const g = [main(cup(8, { pendingFinal: true, pendingThird: true }))];
  const t = (p) => txt(p, g);
  ok(t('s1') === 'Finalista Copa Quito' && t('s2') === 'Finalista Copa Quito', 'final pendiente: finalistas');
  ok(t('s3') === 'Semifinalista Copa Quito' && t('s4') === 'Semifinalista Copa Quito', '3er puesto pendiente: "Semifinalista"');
  const g2 = [main(cup(8, { pendingThird: true }))];
  ok(txt('s1', g2) === 'Campeón Copa Quito' && txt('s3', g2) === 'Semifinalista Copa Quito', 'final resuelta y 3er puesto pendiente: campeón y semifinalistas');
}
// género y sin sede
{
  const g = [main(cup(8))];
  const f = { venueName: 'Quito', gender: 'female' };
  ok(txt('s1', g, false, f) === 'Campeona Copa Quito' && txt('s2', g, false, f) === 'Subcampeona Copa Quito' && txt('s5', g, false, f) === 'Eliminada en cuartos de Copa Quito', 'género femenino');
  ok(txt('s1', g, false, { venueName: null }) === 'Campeón Copa', 'sin sede: "Copa" a secas');
}
// Copa sola de 8, 9 y 12
{
  const g8 = [main(cup(8))];
  ok(txt('s1', g8) === 'Campeón Copa Quito' && txt('s8', g8) === 'Eliminado en cuartos de Copa Quito', 'Copa sola de 8');
  const g9 = [main(cup(9))];
  ok(txt('s9', g9) === 'Eliminado en octavos de Copa Quito' && txt('s8', g9) === 'Eliminado en cuartos de Copa Quito' && txt('s1', g9) === 'Campeón Copa Quito',
    'Copa sola de 9: perdedor del único octavo real, cuartos y campeón con bye');
  const g12 = [main(cup(12))];
  ok(['s9', 's10', 's11', 's12'].every((p) => txt(p, g12) === 'Eliminado en octavos de Copa Quito'), 'Copa sola de 12: los cuatro perdedores de octavos');
  ok(['s5', 's6', 's7', 's8'].every((p) => txt(p, g12) === 'Eliminado en cuartos de Copa Quito'), 'Copa sola de 12: los cuatro perdedores de cuartos');
  ok(txt('s3', g12) === '3er puesto Copa Quito' && txt('s4', g12) === '4to puesto Copa Quito' && txt('s2', g12) === 'Subcampeón Copa Quito', 'Copa sola de 12: podio y 4º');
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLAS`);
process.exit(fails === 0 ? 0 : 1);

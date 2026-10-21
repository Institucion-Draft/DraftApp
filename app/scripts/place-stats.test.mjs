// Tests de las estadísticas de cubo y sede (app/src/lib/placeStats.ts). node app/scripts/place-stats.test.mjs
import { rankPlayersByPoints, pickFirstEvent, podiumFromFinalPositions } from '../src/lib/placeStats.ts';
import { cubeSections, venueSections } from '../src/lib/placeStatsSections.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const names = new Map([['u1', 'Ana'], ['u2', 'Bruno'], ['u3', 'Carla'], ['u4', 'álvaro'], ['u5', 'Zoe']]);
const row = (u, e, position, points) => ({ user_id: u, event_id: e, position, points });

// Sin eventos / sin filas.
ok(rankPlayersByPoints([], names).length === 0, 'sin filas: lista vacía');
ok(pickFirstEvent([]) === null, 'sin eventos: no hay primer evento');
ok(podiumFromFinalPositions([], names).length === 0, 'sin posiciones: podio vacío');

// Un solo evento: ordena por puntos y respeta el límite.
{
  const r = rankPlayersByPoints([row('u1', 'e1', 1, 5), row('u2', 'e1', 2, 3), row('u3', 'e1', 3, 1)], names, { limit: 2 });
  ok(r.length === 2 && r[0].userId === 'u1' && r[1].userId === 'u2', 'un evento: top 2 por puntos');
  ok(r[0].points === 5 && r[0].firsts === 1 && r[0].events === 1, 'puntos, primeros puestos y eventos del líder');
}
// Acumulado de varios eventos.
{
  const rows = [row('u1', 'e1', 1, 5), row('u2', 'e1', 2, 3), row('u1', 'e2', 3, 1), row('u2', 'e2', 1, 5)];
  const r = rankPlayersByPoints(rows, names);
  ok(r[0].userId === 'u2' && r[0].points === 8 && r[1].userId === 'u1' && r[1].points === 6, 'varios eventos: suma los puntos');
}
// Desempates: puntos iguales -> más primeros puestos -> nombre.
{
  const rows = [
    row('u1', 'e1', 1, 5), row('u1', 'e2', 3, 1),            // u1: 6 pts, 1 primero
    row('u2', 'e1', 2, 3), row('u2', 'e2', 2, 3),            // u2: 6 pts, 0 primeros
    row('u3', 'e3', 2, 3), row('u3', 'e4', 2, 3),            // u3: 6 pts, 0 primeros
  ];
  const r = rankPlayersByPoints(rows, names);
  ok(r.map((x) => x.userId).join() === 'u1,u2,u3', 'empate de puntos: gana quien tiene más primeros puestos; luego orden alfabético (Bruno antes que Carla)');
  const rows2 = [row('u5', 'e1', 2, 4), row('u4', 'e2', 2, 4)];
  ok(rankPlayersByPoints(rows2, names).map((x) => x.userId).join() === 'u4,u5', 'alfabético sin distinguir acentos ni mayúsculas (álvaro antes que Zoe)');
}
// Sólo jugadores con puntos; filtro por eventos válidos (cancelados/borrados/no oficiales quedan afuera).
{
  const rows = [row('u1', 'e1', 1, 5), row('u2', 'e1', 4, 0), row('u3', 'eX', 1, 99)];
  const r = rankPlayersByPoints(rows, names, { eventIds: new Set(['e1']) });
  ok(r.length === 1 && r[0].userId === 'u1', 'sin puntos no entra; un evento fuera del conjunto válido no cuenta');
}
// Consuelo: las posiciones 1001+ suman puntos pero no cuentan como primer puesto.
{
  const r = rankPlayersByPoints([row('u1', 'e1', 1001, 3), row('u2', 'e1', 1002, 3), row('u2', 'e2', 3, 3)], names);
  ok(r[0].userId === 'u2' && r[0].points === 6, 'Consuelo suma puntos como el resto del ranking');
  const t = rankPlayersByPoints([row('u1', 'e1', 1001, 3), row('u2', 'e1', 1, 3)], names);
  ok(t[0].userId === 'u2' && t[0].firsts === 1 && t[1].firsts === 0, 'campeón de Consuelo (1001) no cuenta como primer puesto');
}
// Primer evento por scheduled_for.
{
  const evs = [
    { id: 'b', scheduled_for: '2026-03-02T20:00:00Z' }, { id: 'a', scheduled_for: '2026-01-10T20:00:00Z' },
    { id: 'c', scheduled_for: null }, { id: 'd', scheduled_for: '2026-01-10T20:00:00Z' },
  ];
  ok(pickFirstEvent(evs).id === 'a', 'primer evento: el más antiguo (empate por id, sin fecha al final)');
  ok(pickFirstEvent([{ id: 'z', scheduled_for: null }]).id === 'z', 'si ninguno tiene fecha igual elige uno');
}
// Podio.
{
  const p = podiumFromFinalPositions([
    { user_id: 'u3', position: 3 }, { user_id: 'u1', position: 1 }, { user_id: 'u2', position: 2 },
    { user_id: 'u4', position: 4 }, { user_id: 'u5', position: 1001 },
  ], names);
  ok(p.map((x) => `${x.position}:${x.userId}`).join() === '1:u1,2:u2,3:u3', 'podio 1-2-3 ordenado; 4° y Consuelo (1001) quedan fuera');
  const tie = podiumFromFinalPositions([{ user_id: 'u2', position: 3 }, { user_id: 'u3', position: 3 }, { user_id: 'u1', position: 1 }], names);
  ok(tie.map((x) => x.userId).join() === 'u1,u2,u3', 'empate en el 3°: comparten peldaño, ordenados por nombre');
  const dup = podiumFromFinalPositions([{ user_id: 'u1', position: 2 }, { user_id: 'u1', position: 1 }], names);
  ok(dup.length === 1 && dup[0].position === 1, 'un jugador repetido aparece una vez con su mejor puesto');
  const noName = podiumFromFinalPositions([{ user_id: 'zz', position: 1 }], names);
  ok(noName[0].name === 'Jugador', 'sin nombre conocido usa un respaldo');
}

// ── Secciones de la tarjeta: sin datos no hay nada; títulos; qué avatar usa cada fila ────────────────────────────────
{
  const ev = { id: 'e1', name: 'Draft de prueba', scheduled_for: '2026-01-10T20:00:00Z' };
  const total = { userId: 'u1', name: 'Ana', points: 12, firsts: 2, events: 3 };
  ok(cubeSections(null).length === 0, 'cubo sin cargar: sin secciones');
  ok(cubeSections({ firstEvent: null, firstPodium: [], topPlayer: null, eventsCount: 0 }).length === 0, 'cubo sin eventos oficiales: sin secciones (la tarjeta no se muestra)');
  ok(cubeSections({ firstEvent: ev, firstPodium: [], topPlayer: null, eventsCount: 1 }).length === 0, 'cubo con eventos pero sin podio ni puntos: sin secciones');
  ok(JSON.stringify(cubeSections({ firstEvent: null, firstPodium: [], topPlayer: null, eventsCount: 0 })).includes('Todavía') === false, 'no existe el texto "Todavía no hay eventos oficiales..."');
  const full = cubeSections({
    firstEvent: ev,
    firstPodium: [{ userId: 'u1', name: 'Ana', position: 1, participantId: 'p1' }, { userId: 'u2', name: 'Bruno', position: 2, participantId: null }],
    topPlayer: total, eventsCount: 3,
  });
  ok(full.map((s) => s.title).join('|') === 'Podio del primer evento de este cubo|Más puntos con este cubo', 'títulos del cubo');
  ok(full[0].subtitle.startsWith('Draft de prueba'), 'el podio del primer evento indica el evento');
  ok(full[0].rows[0].participantId === 'p1' && full[0].rows[1].participantId === null, 'podio del primer evento: lleva el participante de ESE evento (su Pokémon)');
  ok(full[1].rows.length === 1 && full[1].rows[0].participantId === undefined && full[1].rows[0].trailing === '12 pts', '"Más puntos con este cubo": Pokémon personal de la cuenta (sin participante de evento) y puntos');
  const podOnly = cubeSections({ firstEvent: ev, firstPodium: [{ userId: 'u1', name: 'Ana', position: 1, participantId: 'p1' }], topPlayer: null, eventsCount: 1 });
  ok(podOnly.length === 1, 'una sección sin filas no se arma');

  ok(venueSections(null).length === 0 && venueSections({ podium: [], eventsCount: 0 }).length === 0 && venueSections({ podium: [], eventsCount: 2 }).length === 0, 'sede sin eventos o sin puntos: sin secciones');
  const v = venueSections({ podium: [total, { ...total, userId: 'u2', name: 'Bruno', points: 9 }], eventsCount: 3 });
  ok(v.length === 1 && v[0].title === 'Podio de la sede' && v[0].rows.map((r) => r.position).join() === '1,2', 'sede: título y posiciones 1, 2');
  ok(v[0].rows.every((r) => r.participantId === undefined), 'podio de la sede: Pokémon personal de la cuenta (sin participante de evento)');
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

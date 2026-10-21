// Verifica contra la cadena REAL de migraciones (PGlite) que las consultas de las estadísticas de cubo y sede
// (app/src/lib/placeStatsApi.ts) devuelven lo esperado sobre las vistas EXISTENTES del ranking, sin migración nueva.
// Las consultas de abajo son el equivalente SQL de las del cliente; el orden/desempate lo hace el helper real
// (app/src/lib/placeStats.ts). Uso: cd supabase/tests && npm install && node place-stats.test.mjs
import { newDb, applyMigrations } from './harness.mjs';
import { rankPlayersByPoints, pickFirstEvent, podiumFromFinalPositions } from '../../app/src/lib/placeStats.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const fatal = (e) => { console.log('ERROR:', String(e && e.message).slice(0, 400)); process.exit(2); };
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

const uuid = (n) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const db = await newDb();
await applyMigrations(db);
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

// Usuarios, dos workspaces, cubos y sedes.
const names = ['Ana', 'Bruno', 'Carla', 'Dario', 'Eva'];
for (let i = 0; i < names.length; i += 1) {
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,$2,$3)`, [uuid(i + 1), `u${i}@x.com`, JSON.stringify({ display_name: names[i] })]);
}
await db.query(`insert into public.workspaces (name, slug, created_by) values ('W1','ws-one',$1),('W2','ws-two',$1)`, [uuid(1)]);
const [w1, w2] = (await q(`select id from public.workspaces order by slug`)).map((r) => r.id);
const mk = async (table, ws, name) => (await one(`insert into public.${table} (workspace_id, name, created_by) values ($1,$2,$3) returning id`, [ws, name, uuid(1)])).id;
const cubeA = await mk('cubes', w1, 'Cubo A');
const cubeEmpty = await mk('cubes', w1, 'Cubo vacío');
const venueS = await mk('venues', w1, 'Sede S');
const venueS2 = await mk('venues', w2, 'Sede S'); // mismo nombre en OTRO workspace
const venueEmpty = await mk('venues', w1, 'Sede vacía');
// Un cubo borrado con el MISMO nombre que el activo (soft delete) y un evento oficial en él.
const cubeOld = await mk('cubes', w1, 'Cubo A viejo');
await db.query(`update public.cubes set name = 'Cubo A', deleted_at = now() where id = $1`, [cubeOld]);

let n = 0;
// Evento round robin sin top, con campeón (la vía más simple para entrar al desglose de puntos del ranking).
const event = async ({ ws, cube = null, venue = null, champion, status = 'completed', official = true, deleted = false, date, players = [1, 2, 3, 4] }) => {
  n += 1;
  const ev = await one(
    `insert into public.draft_events (workspace_id, name, scheduled_for, created_by, event_organizer_user_id, cube_id, venue_id, competition_format, status, is_official, champion_user_id)
     values ($1,$2,$3,$4,$4,$5,$6,'round_robin',$7,$8,$9) returning id`,
    [ws, `evento ${n}`, date, uuid(1), cube, venue, status, official, champion ? uuid(champion) : null]);
  for (const u of players) await db.query(`insert into public.event_participants (event_id, user_id, role) values ($1,$2,'player')`, [ev.id, uuid(u)]);
  if (deleted) await db.query(`update public.draft_events set deleted_at = now() where id = $1`, [ev.id]);
  return ev.id;
};

// Las dos consultas del cliente, en SQL.
const eligible = (ws, col, id) => q(
  `select id, name, scheduled_for from public.draft_events where workspace_id=$1 and ${col}=$2 and is_official = true and deleted_at is null
   and event_type <> 'two_headed_giant' and status in ('completed','concluded') order by scheduled_for asc`, [ws, id]);
const breakdown = (ws, col, name) => q(`select user_id, event_id, position, points from public.v_workspace_points_breakdown where workspace_id=$1 and ${col}=$2`, [ws, name]);
const userNames = async () => new Map((await q(`select id, display_name from public.users`)).map((u) => [u.id, u.display_name]));
const stats = async (ws, kind, id, name) => {
  const evs = await eligible(ws, kind === 'cube' ? 'cube_id' : 'venue_id', id);
  const ids = new Set(evs.map((e) => e.id));
  const rows = await breakdown(ws, kind === 'cube' ? 'cube_name' : 'venue_name', name);
  const nm = await userNames();
  return { evs, rows, top: rankPlayersByPoints(rows, nm, { eventIds: ids }), first: pickFirstEvent(evs), nm };
};

// --- sin eventos ----------------------------------------------------------------------------------------------------------
{
  const s = await stats(w1, 'cube', cubeEmpty, 'Cubo vacío');
  ok(s.evs.length === 0 && s.top.length === 0 && s.first === null, 'cubo sin eventos: vacío');
  const v = await stats(w1, 'venue', venueEmpty, 'Sede vacía');
  ok(v.evs.length === 0 && v.top.length === 0, 'sede sin eventos: vacía');
}
// --- un solo evento ------------------------------------------------------------------------------------------------------------
const e1 = await event({ ws: w1, cube: cubeA, venue: venueS, champion: 1, date: '2026-01-10T20:00:00Z' });
{
  const s = await stats(w1, 'cube', cubeA, 'Cubo A');
  ok(s.evs.length === 1 && s.top.length >= 1 && s.top[0].userId === uuid(1) && s.top[0].points > 0, `un solo evento: lidera el campeón con puntos del ranking (${s.top[0]?.points} pts)`);
  const pos = await q(`select user_id, position from public.v_event_final_positions where event_id = $1`, [e1]);
  ok(pos.some((p) => p.user_id === uuid(1) && p.position === 1), 'v_event_final_positions trae al campeón como 1°');
  const pod = podiumFromFinalPositions(pos, s.nm);
  ok(pod[0]?.userId === uuid(1) && pod[0].position === 1, 'podio del primer evento: campeón en el 1° puesto');
}
// --- varios eventos: acumulado y primer evento = el más antiguo ----------------------------------------------------------------------
const e0 = await event({ ws: w1, cube: cubeA, venue: venueS, champion: 2, date: '2025-12-01T20:00:00Z' }); // el más antiguo
await event({ ws: w1, cube: cubeA, venue: venueS, champion: 2, date: '2026-02-01T20:00:00Z' });
{
  const s = await stats(w1, 'cube', cubeA, 'Cubo A');
  ok(s.evs.length === 3 && s.first.id === e0, 'primer evento = el de scheduled_for más antiguo');
  ok(s.top[0].userId === uuid(2) && s.top[0].events === 3 && s.top[0].firsts === 2 && s.top[0].points === 5 + 5 + 3, `líder acumulado: Bruno, 3 eventos, 2 victorias, ${s.top[0].points} pts`);
  const same = await one(`select count(distinct points)::int c from public.v_workspace_points_breakdown where workspace_id=$1 and position = 1`, [w1]);
  ok(same.c >= 1, 'los puntos salen del desglose existente (sin otro cálculo)');
}
// --- empate de puntos: mismo total, desempata el helper (primeros puestos, luego nombre) -----------------------------------
{
  const nm = await userNames();
  const tie = rankPlayersByPoints(
    [{ user_id: uuid(3), event_id: 'x', position: 2, points: 4 }, { user_id: uuid(1), event_id: 'y', position: 2, points: 4 }], nm);
  ok(tie[0].userId === uuid(1), 'empate de puntos sin primeros puestos: orden alfabético (Ana antes que Carla)');
}
// --- no cuentan: no oficial, cancelado, borrado ---------------------------------------------------------------------------------
await event({ ws: w1, cube: cubeA, venue: venueS, champion: 5, official: false, date: '2026-03-01T20:00:00Z' });
await event({ ws: w1, cube: cubeA, venue: venueS, champion: 5, status: 'cancelled', date: '2026-03-02T20:00:00Z' });
await event({ ws: w1, cube: cubeA, venue: venueS, champion: 5, deleted: true, date: '2026-03-03T20:00:00Z' });
{
  const s = await stats(w1, 'cube', cubeA, 'Cubo A');
  ok(s.evs.length === 3, 'no oficial / cancelado / borrado no son elegibles (siguen 3 eventos)');
  ok(!s.top.some((p) => p.userId === uuid(5)), 'Eva (campeona sólo de eventos que no cuentan) no suma puntos');
}
const rawCount = (s) => s.rows.filter((r) => s.evs.some((e) => e.id === r.event_id)).length;
// --- cubo borrado con el mismo nombre: no se mezcla ---------------------------------------------------------------------------------
await event({ ws: w1, cube: cubeOld, venue: venueS, champion: 4, date: '2025-11-01T20:00:00Z' });
{
  const s = await stats(w1, 'cube', cubeA, 'Cubo A');
  const raw = await breakdown(w1, 'cube_name', 'Cubo A');
  const dario = (rows, ids) => rankPlayersByPoints(rows, s.nm, ids ? { eventIds: ids } : {}).find((p) => p.userId === uuid(4));
  const valid = new Set(s.evs.map((e) => e.id));
  ok(raw.length > rawCount(s) && dario(raw).points > dario(raw, valid).points, `cubo borrado con el mismo nombre: el desglose por nombre lo mezcla (${dario(raw).points} pts) pero el filtro por ids de evento lo descarta (${dario(raw, valid).points} pts)`);
  ok(s.first.id === e0, 'ni el primer evento ni los totales se contaminan con el cubo borrado');
}
// --- sede con eventos en dos workspaces: no se mezclan ----------------------------------------------------------------------------------
await event({ ws: w2, venue: venueS2, champion: 3, date: '2026-01-05T20:00:00Z' });
{
  const a = await stats(w1, 'venue', venueS, 'Sede S');
  const b = await stats(w2, 'venue', venueS2, 'Sede S');
  const carla = (s) => s.top.find((p) => p.userId === uuid(3));
  ok(a.rows.every((r) => !b.evs.some((e) => e.id === r.event_id)) && b.rows.every((r) => !a.evs.some((e) => e.id === r.event_id)), 'el desglose por workspace + nombre de sede no mezcla eventos de los dos workspaces');
  ok(carla(a).points === 12 && carla(a).events === 4, `sede W1: Carla suma sólo sus 4 eventos de W1 (3 del cubo A + 1 del cubo viejo) (${carla(a).points} pts)`);
  ok(b.evs.length === 1 && b.top[0].userId === uuid(3) && b.top[0].points === 5 && b.top[0].events === 1, 'sede W2: sólo su propio evento (Carla campeona, 5 pts)');
}
// --- Copa Consuelo: forma de las filas que ya mezcla el desglose (posición 1000 + puesto) ------------------------------------------------
{
  const def = (await one(`select pg_get_viewdef('public.v_workspace_points_breakdown'::regclass, true) d`)).d;
  ok(/v_consuelo_positions/.test(def), 'el desglose existente ya incluye v_consuelo_positions (Copa Consuelo): se reutiliza sin tocar');
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

// Prueba (PGlite, cadena REAL 0001-0148 + 0152, 0153 y 0157) de los scripts de supabase/manual_ops/copiar_datos_de_draft:
// copia de tiempo de draft, cronómetro y sorteo de lugares de un evento FALLIDO a uno BUENO, con abortos, respaldo y rollback.
// Uso: cd supabase/tests && npm install && node copy-draft-data.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { newDb, applyMigrations, MIGRATIONS_DIR } from './harness.mjs';

let fails = 0;
const ok = (c, m, extra) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m + (extra !== undefined && !c ? '  -> ' + JSON.stringify(extra) : '')); };
const fatal = (e) => { console.log('ERROR:', String(e && e.message).slice(0, 500)); process.exit(2); };
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
const uuid = (n) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const OPS = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'manual_ops', 'copiar_datos_de_draft');
const read = (f) => fs.readFileSync(path.join(OPS, f), 'utf8').replace(/\r\n/g, '\n');

const db = await newDb();
await applyMigrations(db, { to: 148 });
for (const n of ['0152', '0153', '0157']) {
  const f = fs.readdirSync(MIGRATIONS_DIR).find((x) => x.startsWith(n));
  await db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
}
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

// --- datos ------------------------------------------------------------------------------------------------------------------------------
const nombres = ['Ana', 'Beto', 'Cami', 'Dani', 'Eva'];
for (let i = 1; i <= 5; i += 1) await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,$2,$3)`, [uuid(i), `u${i}@x.com`, JSON.stringify({ display_name: nombres[i - 1] })]);
await db.query(`insert into public.workspaces (name, slug, created_by) values ('W1','ws-one',$1),('W2','ws-two',$1)`, [uuid(1)]);
const [w1, w2] = (await q(`select id from public.workspaces order by slug`)).map((r) => r.id);
await db.query(`select public.ensure_workspace_seasons($1)`, [w1]);
const mkEvent = async ({ ws = w1, name, comp, fmt = 'bo3', start, end, status = 'scheduled', rse = false }) =>
  (await one(`insert into public.draft_events (workspace_id, name, scheduled_for, created_by, event_organizer_user_id, competition_format, match_format, status, is_official, draft_started_at, draft_ended_at, random_seating_enabled)
     values ($1,$2,'2026-10-10 18:00:00-03',$3,$3,$4,$5,$6,true,$7,$8,$9) returning id`, [ws, name, uuid(1), comp, fmt, status, start, end, rse])).id;
const part = async (ev, user) => (await one(`insert into public.event_participants (event_id, user_id, role) values ($1,$2,'player') returning id`, [ev, uuid(user)])).id;

// FALLIDO: tipo equivocado (suizo), con sorteo de lugares y cronómetro. Se crea sin draft para poder cargar el sorteo (el trigger exige uno vigente).
const F = await mkEvent({ name: 'Evento FALLIDO', comp: 'swiss', fmt: 'bo3', start: null, end: null, rse: true });
const fpid = {}; for (const u of [1, 2, 3, 4]) fpid[u] = await part(F, u);
const seatsF = [3, 1, 4, 2].map((u, i) => ({ seat: i + 1, participant_id: fpid[u], member: 'a', user_id: uuid(u) }));
await db.query(`insert into public.event_seating (event_id, n, direction, seats, drawn_by, drawn_at, published_at, is_current) values ($1, 4, 'ccw', $2::jsonb, $3, '2026-10-10 19:50:00-03', '2026-10-10 19:51:00-03', true)`, [F, JSON.stringify(seatsF), uuid(1)]);
await db.query(`update public.draft_events set draft_started_at = '2026-10-10 20:00:00-03', draft_ended_at = '2026-10-10 21:15:00-03', status = 'playing',
  is_timed_draft = true, timer_packs = '{15,15,14}', timer_alpha = 1.5, timer_beta = 2, timer_gamma = 0.5, timer_delta = 3, timer_rho = 0.25, timer_tmin = 20, timer_tmax = 90, timer_color = 'red' where id = $1`, [F]);
for (let i = 1; i <= 5; i += 1) await db.query(`insert into public.draft_timer_logs (event_id, global_pick, pack_index, pick_in_pack, estimated_seconds, actual_seconds, created_at) values ($1,$2,$3,$4,$5,$6,'2026-10-10 20:10:00-03')`, [F, i, 1, i, 40 + i, 30 + i * 3]);

// BUENO: tipo correcto (todos contra todos, BO3), draft "rápido" más tarde, con sus propios logs y una partida jugada.
const G = await mkEvent({ name: 'Evento BUENO', comp: 'round_robin', fmt: 'bo3', start: '2026-10-10 23:30:00-03', end: '2026-10-10 23:42:00-03', status: 'playing' });
const gpid = {}; for (const u of [1, 2, 3, 4]) gpid[u] = await part(G, u);
for (let i = 1; i <= 2; i += 1) await db.query(`insert into public.draft_timer_logs (event_id, global_pick, pack_index, pick_in_pack, estimated_seconds, actual_seconds) values ($1,$2,1,$2,10,5)`, [G, i]);
const [lo, hi] = gpid[1] < gpid[2] ? [gpid[1], gpid[2]] : [gpid[2], gpid[1]];
const pr = (await one(`insert into public.pairings (event_id, participant_a_id, participant_b_id) values ($1,$2,$3) returning id`, [G, lo, hi])).id;
await db.query(`insert into public.matches (pairing_id, match_number, match_type, status, started_at) values ($1,1,'draft','in_progress','2026-10-10 23:50:00-03')`, [pr]);

const snapG = async () => ({
  ev: await one(`select name, event_type, competition_format, match_format, status, scheduled_for, draft_started_at, draft_ended_at, is_timed_draft, timer_packs, timer_color, random_seating_enabled from public.draft_events where id = $1`, [G]),
  logs: await q(`select id, global_pick, actual_seconds from public.draft_timer_logs where event_id = $1 order by id`, [G]),
  seating: await q(`select * from public.event_seating where event_id = $1`, [G]),
  matches: (await one(`select count(*)::int n from public.matches m join public.pairings p on p.id = m.pairing_id where p.event_id = $1`, [G])).n,
});
const original = JSON.stringify(await snapG());
const fixIds = (sql, f = F, g = G) => sql.split('PEGAR-ID-DEL-EVENTO-FALLIDO').join(f).split('PEGAR-ID-DEL-EVENTO-BUENO').join(g);
const copiar = read('02_copiar_fallido_a_bueno.sql');
const attempt = async (sql) => { try { await db.exec(sql); return null; } catch (e) { try { await db.exec('rollback'); } catch { /* sin transacción abierta */ } return e.message; } };

// --- abortos (ANTES de la copia buena: confirman que no queda nada aplicado ni el respaldo) -------------------------------------------------
let err = await attempt(copiar);
ok(err && /uuid/.test(err), 'sin reemplazar los ids de ejemplo el script falla (no copia nada)', err);
err = await attempt(fixIds(copiar, F, F));
ok(err && /MISMO id/.test(err), 'ids iguales: aborta', err);
await db.query(`insert into public.event_participants (event_id, user_id, role) values ($1,$2,'player')`, [G, uuid(5)]);
err = await attempt(fixIds(copiar));
ok(err && /NO coinciden/.test(err) && /Eva/.test(err) && /solo en el BUENO/.test(err), 'participante de más en el bueno: aborta mostrando quién y dónde', err);
await db.query(`delete from public.event_participants where event_id = $1 and user_id = $2`, [G, uuid(5)]);
await db.query(`delete from public.event_participants where event_id = $1 and user_id = $2`, [G, uuid(4)]);
err = await attempt(fixIds(copiar));
ok(err && /Dani/.test(err) && /solo en el FALLIDO/.test(err), 'participante que falta en el bueno: aborta mostrando quién', err);
gpid[4] = await part(G, 4);
await db.query(`update public.draft_events set workspace_id = $2 where id = $1`, [G, w2]);
err = await attempt(fixIds(copiar));
ok(err && /workspaces distintos/.test(err), 'workspaces distintos: aborta', err);
await db.query(`update public.draft_events set workspace_id = $2 where id = $1`, [G, w1]);
await db.exec(`alter table public.draft_events disable trigger trg_seating_enforce_before_start`);
await db.query(`update public.draft_events set draft_started_at = null where id = $1`, [F]);
err = await attempt(fixIds(copiar));
ok(err && /no tiene draft_started_at/.test(err), 'fallido sin draft_started_at: aborta', err);
await db.query(`update public.draft_events set draft_started_at = '2026-10-10 20:00:00-03' where id = $1`, [F]);
await db.query(`update public.draft_events set draft_started_at = '2027-01-05 20:00:00-03', draft_ended_at = '2027-01-05 20:30:00-03' where id = $1`, [G]);
err = await attempt(fixIds(copiar));
ok(err && /OTRA temporada/.test(err), 'el nuevo draft_started_at cambiaría de temporada al bueno: aborta', err);
await db.query(`update public.draft_events set draft_started_at = '2026-10-10 23:30:00-03', draft_ended_at = '2026-10-10 23:42:00-03' where id = $1`, [G]);
await db.exec(`alter table public.draft_events enable trigger trg_seating_enforce_before_start`);
err = await attempt(fixIds(copiar).replace('true                                as reemplazar_logs_y_sorteo_del_bueno', 'false                               as reemplazar_logs_y_sorteo_del_bueno'));
ok(err && /ya tiene/.test(err), 'con logs propios en el bueno y reemplazar = false: aborta', err);
ok(JSON.stringify(await snapG()) === original, 'tras todos los abortos el bueno quedó EXACTAMENTE como estaba');
ok((await one(`select to_regclass('admin_private.event_copy_backup') is null n`)).n === true, 'y no quedó ni la tabla de respaldo (todo se deshizo)');
ok((await one(`select tgenabled from pg_trigger where tgname = 'trg_seating_enforce_before_start'`)).tgenabled === 'O', 'el trigger del sorteo sigue activo');

// --- copia buena -------------------------------------------------------------------------------------------------------------------------------
err = await attempt(fixIds(copiar));
ok(err === null, 'la copia corre sin errores (una sola transacción)', err);
const g = await one(`select * from public.draft_events where id = $1`, [G]);
const f = await one(`select * from public.draft_events where id = $1`, [F]);
const iso = (d) => new Date(d).toISOString();
ok(iso(g.draft_started_at) === iso(f.draft_started_at) && iso(g.draft_ended_at) === iso(f.draft_ended_at), 'tiempo de draft copiado (inicio y fin)');
ok(g.is_timed_draft === true && JSON.stringify(g.timer_packs) === JSON.stringify([15, 15, 14]) && Number(g.timer_alpha) === 1.5 && Number(g.timer_beta) === 2
   && Number(g.timer_gamma) === 0.5 && Number(g.timer_delta) === 3 && Number(g.timer_rho) === 0.25 && g.timer_tmin === 20 && g.timer_tmax === 90 && g.timer_color === 'red', 'columnas del cronómetro copiadas');
const logsG = await q(`select global_pick, pack_index, pick_in_pack, estimated_seconds, actual_seconds from public.draft_timer_logs where event_id = $1 order by global_pick`, [G]);
const logsF = await q(`select global_pick, pack_index, pick_in_pack, estimated_seconds, actual_seconds from public.draft_timer_logs where event_id = $1 order by global_pick`, [F]);
ok(logsG.length === 5 && JSON.stringify(logsG) === JSON.stringify(logsF), 'los 5 logs del cronómetro copiados; los 2 propios del "draft rápido" se reemplazaron');
const seatG = await one(`select * from public.event_seating where event_id = $1`, [G]);
ok(seatG && seatG.n === 4 && seatG.direction === 'ccw' && seatG.is_current === true, 'sorteo de lugares copiado (n, sentido, vigente)');
const seatsG = seatG.seats;
ok(seatsG.map((s) => s.user_id).join() === [3, 1, 4, 2].map(uuid).join() && seatsG.map((s) => s.seat).join() === '1,2,3,4', 'mismo orden de asientos y de usuarios');
ok(seatsG.every((s) => Object.values(gpid).includes(s.participant_id)) && seatsG.every((s) => !Object.values(fpid).includes(s.participant_id)), 'cada asiento apunta a la inscripción del BUENO (remapeo por user_id), ninguno a la del fallido');
ok(seatsG.every((s) => gpid[Number(parseInt(s.user_id.slice(0, 8), 16))] === s.participant_id), 'y es la inscripción del MISMO usuario');
ok(g.random_seating_enabled === true, 'random_seating_enabled del bueno pasó a true (la app solo muestra la mesa con el toggle)');
ok((await one(`select tgenabled from pg_trigger where tgname = 'trg_seating_enforce_before_start'`)).tgenabled === 'O', 'el trigger trg_seating_enforce_before_start quedó activo');
ok(g.name === 'Evento BUENO' && g.competition_format === 'round_robin' && g.match_format === 'bo3' && g.status === 'playing' && iso(g.scheduled_for) === iso(f.scheduled_for) && g.event_type === 'draft', 'lo propio del bueno no se tocó (nombre, tipo de competición, formato, estado)');
ok((await snapG()).matches === 1, 'las partidas del bueno siguen intactas');
const fAfter = await one(`select name, draft_started_at, status, competition_format, random_seating_enabled from public.draft_events where id = $1`, [F]);
ok(fAfter.competition_format === 'swiss' && fAfter.status === 'playing' && (await q(`select 1 from public.event_seating where event_id = $1`, [F])).length === 1 && (await q(`select 1 from public.draft_timer_logs where event_id = $1`, [F])).length === 5, 'el FALLIDO no se modificó (se copia, no se mueve)');
const bk = await q(`select tabla, count(*)::int n from admin_private.event_copy_backup group by tabla order by tabla`);
ok(JSON.stringify(bk) === JSON.stringify([{ tabla: 'draft_events', n: 1 }, { tabla: 'draft_timer_logs', n: 2 }]), 'respaldo en admin_private: la fila del evento bueno y sus 2 logs originales (no tenía sorteo)', bk);
const priv = await one(`select has_table_privilege('anon','admin_private.event_copy_backup','select') a, has_table_privilege('authenticated','admin_private.event_copy_backup','select') b`);
ok(!priv.a && !priv.b, 'el respaldo no es legible por anon ni authenticated');
ok((await one(`select count(*)::int n from public.audit_log where table_name = 'draft_events' and record_id = $1`, [G]).catch(() => ({ n: -1 }))).n !== 0, 'la auditoría registró el cambio (informativo)');

// --- verificación lado a lado (03) y diagnóstico (04) ------------------------------------------------------------------------------------------
const ver = await q(fixIds(read('03_verificar.sql')).replace(/;\s*$/, ''));
ok(ver.length > 20 && ver.every((r) => r.ok === true), `03_verificar: ${ver.length} filas y todas ok = true`, ver.filter((r) => r.ok !== true));
ok(ver.some((r) => r.campo === 'asiento 01') && ver.some((r) => r.seccion === 'propio del bueno (sin tocar)' && r.campo === 'competition_format'), '03 muestra los asientos lado a lado y lo propio del bueno contra el respaldo');
const diag = await q(fixIds(read('04_diagnostico_evento_fallido.sql')).replace(/;\s*$/, ''));
ok(diag.length === 15 && diag[0].valor.includes('Evento FALLIDO'), '04_diagnostico corre (solo lectura) y devuelve los 15 conceptos');
const idEv = await q(read('01_identificar_eventos.sql').replace(/;\s*$/, ''));
ok(idEv.some((r) => r.evento_id === F && r.logs_cronometro === 5 && r.sorteo_vigente === true) && idEv.some((r) => r.evento_id === G), '01_identificar lista ambos eventos con jugadores, partidas, logs y sorteo');

// --- rollback (se descomenta el bloque marcado) ------------------------------------------------------------------------------------------------------
const rb = (() => {
  const s = read('02_copiar_fallido_a_bueno.sql');
  const a = s.indexOf('-- >>> ROLLBACK\n') + '-- >>> ROLLBACK\n'.length;
  const b = s.indexOf('-- <<< ROLLBACK');
  return s.slice(a, b).split('\n').map((l) => l.replace(/^-- ?/, '')).join('\n');
})();
err = await attempt(fixIds(rb));
ok(err === null, 'el rollback corre sin errores', err);
ok(JSON.stringify(await snapG()) === original, 'tras el rollback el bueno quedó EXACTAMENTE como antes (tiempos, cronómetro, logs con sus ids originales, sin sorteo)');
ok((await one(`select tgenabled from pg_trigger where tgname = 'trg_seating_enforce_before_start'`)).tgenabled === 'O', 'y el trigger sigue activo');
// copiar dos veces y volver: el rollback usa la PRIMERA copia (la más antigua) -> estado original
await db.exec('rollback').catch(() => {});
ok((await attempt(fixIds(copiar))) === null && (await attempt(fixIds(copiar))) === null, 'la copia se puede correr de nuevo (dos veces seguidas)');
ok((await attempt(fixIds(rb))) === null && JSON.stringify(await snapG()) === original, 'con dos copias hechas, el rollback igual devuelve el estado original (usa el respaldo más antiguo)');

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

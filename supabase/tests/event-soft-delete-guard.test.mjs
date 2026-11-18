// Tests de la migración 0164 (eliminar un evento cancelado: RPC + guardia de servidor) contra PGlite con la cadena REAL de migraciones 0001-0148.
// (0149 en adelante no aplica en PGlite desde cero; la 0164 solo depende de draft_events, can_manage_event e is_workspace_organizer.)
// Uso: cd supabase/tests && npm install && node event-soft-delete-guard.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { newDb, applyMigrations, MIGRATIONS_DIR } from './harness.mjs';

let fails = 0;
const ok = (c, m, x) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m + (!c && x ? ' ' + JSON.stringify(x) : '')); };
const fatal = (e) => { console.log('ERROR:', String(e && e.message).slice(0, 400)); process.exit(2); };
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
const uuid = (n) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

const db = await newDb();
await db.exec('alter default privileges in schema public grant all on tables to anon, authenticated, service_role');
await applyMigrations(db, { to: 148 });
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

// --- datos: ws1 (U1 organizador, U2 member con la posta de los eventos "P", U4 y U5 members sin esa posta), ws2 (U3 organizador) ---------------
for (let i = 1; i <= 5; i += 1) await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,$2,'{}')`, [uuid(i), `u${i}@x.com`]);
await db.query(`insert into public.workspaces (name, slug, created_by) values ('W1','ws-one',$1)`, [uuid(1)]);
await db.query(`insert into public.workspaces (name, slug, created_by) values ('W2','ws-two',$1)`, [uuid(3)]);
const ws = (await one(`select id from public.workspaces where slug='ws-one'`)).id;
await db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'member'),($1,$3,'member'),($1,$4,'member')`, [ws, uuid(2), uuid(4), uuid(5)]);
const mkEvent = async (name, status, official, posta = uuid(2)) => (await one(
  `insert into public.draft_events (workspace_id, name, scheduled_for, created_by, event_organizer_user_id, status, is_official)
   values ($1,$2,now(),$3,$3,$4,$5) returning id`, [ws, name, posta, status, official])).id;
const withMatch = async (ev) => {
  const a = (await one(`insert into public.event_participants (event_id, user_id, role) values ($1,$2,'player') returning id`, [ev, uuid(2)])).id;
  const b = (await one(`insert into public.event_participants (event_id, user_id, role) values ($1,$2,'player') returning id`, [ev, uuid(4)])).id;
  const pair = (await one(`insert into public.pairings (event_id, participant_a_id, participant_b_id) values ($1, least($2::uuid,$3::uuid), greatest($2::uuid,$3::uuid)) returning id`, [ev, a, b])).id;
  await db.query(`insert into public.matches (pairing_id, match_number, status) values ($1,1,'in_progress')`, [pair]);
};
const eNoOf  = await mkEvent('cancelado no oficial', 'cancelled', false);
const eNoOf2 = await mkEvent('cancelado no oficial con partidas', 'cancelled', false); await withMatch(eNoOf2);
const eOfSin = await mkEvent('cancelado oficial sin partidas', 'cancelled', true);
const eOfCon = await mkEvent('cancelado oficial con partidas', 'cancelled', true); await withMatch(eOfCon);
const eProg  = await mkEvent('programado no oficial', 'scheduled', false);
const eJuego = await mkEvent('en juego oficial con partidas', 'playing', true); await withMatch(eJuego);
const eOtro  = await mkEvent('cancelado, posta de otro', 'cancelled', false, uuid(5));   // la posta es U5, no U2
const eCan2  = await mkEvent('cancelado para probar campos', 'cancelled', false);
const eOrg   = await mkEvent('cancelado del organizador', 'cancelled', true, uuid(1));
const eOrg2  = await mkEvent('programado del organizador', 'scheduled', true, uuid(1));
const eOrg3  = await mkEvent('cancelado oficial con partidas (posta U2, lo borra el organizador)', 'cancelled', true); await withMatch(eOrg3);

// --- aplicar la 0164 (dos veces: idempotente) -------------------------------------------------------------------------------------------------------
const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '0164_eliminar_evento_cancelado.sql'), 'utf8');
ok(sql.includes('Get-Content -Raw -Encoding UTF8'), 'el encabezado indica copiar con Get-Content -Raw -Encoding UTF8 | Set-Clipboard');
ok(!/Ã/.test(sql.replace(/^--.*$/gm, '')), 'el SQL ejecutable no tiene mojibake');
ok(/NO CORRER/.test(sql), 'el rollback está marcado "NO CORRER"');
await db.exec(sql);
await db.exec(sql);
ok(true, '0164 aplica dos veces sin errores (idempotente)');
ok((await one(`select count(*)::int n from pg_trigger where tgrelid='public.draft_events'::regclass and tgname='draft_events_guard_soft_delete_trg' and not tgisinternal`)).n === 1, 'un solo trigger de guardia');
const priv = await one(`select has_function_privilege('anon','public.draft_events_guard_soft_delete()','execute') a, has_function_privilege('authenticated','public.draft_events_guard_soft_delete()','execute') b,
  has_function_privilege('anon','public.soft_delete_cancelled_event(uuid)','execute') c, has_function_privilege('authenticated','public.soft_delete_cancelled_event(uuid)','execute') d`);
ok(!priv.a && !priv.b, 'la función del trigger no es ejecutable por anon ni authenticated');
ok(!priv.c && priv.d, 'el RPC nuevo lo ejecuta authenticated y no anon');
const defs = await q(`select proname, prosecdef, proconfig from pg_proc where proname in ('draft_events_guard_soft_delete','soft_delete_cancelled_event')`);
ok(defs.length === 2 && defs.every((d) => d.prosecdef && (d.proconfig ?? []).some((c) => c.startsWith('search_path='))), 'ambas SECURITY DEFINER con search_path fijo', defs);

// --- helpers ---------------------------------------------------------------------------------------------------------------------------------------------
await db.exec(`grant usage on schema public to authenticated, anon;`);
const asUser = async (n, fn) => {
  await db.exec(`select set_config('request.jwt.claim.sub', '${uuid(n)}', false); select set_config('request.jwt.claim.role', 'authenticated', false); set role authenticated;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
};
// Camino real de la posta: el RPC nuevo. Lanza si el permiso o el trigger lo rechazan.
const del = (n, ev) => asUser(n, async () => { await db.query(`select public.soft_delete_cancelled_event($1)`, [ev]); return 1; });
// UPDATE directo (sin RETURNING): el trigger corre ANTES que la RLS, así que sus rechazos se ven; si lo deja pasar, la RLS rechaza la fila ya oculta.
const delRaw = (n, ev, extra = '') => asUser(n, async () => (await db.query(`update public.draft_events set deleted_at = now() ${extra} where id = $1`, [ev])).affectedRows ?? 0);
const deleted = async (ev) => (await one(`select deleted_at is not null as d from public.draft_events where id = $1`, [ev])).d;
const fail = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// --- la posta (member, no organizador) ---------------------------------------------------------------------------------------------------------------------
ok((await del(2, eNoOf)) === 1 && (await deleted(eNoOf)), 'la posta puede eliminar un evento CANCELADO no oficial');
ok((await del(2, eNoOf2)) === 1 && (await deleted(eNoOf2)), 'y uno cancelado no oficial CON partidas (no es oficial: no afecta estadísticas)');
ok((await del(2, eOfSin)) === 1 && (await deleted(eOfSin)), 'la posta puede eliminar un cancelado OFICIAL sin partidas');
let err = await fail(() => del(2, eOfCon));
ok(err && /solo lo puede eliminar el organizador/.test(err.message) && !(await deleted(eOfCon)), 'la posta NO puede eliminar un cancelado oficial CON partidas', err?.message);
err = await fail(() => del(2, eOrg3));
ok(err && /solo lo puede eliminar el organizador/.test(err.message) && !(await deleted(eOrg3)), 'idem (segundo caso, con partidas de gigantes o no)');
err = await fail(() => del(2, eProg));
ok(err && /Solo se puede eliminar un evento cancelado/.test(err.message) && !(await deleted(eProg)), 'la posta NO puede eliminar un evento sin cancelar (programado)', err?.message);
err = await fail(() => del(2, eJuego));
ok(err && /cancelado/.test(err.message) && !(await deleted(eJuego)), 'ni uno en juego (oficial con partidas)');
// cancelar y eliminar en el mismo UPDATE no sirve para saltear el requisito
err = await fail(() => delRaw(2, eProg, ", status = 'cancelled', cancelled_at = now()"));
ok(err && !(await deleted(eProg)) && (await one(`select status from public.draft_events where id=$1`, [eProg])).status === 'scheduled', 'tampoco cancelando y eliminando en el mismo UPDATE (queda intacto)', err?.message);
// otros campos en el mismo UPDATE
err = await fail(() => delRaw(2, eCan2, ", notes = 'x'"));
ok(err && /otros datos/.test(err.message) && !(await deleted(eCan2)) && (await one(`select notes from public.draft_events where id=$1`, [eCan2])).notes === null, 'eliminar no puede modificar otros campos (notes) por esa vía', err?.message);
err = await fail(() => delRaw(2, eCan2, ", name = 'otro'"));
ok(err && /otros datos/.test(err.message) && !(await deleted(eCan2)), 'ni el nombre');
// la posta de OTRO evento, un member sin posta, y otro workspace: sin permiso
err = await fail(() => del(2, eOtro));
ok(err && /No tenés permiso/.test(err.message) && !(await deleted(eOtro)), 'la posta de un evento NO elimina el de otra persona', err?.message);
err = await fail(() => del(4, eCan2));
ok(err && /No tenés permiso/.test(err.message) && !(await deleted(eCan2)), 'un member SIN la posta NO puede eliminar', err?.message);
err = await fail(() => del(4, eNoOf2));
ok(err && /No se encontró|No tenés permiso/.test(err.message), 'tampoco un evento donde juega pero no tiene la posta');
err = await fail(() => del(3, eCan2));
ok(err && /No tenés permiso/.test(err.message) && !(await deleted(eCan2)), 'un organizador de OTRO workspace no puede', err?.message);
err = await fail(() => asUser(2, async () => { await db.query(`select public.soft_delete_cancelled_event($1)`, [eNoOf]); }));
ok(err && /No se encontró/.test(err.message), 'un evento ya eliminado: "no se encontró" (no se elimina dos veces)', err?.message);
// el UPDATE directo de un member sin posta: la RLS (can_manage_event) no le deja tocar la fila
ok((await delRaw(4, eCan2)) === 0 && !(await deleted(eCan2)), 'UPDATE directo de un member sin posta: 0 filas (RLS)');
// sin sesión (se limpian los claims que dejó el usuario anterior)
await db.exec("select set_config('request.jwt.claim.sub', '', false)");
err = await fail(async () => { await db.query(`select public.soft_delete_cancelled_event($1)`, [eCan2]); });
ok(err && /iniciar sesión/.test(err.message) && !(await deleted(eCan2)), 'sin sesión (sin usuario) el RPC no elimina', err?.message);
// el UPDATE directo, aun de la posta, no es un camino: la RLS rechaza la fila oculta (por eso existe un RPC)
err = await fail(() => delRaw(2, eCan2));
ok(err && /row-level security/i.test(err.message) && !(await deleted(eCan2)), 'el UPDATE directo de deleted_at no funciona para un cliente (RLS de lectura): el camino es el RPC', err?.message);
// otras actualizaciones de la posta no se ven afectadas
await asUser(2, async () => { await db.query(`update public.draft_events set notes = 'hola' where id = $1`, [eProg]); });
ok((await one(`select notes from public.draft_events where id=$1`, [eProg])).notes === 'hola', 'las demás ediciones de la posta (sin deleted_at) siguen funcionando');
await asUser(2, async () => { await db.query(`update public.draft_events set status = 'cancelled', cancelled_at = now() where id = $1`, [eProg]); });
ok((await one(`select status from public.draft_events where id=$1`, [eProg])).status === 'cancelled', 'la posta puede cancelar (como hoy)');
ok((await del(2, eProg)) === 1 && (await deleted(eProg)), 'y después de cancelar, eliminar');

// --- el organizador del workspace conserva lo que ya podía (por el RPC nuevo y por cualquier definer: el trigger no le pone requisitos) ---------------
ok((await del(1, eOrg)) === 1 && (await deleted(eOrg)), 'el organizador elimina un cancelado oficial');
ok((await del(1, eOfCon)) === 1 && (await deleted(eOfCon)), 'el organizador elimina un cancelado OFICIAL CON partidas (lo que la posta no puede)');
ok((await del(1, eOrg3)) === 1 && (await deleted(eOrg3)), 'idem con el otro oficial con partidas');
ok((await del(1, eOrg2)) === 1 && (await deleted(eOrg2)), 'el organizador elimina un evento sin cancelar (sin requisito nuevo: no se rompe nada)');
ok((await del(1, eJuego)) === 1 && (await deleted(eJuego)), 'y uno en juego oficial con partidas');
// el trigger no frena al organizador ni siquiera con otros campos: lo único que lo frena en un UPDATE directo de cliente es la RLS de lectura
const eOrg4 = await mkEvent('cancelado del organizador para campos', 'cancelled', true, uuid(1));
err = await fail(() => delRaw(1, eOrg4, ", notes = 'con otros campos'"));
ok(err && /row-level security/i.test(err.message) && !/otros datos|cancelado|organizador del workspace puede/.test(err.message), 'el trigger no le pone límites al organizador (solo la RLS del cliente directo)', err?.message);
// restaurar: un wrapper SECURITY DEFINER de prueba (el cliente directo no puede: la fila eliminada está oculta)
await db.exec(`create function public.test_restore(p uuid) returns void language plpgsql security definer set search_path = public as $$ begin update public.draft_events set deleted_at = null where id = p; end $$;
  grant execute on function public.test_restore(uuid) to authenticated;`);
await asUser(1, async () => { await db.query(`select public.test_restore($1)`, [eOfCon]); });
ok(!(await deleted(eOfCon)), 'el organizador puede restaurar un evento eliminado (como hoy)');
err = await fail(() => asUser(2, async () => { await db.query(`select public.test_restore($1)`, [eNoOf]); }));
ok(err && /restaurar o modificar/.test(err.message) && (await deleted(eNoOf)), 'la posta NO puede restaurar uno eliminado', err?.message);

// --- sin usuario (SQL Editor / servicio) ------------------------------------------------------------------------------------------------------------------------
await db.exec("select set_config('request.jwt.claim.sub', '', false)");
await db.query(`update public.draft_events set deleted_at = now() where id = $1`, [eOfCon]);
ok(await deleted(eOfCon), 'sin usuario (postgres / SQL Editor) no se interviene: puede eliminar cualquier evento');
await db.query(`update public.draft_events set deleted_at = null where id = $1`, [eOfCon]);
ok(!(await deleted(eOfCon)), 'y restaurarlo');

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

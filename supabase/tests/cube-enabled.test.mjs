// Tests de la migración 0160 (habilitar/deshabilitar cubos) contra PGlite con la cadena REAL de migraciones 0001-0148.
// (0149 en adelante no aplica en PGlite desde cero; no importa: la 0160 solo depende de public.cubes y cube_roulette_spins.)
// Uso: cd supabase/tests && npm install && node cube-enabled.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { newDb, applyMigrations, MIGRATIONS_DIR } from './harness.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const fatal = (e) => { console.log('ERROR:', String(e && e.message).slice(0, 400)); process.exit(2); };
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
const uuid = (n) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

const db = await newDb();
await db.exec('alter default privileges in schema public grant all on tables to anon, authenticated, service_role');
await applyMigrations(db, { to: 148 });
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

// --- datos ANTES de la migración (lo "ya jugado") ---------------------------------------------------------------------------
for (let i = 1; i <= 3; i += 1) await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,$2,'{}')`, [uuid(i), `u${i}@x.com`]);
await db.query(`insert into public.workspaces (name, slug, created_by) values ('W1','ws-one',$1)`, [uuid(1)]);   // el creador (usuario 1) queda organizador
const ws = (await one(`select id from public.workspaces`)).id;
await db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'member')`, [ws, uuid(2)]);
const mkCube = async (name) => (await one(`insert into public.cubes (workspace_id, name, created_by) values ($1,$2,$3) returning id`, [ws, name, uuid(1)])).id;
const cA = await mkCube('Cubo A'); const cB = await mkCube('Cubo B'); const cC = await mkCube('Cubo C');
const mkEvent = async (cube) => (await one(`insert into public.draft_events (workspace_id, name, scheduled_for, created_by, event_organizer_user_id, cube_id, draft_started_at, status)
  values ($1,'Evento',now(),$2,$2,$3,now(),'completed') returning id`, [ws, uuid(1), cube])).id;
const e1 = await mkEvent(cA); const e2 = await mkEvent(cA); const e3 = await mkEvent(cB);
await db.query(`insert into public.cube_roulette_spins (event_id, spun_by, roulette_type, result_type, selected_cube_id) values ($1,$2,'cubes','cube',$3)`, [e1, uuid(1), cA]);
const usageA = async () => Number((await one(`select usage_count from public.cubes_with_stats where id = $1`, [cA])).usage_count);
const antes = { usage: await usageA(), events: (await one(`select count(*)::int n from public.draft_events`)).n, spins: (await one(`select count(*)::int n from public.cube_roulette_spins`)).n };

// --- aplicar la 0160 (dos veces: idempotente) ---------------------------------------------------------------------------------
const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '0160_cubos_habilitados.sql'), 'utf8');
await db.exec(sql);
await db.exec(sql);
ok(true, '0160 aplica dos veces sin errores (idempotente)');
const col = await one(`select data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name='cubes' and column_name='is_enabled'`);
ok(col.data_type === 'boolean' && col.is_nullable === 'NO' && /true/.test(col.column_default), 'is_enabled: boolean not null default true', col);
ok((await q(`select 1 from public.cubes where is_enabled is not true`)).length === 0, 'los cubos existentes quedan todos habilitados');
const cubes0 = (await q(`select id, name, notes, avatar_path, created_at, deleted_at from public.cubes order by name`));

// --- deshabilitar NO toca lo jugado --------------------------------------------------------------------------------------------
await db.query(`update public.cubes set is_enabled = false where id = $1`, [cA]);
const despues = { usage: await usageA(), events: (await one(`select count(*)::int n from public.draft_events`)).n, spins: (await one(`select count(*)::int n from public.cube_roulette_spins`)).n };
ok(JSON.stringify(antes) === JSON.stringify(despues), 'deshabilitar un cubo no cambia eventos, tiradas ni los usos en cubes_with_stats', { antes, despues });
ok((await one(`select count(*)::int n from public.draft_events where cube_id = $1`, [cA])).n === 2, 'los eventos que usaron el cubo siguen apuntando a él');
ok((await one(`select selected_cube_id from public.cube_roulette_spins where event_id = $1`, [e1])).selected_cube_id === cA, 'la tirada histórica del cubo deshabilitado sigue intacta');
ok((await q(`select id from public.cubes where id = $1 and deleted_at is null`, [cA])).length === 1, 'el cubo deshabilitado no se borra ni se suprime (deleted_at nulo)');
ok((await q(`select 1 from public.cubes_with_stats where id = $1`, [cA])).length === 1, 'el cubo deshabilitado sigue en cubes_with_stats');
const cubes1 = (await q(`select id, name, notes, avatar_path, created_at, deleted_at from public.cubes order by name`));
ok(JSON.stringify(cubes0) === JSON.stringify(cubes1), 'el resto de las columnas de los cubos no cambió');

// --- guardia de servidor en la ruleta ---------------------------------------------------------------------------------------------
const spin = (event, type, cube, rtype = 'cubes', extra = null) => db.query(
  `insert into public.cube_roulette_spins (event_id, spun_by, roulette_type, result_type, selected_cube_id, selected_player_user_id) values ($1,$2,$3,$4,$5,$6)`,
  [event, uuid(1), rtype, type, cube, extra]);
let err = null;
try { await spin(e2, 'cube', cA); } catch (e) { err = e; }
ok(err && /deshabilitado/.test(err.message), 'una tirada con un cubo deshabilitado (ruleta de cubos) se rechaza', err?.message);
err = null;
try { await spin(e2, 'cube', cA, 'players', uuid(2)); } catch (e) { err = e; }
ok(err && /deshabilitado/.test(err.message), 'la elección manual de un cubo deshabilitado (jugador elige) también se rechaza', err?.message);
await spin(e2, 'cube', cB);
ok(true, 'una tirada con un cubo habilitado se registra');
await spin(e2, 'player_chooses', null);
await spin(e2, 'everyone_smokes', null);
ok(true, 'las tiradas sin cubo (jugador elige, todos fuman) no se ven afectadas');
ok((await one(`select count(*)::int n from public.cube_roulette_spins`)).n === antes.spins + 3, 'solo se registraron las 3 tiradas válidas');
await db.query(`update public.cubes set is_enabled = true where id = $1`, [cA]);
await spin(e2, 'cube', cA);
ok(true, 'al volver a habilitarlo el cubo puede volver a salir');

// --- quién puede cambiarlo: organizador sí, miembro no (RLS de cubes, como el alta de cubos) ------------------------------------------
await db.exec(`grant usage on schema public to authenticated, anon;`);
const asUser = async (n, fn) => {
  await db.exec(`select set_config('request.jwt.claim.sub', '${uuid(n)}', false); select set_config('request.jwt.claim.role', 'authenticated', false); set role authenticated;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
};
const enabledOf = async (id) => (await one(`select is_enabled from public.cubes where id = $1`, [id])).is_enabled;
await asUser(1, async () => { await db.query(`update public.cubes set is_enabled = false where id = $1`, [cC]); });
ok((await enabledOf(cC)) === false, 'el organizador del workspace puede deshabilitar un cubo');
await asUser(1, async () => { await db.query(`update public.cubes set is_enabled = true where id = $1`, [cC]); });
ok((await enabledOf(cC)) === true, 'el organizador puede volver a habilitarlo');
await asUser(2, async () => { await db.query(`update public.cubes set is_enabled = false where id = $1`, [cC]); });
ok((await enabledOf(cC)) === true, 'un miembro que no es organizador NO puede cambiarlo (RLS: 0 filas)');
const cp = await one(`select has_column_privilege('authenticated','public.cubes','is_enabled','update') a`);
ok(cp.a === true, 'authenticated tiene UPDATE de la columna (la acota la política de organizador)');
const priv = await one(`select has_function_privilege('anon','public.cube_roulette_spins_guard_enabled()','execute') a, has_function_privilege('authenticated','public.cube_roulette_spins_guard_enabled()','execute') b`);
ok(!priv.a && !priv.b, 'la función del trigger no es ejecutable por anon ni authenticated');
const def = await one(`select prosecdef, proconfig from pg_proc where proname = 'cube_roulette_spins_guard_enabled'`);
ok(def.prosecdef && (def.proconfig ?? []).some((c) => c.startsWith('search_path=')), 'la función es SECURITY DEFINER con search_path fijo', def);

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

// Verifica contra la cadena REAL de migraciones (PGlite) la migración 0147 (parámetros de probabilidades pesadas de
// la ruleta de cubos): defaults, constraints, RLS de lectura para miembros y escritura bloqueada para authenticated.
// Uso: cd supabase/tests && npm install && node cube-roulette-config.test.mjs
import { newDb, applyMigrations } from './harness.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const fatal = (e) => { console.log('ERROR:', String(e && e.message).slice(0, 400)); process.exit(2); };
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

const uuid = (n) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const db = await newDb();
// Reproduce los default privileges de Supabase: toda tabla nueva de public queda con ALL para estos roles.
await db.exec('alter default privileges in schema public grant all on tables to anon, authenticated, service_role');
await applyMigrations(db); // incluye el bloque de verificación de 0147 (sin usuarios todavía: sólo valida estructura)
const q = async (sql, p) => (await db.query(sql, p)).rows;

for (let i = 1; i <= 3; i += 1) await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,$2,'{}')`, [uuid(i), `u${i}@x.com`]);
await db.query(`insert into public.workspaces (name, slug, created_by) values ('W1','ws-one',$1),('W2','ws-two',$1)`, [uuid(1)]);
const [w1, w2] = (await q(`select id from public.workspaces order by slug`)).map((r) => r.id);
await db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'member')`, [w1, uuid(2)]).catch(() => {});
const member = (await q(`select 1 from public.workspace_members where workspace_id=$1 and user_id=$2`, [w1, uuid(2)])).length === 1;
ok(member, 'usuario 2 es miembro de W1 (setup)');

// Re-aplicar 0147 es idempotente y, ahora con usuarios, corre el bloque de constraints.
const fs = await import('node:fs');
const sql = fs.readFileSync(new URL('../migrations/0147_cube_roulette_weights_config.sql', import.meta.url), 'utf8');
let reapplied = true;
try { await db.exec(sql); } catch (e) { reapplied = false; console.log(String(e.message).slice(0, 300)); }
ok(reapplied, '0147 se puede re-aplicar (idempotente) y su verificación con constraints pasa');
ok((await q(`select count(*)::int n from public.workspaces where slug like 'verify-0147%'`))[0].n === 0, 'el workspace descartable de la verificación se deshizo');

ok(!(await q(`select has_table_privilege('anon','public.workspace_cube_roulette_config','select') or has_table_privilege('anon','public.workspace_cube_roulette_config','insert') as p`))[0].p, 'anon no tiene privilegios');
ok((await q(`select has_table_privilege('service_role','public.workspace_cube_roulette_config','insert') p`))[0].p, 'service_role puede escribir');

// Defaults.
await db.query(`insert into public.workspace_cube_roulette_config (workspace_id) values ($1)`, [w1]);
const row = (await q(`select m::float8 m, k::float8 k, tau_min::float8 tau_min, accumulation_mode from public.workspace_cube_roulette_config where workspace_id=$1`, [w1]))[0];
ok(row.m === 0.05 && row.k === 6 && row.tau_min === 0.75 && row.accumulation_mode === 'prod', 'defaults m=0.05 k=6 tau_min=0.75 modo=prod');

// Constraints.
const bad = async (set) => { try { await db.query(`update public.workspace_cube_roulette_config set ${set} where workspace_id=$1`, [w1]); return false; } catch { return true; } };
for (const s of ['m = -0.01', 'm = 1.01', 'k = 0', 'k = -1', 'tau_min = 0', `accumulation_mode = 'otro'`]) ok(await bad(s), `rechaza ${s}`);
ok(!(await bad(`m = 0`)) && !(await bad(`m = 1`)) && !(await bad(`accumulation_mode = 'last'`)), 'acepta m=0, m=1 y modo last');

// El UPDATE de ejemplo del comentario de la migración (upsert de m y k).
await db.query(`insert into public.workspace_cube_roulette_config (workspace_id, m, k) values ($1, 0.10, 8) on conflict (workspace_id) do update set m = excluded.m, k = excluded.k, updated_at = now()`, [w2]);
await db.query(`insert into public.workspace_cube_roulette_config (workspace_id, m, k) values ($1, 0.20, 3) on conflict (workspace_id) do update set m = excluded.m, k = excluded.k, updated_at = now()`, [w2]);
const w2row = (await q(`select m::float8 m, k::float8 k, tau_min::float8 t, accumulation_mode from public.workspace_cube_roulette_config where workspace_id=$1`, [w2]))[0];
ok(w2row.m === 0.2 && w2row.k === 3 && w2row.t === 0.75 && w2row.accumulation_mode === 'prod', 'el upsert de ejemplo cambia m y k y deja el resto en default');

// RLS: authenticated lee sólo si es miembro; no puede escribir.
const as = async (uid, fn) => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${uid}',false), set_config('request.jwt.claim.role','authenticated',false)`);
  try { return await fn(); } finally { await db.exec(`reset role`); }
};
ok((await as(uuid(2), () => q(`select workspace_id from public.workspace_cube_roulette_config`))).length === 1, 'miembro de W1 ve la config de W1 y no la de W2');
ok((await as(uuid(3), () => q(`select workspace_id from public.workspace_cube_roulette_config`))).length === 0, 'no miembro no ve nada');
const writeFails = async (stmt) => as(uuid(2), async () => { try { await db.query(stmt); return false; } catch { return true; } });
ok(await writeFails(`update public.workspace_cube_roulette_config set m = 0.5`), 'authenticated no puede UPDATE');
ok(await writeFails(`insert into public.workspace_cube_roulette_config (workspace_id) values ('${uuid(99)}')`), 'authenticated no puede INSERT');
ok(await writeFails(`delete from public.workspace_cube_roulette_config`), 'authenticated no puede DELETE');

// FK al workspace con on delete cascade (el borrado real de un workspace lo frena audit_log, ajeno a esta tabla).
ok((await q(`select confdeltype from pg_constraint where conrelid='public.workspace_cube_roulette_config'::regclass and contype='f'`))[0].confdeltype === 'c', 'FK a workspaces con on delete cascade');

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLAS`);
process.exit(fails === 0 ? 0 : 1);

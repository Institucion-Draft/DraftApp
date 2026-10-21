// Tests de la migración 0143 (aviso de Gen 3 desbloqueada) contra PGlite con la cadena REAL de migraciones.
// Uso: cd supabase/tests && npm install && node gen3-notice.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { newDb, applyMigrations, MIGRATIONS_DIR } from './harness.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const fatal = (e) => { console.log('ERROR:', String(e && e.message).slice(0, 400)); process.exit(2); };
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
const uuid = (n) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

const db = await newDb();
await applyMigrations(db, { to: 142 });
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const mk = (n, name) => db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,$2,$3)`, [uuid(n), `u${n}@x.com`, JSON.stringify({ display_name: name })]);
for (const [n, name] of [[1, 'Sin desbloqueo'], [2, 'Desbloqueado'], [3, 'Otro'], [4, 'Ya desbloqueado antes']]) await mk(n, name);

// md5 vivo del guard (0142) = el de la cabecera de la 0143
const guard = (await one(`select prosrc from pg_proc where pronamespace='public'::regnamespace and proname='users_guard_gen3_unlocked'`)).prosrc;
const sql143 = fs.readFileSync(path.join(MIGRATIONS_DIR, '0143_gen3_unlock_notice.sql'), 'utf8');
ok(sql143.includes(md5(guard)), `md5 vivo de users_guard_gen3_unlocked (0142) está en la cabecera: ${md5(guard)}`);

// Un usuario ya desbloqueado ANTES de aplicar la 0143.
await db.query(`update public.users set gen3_unlocked_at = now() where id = $1`, [uuid(4)]);

await db.exec(sql143);
await db.exec(sql143);
ok(true, '0143 aplica dos veces sin errores (idempotente)');
const seen = async (n) => (await one(`select gen3_unlock_seen_at is not null s from public.users where id = $1`, [uuid(n)])).s;
ok((await seen(4)) === false, 'ya desbloqueado antes de la migración: seen_at queda null (VE el aviso)');

await db.exec(`grant all on all tables in schema public to authenticated, anon;`);
await db.exec(`grant usage on schema public to authenticated, anon;`);
const asUser = async (n, fn) => {
  await db.exec(`select set_config('request.jwt.claim.sub', '${uuid(n)}', false); select set_config('request.jwt.claim.role', 'authenticated', false); set role authenticated;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
};
const ack = (n) => asUser(n, async () => (await one(`select public.ack_gen3_unlock() r`)).r);

// Sin desbloqueo: la RPC no hace nada.
ok((await ack(1)) === false && (await seen(1)) === false, 'sin desbloqueo: la RPC devuelve false y no marca');

// Desbloqueado sin ver: marca.
await db.query(`update public.users set gen3_unlocked_at = now() where id = $1`, [uuid(2)]);
ok((await ack(2)) === true && (await seen(2)) === true, 'desbloqueado sin ver: la RPC marca y devuelve true');
const t1 = (await one(`select gen3_unlock_seen_at t from public.users where id = $1`, [uuid(2)])).t;
// Segunda llamada: no cambia.
ok((await ack(2)) === false && String((await one(`select gen3_unlock_seen_at t from public.users where id = $1`, [uuid(2)])).t) === String(t1), 'segunda llamada: false y la fecha no cambia');
// El usuario 4 (desbloqueado antes de la migración) también puede marcar.
ok((await ack(4)) === true, 'desbloqueado antes de la migración: la RPC marca');

// No se puede marcar a otro usuario: la RPC no recibe usuario, y el UPDATE directo ajeno no pasa (RLS) ni el propio (guard).
await db.query(`update public.users set gen3_unlocked_at = now() where id = $1`, [uuid(3)]);
await asUser(1, async () => { await db.query(`update public.users set gen3_unlock_seen_at = now() where id = $1`, [uuid(3)]); });
ok((await seen(3)) === false, 'authenticated no puede marcar el aviso de otro usuario (UPDATE directo)');
ok((await ack(1)) === false && (await seen(3)) === false, 'la RPC de un usuario sin desbloqueo no toca a otros');
// El propio usuario no puede escribir seen_at ni unlocked_at por fuera de la RPC (ni borrar el visto).
await asUser(3, async () => { await db.query(`update public.users set gen3_unlock_seen_at = now() where id = $1`, [uuid(3)]); });
ok((await seen(3)) === false, 'authenticated no puede escribir su propio seen_at por fuera de la RPC');
await asUser(2, async () => { await db.query(`update public.users set gen3_unlock_seen_at = null where id = $1`, [uuid(2)]); });
ok((await seen(2)) === true, 'authenticated no puede borrar su seen_at para volver a ver el aviso');
await asUser(1, async () => { await db.query(`update public.users set gen3_unlocked_at = now(), display_name = 'Editado' where id = $1`, [uuid(1)]); });
const u1 = await one(`select gen3_unlocked_at is null n, display_name d from public.users where id = $1`, [uuid(1)]);
ok(u1.n === true && u1.d === 'Editado', 'gen3_unlocked_at sigue sin poder escribirse por authenticated (el resto de la fila sí se edita)');
// Sin sesión: la RPC devuelve false; anon no puede ejecutarla.
await db.exec(`select set_config('request.jwt.claim.sub', '', false); select set_config('request.jwt.claim.role', 'authenticated', false); set role authenticated;`);
const noSession = (await one(`select public.ack_gen3_unlock() r`)).r;
await db.exec(`reset role;`);
ok(noSession === false, 'sin sesión (auth.uid() null): la RPC devuelve false');
let anonBlocked = false;
await db.exec(`set role anon;`);
try { await db.query(`select public.ack_gen3_unlock()`); } catch { anonBlocked = true; }
await db.exec(`reset role;`);
ok(anonBlocked, 'anon no puede ejecutar la RPC');

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

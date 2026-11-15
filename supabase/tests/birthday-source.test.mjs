// Tests de la migración 0161 (cumpleaños: birth_date como única fuente, FASE A) contra PGlite con la cadena REAL 0001-0148.
// my_visible_user_ids() NO está en las migraciones del repo (la política users_select_related de 0150 la usa): se crea un stub equivalente.
// Uso: cd supabase/tests && npm install && node birthday-source.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { newDb, applyMigrations, MIGRATIONS_DIR } from './harness.mjs';

let fails = 0;
const ok = (c, m, extra) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m + (extra !== undefined && !c ? '  -> ' + JSON.stringify(extra) : '')); };
const fatal = (e) => { console.log('ERROR:', String(e && e.message).slice(0, 400)); process.exit(2); };
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
const uuid = (n) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const LF = (s) => s.replace(/\r\n/g, '\n');

const db = await newDb();
await db.exec('alter default privileges in schema public grant all on tables to anon, authenticated, service_role');
await applyMigrations(db, { to: 148 });
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const asRole = (role) => db.exec(`select set_config('request.jwt.claim.role', '${role}', false);`);

// --- datos: 7 usuarios y dos workspaces -----------------------------------------------------------------------------------------------------
for (let i = 1; i <= 7; i += 1) await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,$2,'{}')`, [uuid(i), `u${i}@x.com`]);
await db.query(`insert into public.workspaces (name, slug, created_by) values ('W1','ws-one',$1)`, [uuid(1)]);
await db.query(`insert into public.workspaces (name, slug, created_by) values ('W2','ws-two',$1)`, [uuid(5)]);
const [w1, w2] = (await q(`select id from public.workspaces order by slug`)).map((r) => r.id);
for (const u of [2, 3, 4, 6, 7]) await db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'member')`, [w1, uuid(u)]);
// Stub de my_visible_user_ids(): usuarios que comparten workspace conmigo (incluye al propio).
await db.exec(`create or replace function public.my_visible_user_ids() returns setof uuid language sql stable security definer set search_path = public as $$
  select distinct m2.user_id from public.workspace_members m1 join public.workspace_members m2 on m2.workspace_id = m1.workspace_id where m1.user_id = auth.uid() $$;`);

await asRole('service_role');   // el guard users_guard_birthday deja escribir birthday al equipo / service_role
const setDates = (n, birthday, birthDate) => db.query(`update public.users set birthday = $2, birth_date = $3 where id = $1`, [uuid(n), birthday, birthDate]);
await setDates(1, '1990-05-17', '1990-05-17');   // ambas iguales
await setDates(2, '2000-02-29', null);           // solo birthday (29/02)
await setDates(3, null, '1995-05-18');           // solo birth_date
await setDates(4, null, null);                   // ninguna
await setDates(5, null, '1988-05-17');           // NO visible para el usuario 1 (otro workspace)
await setDates(6, '2000-05-17', null);           // solo birthday
await setDates(7, '2000-01-01', '1999-12-31');   // ambas y DISTINTAS: no se toca nada
await asRole('');

// --- chance de shiny ANTES (lee birthday) ------------------------------------------------------------------------------------------------------
const DIAS = ['2026-05-14', '2026-05-17', '2026-05-20', '2026-05-21', '2026-02-28', '2026-03-01', '2028-02-29', '2026-01-01'];
const chances = async () => {
  const out = {};
  for (const n of [1, 2, 3, 4, 6, 7]) {
    out[n] = [];
    for (const d of DIAS) out[n].push(Number((await one(`select public.shiny_chance_for($1, $2::date, $2::date) c`, [uuid(n), d])).c));
  }
  return out;
};
const antes = await chances();
ok(antes[1][1] === 50 && antes[2][4] === 50 && antes[6][1] === 50, 'antes: los de birthday cargado tienen 50 % su día (u1 el 17/5, u2 el 28/2 de un año no bisiesto, u6)');
ok(antes[3].every((c) => Math.abs(c - 100 / 4096) < 1e-9), 'antes: el de solo birth_date (u3) tiene siempre la chance basal');

// --- md5 de la cabecera y aplicación (dos veces) -----------------------------------------------------------------------------------------------------
const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '0161_cumpleanos_fuente_birth_date.sql'), 'utf8');
const vivo = LF((await one(`select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'shiny_chance_for'`)).prosrc);
ok(LF(sql).includes(md5(vivo)) && LF(sql).includes(`(${vivo.length} caracteres con LF`), `md5 y largo del cuerpo vivo de shiny_chance_for (0146) en la cabecera: ${md5(vivo)}`);
const crlf = vivo.replace(/\n/g, '\r\n');
ok(LF(sql).includes(md5(crlf)) && LF(sql).includes(`${crlf.length})`), 'la variante CRLF (md5 y largo) también está en la cabecera');
const usuarios = (await one(`select count(*)::int n from public.users`)).n;
await db.exec(sql);
const backup1 = await q(`select user_id, birthday, birth_date from admin_private.users_birthday_backup_0161 order by user_id`);
ok(backup1.length === usuarios, `respaldo: una fila por usuario (${usuarios})`, backup1.length);
const b2 = backup1.find((r) => r.user_id === uuid(2));
ok(b2.birthday != null && b2.birth_date === null, 'el respaldo guarda el estado ANTERIOR (u2: birthday sí, birth_date null)');
// Re-correr: no pisa el respaldo ni vuelve a copiar
await db.query(`update public.users set birth_date = '2001-03-03' where id = $1`, [uuid(2)]);
await db.exec(sql);
ok(true, '0161 aplica dos veces sin errores (idempotente)');
const backup2 = await q(`select user_id, birthday, birth_date from admin_private.users_birthday_backup_0161 order by user_id`);
ok(JSON.stringify(backup1) === JSON.stringify(backup2), 'el respaldo no se pisa al re-correr la migración');
await db.query(`update public.users set birth_date = '2000-02-29' where id = $1`, [uuid(2)]);   // se deja como la migración lo había copiado

// --- datos migrados ----------------------------------------------------------------------------------------------------------------------------------
const f = async (n) => { const r = await one(`select to_char(birthday,'YYYY-MM-DD') b, to_char(birth_date,'YYYY-MM-DD') d from public.users where id = $1`, [uuid(n)]); return r; };
ok((await f(1)).d === '1990-05-17' && (await f(1)).b === '1990-05-17', 'ambas iguales: no se toca nada (u1)');
ok((await f(2)).d === '2000-02-29' && (await f(2)).b === '2000-02-29', 'solo birthday: se copia a birth_date y birthday NO se toca (u2)');
ok((await f(6)).d === '2000-05-17' && (await f(6)).b === '2000-05-17', 'solo birthday: se copia (u6)');
ok((await f(3)).d === '1995-05-18' && (await f(3)).b === null, 'solo birth_date: no se toca (u3)');
ok((await f(4)).d === null && (await f(4)).b === null, 'sin ninguna: sigue sin ninguna (u4)');
ok((await f(7)).d === '1999-12-31' && (await f(7)).b === '2000-01-01', 'ambas y distintas: no se toca nada (u7)');
ok((await one(`select count(*)::int n from public.users where birthday is not null and birth_date is null`)).n === 0, 'no queda ningún usuario con birthday y sin birth_date');

// --- chance de shiny DESPUÉS (lee birth_date) ------------------------------------------------------------------------------------------------------------
const despues = await chances();
ok(JSON.stringify(despues[1]) === JSON.stringify(antes[1]), 'misma chance antes y después para u1 (ambas iguales)');
ok(JSON.stringify(despues[2]) === JSON.stringify(antes[2]), 'misma chance antes y después para u2 (solo birthday, 29/02)');
ok(JSON.stringify(despues[6]) === JSON.stringify(antes[6]), 'misma chance antes y después para u6 (solo birthday)');
ok(JSON.stringify(despues[4]) === JSON.stringify(antes[4]), 'misma chance antes y después para u4 (sin fecha: basal)');
ok(despues[3][1] !== antes[3][1] || despues[3][0] !== antes[3][0], 'u3 (solo birth_date) ahora SÍ tiene chance de cumpleaños (cambio esperado de la fase)', despues[3]);
// la fuente es birth_date: borrar birthday no cambia nada; cambiar birth_date sí
await asRole('service_role');
await db.query(`update public.users set birthday = null where id = $1`, [uuid(1)]);
ok(JSON.stringify(await chances().then((c) => c[1])) === JSON.stringify(antes[1]), 'con birthday en NULL la chance de u1 no cambia (ya no se lee birthday)');
await db.query(`update public.users set birth_date = '1990-06-01' where id = $1`, [uuid(1)]);
ok(Number((await one(`select public.shiny_chance_for($1, '2026-05-17', '2026-05-17') c`, [uuid(1)])).c) < 50, 'cambiar birth_date sí cambia la chance (u1 deja de cumplir el 17/5)');
await db.query(`update public.users set birth_date = '1990-05-17', birthday = '1990-05-17' where id = $1`, [uuid(1)]);
await asRole('');

// --- función nueva: solo ids visibles con cumpleaños hoy ------------------------------------------------------------------------------------------------
const asUser = async (n, fn) => {
  await db.exec(`select set_config('request.jwt.claim.sub', '${n == null ? '' : uuid(n)}', false); select set_config('request.jwt.claim.role', 'authenticated', false); set role authenticated;`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.role', '', false);`); }
};
const idsOn = async (n, day) => {
  await db.exec(`select set_config('request.jwt.claim.sub', '${n == null ? '' : uuid(n)}', false);`);
  return (await q(`select x::text id from public.birthday_user_ids_on($1::date) x order by 1`, [day])).map((r) => r.id);
};
const U = (...ns) => ns.map(uuid).sort();
ok(JSON.stringify(await idsOn(1, '2026-05-17')) === JSON.stringify(U(1, 6)), 'el 17/5 devuelve a u1 y u6 (visibles) y NO a u5 (mismo día pero de otro workspace)', await idsOn(1, '2026-05-17'));
ok(JSON.stringify(await idsOn(1, '2026-05-18')) === JSON.stringify(U(3)), 'el 18/5 devuelve solo a u3');
ok(JSON.stringify(await idsOn(1, '2026-02-28')) === JSON.stringify(U(2)), '29/02 en año NO bisiesto: cuenta el 28/02 (como is_birthday)');
ok((await idsOn(1, '2026-03-01')).length === 0, '29/02 en año no bisiesto: no cuenta el 1/03');
ok((await idsOn(1, '2028-02-28')).length === 0 && JSON.stringify(await idsOn(1, '2028-02-29')) === JSON.stringify(U(2)), '29/02 en año bisiesto: solo el 29/02');
ok(JSON.stringify(await idsOn(1, '2026-12-31')) === JSON.stringify(U(7)) && (await idsOn(1, '2026-01-01')).length === 0, 'u7 sale el 31/12 (su birth_date) y NO el 1/1 (su birthday ya no se mira); un día sin cumpleaños devuelve vacío');
ok(JSON.stringify(await idsOn(5, '2026-05-17')) === JSON.stringify(U(5)), 'u5 (otro workspace) solo se ve a sí mismo, no a u1 ni a u6');
ok((await idsOn(null, '2026-05-17')).length === 0, 'sin sesión (auth.uid() null): no devuelve nada');
// Cerca de la medianoche de Buenos Aires (UTC-3): a las 02:59:59 UTC todavía es el 17; a las 03:00:00 UTC ya es el 18
const bsas = async (ts) => (await one(`select to_char((timestamptz '${ts}' at time zone 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD') d`)).d;
ok((await bsas('2026-05-18 02:59:59+00')) === '2026-05-17' && (await bsas('2026-05-18 03:00:00+00')) === '2026-05-18', 'la fecha de Buenos Aires cambia a las 03:00 UTC (21:00 UTC-3 aún es el día anterior en UTC… la de UTC va 3 h adelantada)');
const noche = await bsas('2026-05-18 02:30:00+00');   // 23:30 del 17 en Buenos Aires; en UTC ya es el 18
ok(JSON.stringify(await idsOn(1, noche)) === JSON.stringify(U(1, 6)) && JSON.stringify(await idsOn(1, '2026-05-18')) === JSON.stringify(U(3)), 'a las 23:30 de Buenos Aires del 17/5 (02:30 UTC del 18) corresponde el cumpleaños del 17 y no el del 18', noche);
const src = (await one(`select prosrc from pg_proc where proname = 'birthday_user_ids_today'`)).prosrc;
ok(/America\/Argentina\/Buenos_Aires/.test(src) && !/current_date/i.test(src), 'birthday_user_ids_today usa la fecha de Buenos Aires explícita y NO current_date');
await db.exec(`select set_config('request.jwt.claim.sub', '${uuid(1)}', false);`);
const hoyBsAs = (await one(`select to_char((now() at time zone 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD') d`)).d;
const viaToday = (await q(`select x::text id from public.birthday_user_ids_today() x order by 1`)).map((r) => r.id);
ok(JSON.stringify(viaToday) === JSON.stringify(await idsOn(1, hoyBsAs)), 'birthday_user_ids_today() = la interna con el día de hoy de Buenos Aires');

// --- no expone la fecha y permisos --------------------------------------------------------------------------------------------------------------------
ok((await one(`select pg_get_function_result('public.birthday_user_ids_today()'::regprocedure) r`)).r === 'SETOF uuid', 'devuelve solo uuid (SETOF uuid): nunca la fecha');
const cols = (await db.query(`select x from public.birthday_user_ids_today() x limit 1`)).fields.map((f2) => f2.name);
ok(cols.length === 1, 'una sola columna en el resultado', cols);
await db.exec(`grant usage on schema public to authenticated, anon;`);
const call = async (role, n, sql2) => {
  await db.exec(`select set_config('request.jwt.claim.sub', '${uuid(n)}', false); select set_config('request.jwt.claim.role', '${role}', false); set role ${role};`);
  try { await db.query(sql2); return 'ejecutó'; } catch (e) { return 'denegado'; } finally { await db.exec(`reset role;`); }
};
ok((await call('authenticated', 1, `select * from public.birthday_user_ids_today()`)) === 'ejecutó', 'authenticated puede llamar a birthday_user_ids_today()');
ok((await call('anon', 1, `select * from public.birthday_user_ids_today()`)) === 'denegado', 'anon NO puede llamarla');
ok((await call('authenticated', 1, `select * from public.birthday_user_ids_on('2026-05-17')`)) === 'denegado', 'authenticated NO puede llamar a la interna con una fecha arbitraria (así no se averiguan cumpleaños)');
ok((await call('anon', 1, `select * from public.birthday_user_ids_on('2026-05-17')`)) === 'denegado', 'anon tampoco');
ok((await call('authenticated', 1, `select public.shiny_chance_for('${uuid(1)}', '2026-05-17', '2026-05-17')`)) === 'denegado', 'authenticated ya no puede llamar a shiny_chance_for');
ok((await call('authenticated', 1, `select * from admin_private.users_birthday_backup_0161`)) === 'denegado' && (await call('anon', 1, `select * from admin_private.users_birthday_backup_0161`)) === 'denegado', 'el respaldo no es legible por authenticated ni anon');
const def = await one(`select prosecdef, proconfig from pg_proc where proname = 'birthday_user_ids_today'`);
ok(def.prosecdef && (def.proconfig ?? []).some((c) => c.startsWith('search_path=')), 'birthday_user_ids_today es SECURITY DEFINER con search_path fijo', def);
const def2 = await one(`select prosecdef, proconfig from pg_proc where proname = 'birthday_user_ids_on'`);
ok(def2.prosecdef && (def2.proconfig ?? []).some((c) => c.startsWith('search_path=')), 'la interna también', def2);

// --- verificaciones pedidas -----------------------------------------------------------------------------------------------------------------------------------
const asg = (await one(`select prosrc from pg_proc where proname = 'assign_rotated_avatar'`)).prosrc;
ok(/America\/Argentina\/Buenos_Aires/.test(asg) && !/current_date/i.test(asg), 'assign_rotated_avatar usa la fecha de Buenos Aires para "hoy" (no current_date): el shiny de cumpleaños no falla de noche');
// guard users_guard_birthday: con el rol del JWT = authenticated se conserva; con service_role (o sin claims en el SQL Editor) pasa
await db.exec(`select set_config('request.jwt.claim.role', 'authenticated', false);`);
await db.query(`update public.users set birthday = null where id = $1`, [uuid(2)]);
ok((await f(2)).b === '2000-02-29', 'guard: con rol authenticated el UPDATE de birthday se ignora en silencio');
await db.exec(`select set_config('request.jwt.claim.role', 'service_role', false);`);
await db.query(`update public.users set birthday = null where id = $1`, [uuid(2)]);
ok((await f(2)).b === null, 'guard: con service_role (como el SQL Editor, auth.role() null) UPDATE ... SET birthday = NULL pasa');
await db.exec(`select set_config('request.jwt.claim.role', '', false);`);

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

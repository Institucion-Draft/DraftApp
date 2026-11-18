// Tests de la migración 0162 (cubos por evento) contra PGlite con la cadena REAL de migraciones 0001-0148 + la 0160 (que es su base).
// (0149 en adelante no aplica en PGlite desde cero; la 0162 solo depende de cubes, draft_events, can_manage_event y cube_roulette_spins.)
// Uso: cd supabase/tests && npm install && node cube-event-exclusions.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { newDb, applyMigrations, MIGRATIONS_DIR } from './harness.mjs';

let fails = 0;
const ok = (c, m, x) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m + (!c && x ? ' ' + JSON.stringify(x) : '')); };
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

// --- datos: ws1 (U1 organizador, U2 member con la posta de eP, U4 member sin posta), ws2 (U3 organizador) ------------------------------------
for (let i = 1; i <= 4; i += 1) await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,$2,'{}')`, [uuid(i), `u${i}@x.com`]);
await db.query(`insert into public.workspaces (name, slug, created_by) values ('W1','ws-one',$1)`, [uuid(1)]);
await db.query(`insert into public.workspaces (name, slug, created_by) values ('W2','ws-two',$1)`, [uuid(3)]);
const ws = (await one(`select id from public.workspaces where slug='ws-one'`)).id;
const ws2 = (await one(`select id from public.workspaces where slug='ws-two'`)).id;
await db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'member'),($1,$3,'member')`, [ws, uuid(2), uuid(4)]);
const mkCube = async (name) => (await one(`insert into public.cubes (workspace_id, name, created_by) values ($1,$2,$3) returning id`, [ws, name, uuid(1)])).id;
const cA = await mkCube('Cubo A'); const cB = await mkCube('Cubo B'); const cC = await mkCube('Cubo C');
const mkEvent = async (name, posta) => (await one(`insert into public.draft_events (workspace_id, name, scheduled_for, created_by, event_organizer_user_id, status)
  values ($1,$2,now(),$3,$3,'scheduled') returning id`, [ws, name, posta])).id;
const eP = await mkEvent('Evento de Martín', uuid(2));   // la posta la tiene U2 (member)
const eO = await mkEvent('Evento del organizador', uuid(1));
const eX = await mkEvent('Evento a borrar', uuid(1));

// --- aplicar 0160 y 0162 (esta, dos veces: idempotente) -----------------------------------------------------------------------------------------
await db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, '0160_cubos_habilitados.sql'), 'utf8'));
const old = (await one(`select prosrc from pg_proc where proname = 'cube_roulette_spins_guard_enabled'`)).prosrc;
const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '0162_cubos_por_evento.sql'), 'utf8');
ok(LF(sql).includes(md5(LF(old))) && LF(sql).includes(`(${LF(old).length} caracteres con LF`), `md5 y largo del cuerpo de la 0160 en la cabecera: ${md5(LF(old))}`);
const crlf = LF(old).replace(/\n/g, '\r\n');
ok(LF(sql).includes(md5(crlf)) && LF(sql).includes(`${crlf.length})`), 'la variante CRLF (md5 y largo) también está en la cabecera');
// Tercera variante: la 0160 aplicada en producción con codificación errónea ("está" -> "estÃ¡", CRLF). Se calcula desde el archivo, no se copia el md5.
const mojibake = crlf.replace('está', 'estÃ¡');
ok(mojibake.length === crlf.length + 1 && md5(mojibake) === 'ad559993f339b45fd564bc8f62396fac', 'la variante con "estÃ¡" (364, CRLF) tiene el md5 visto en producción');
ok(LF(sql).includes(md5(mojibake)), 'esa variante está aceptada en la cabecera y en el bloque DO');
const fn = (body) => `create or replace function public.cube_roulette_spins_guard_enabled() returns trigger language plpgsql security definer set search_path = public as $$${body}$$;`;
await db.exec(fn(mojibake));
await db.exec(sql);
const fixed = (await one(`select prosrc from pg_proc where proname = 'cube_roulette_spins_guard_enabled'`)).prosrc;
ok(/está excluido de este evento/.test(fixed) && /está deshabilitado/.test(fixed) && !/Ã/.test(fixed), 'con la variante de producción la migración aplica y deja la tilde correcta en la función nueva');
await db.exec(fn(old));   // se vuelve al cuerpo de la 0160 para seguir
await db.exec(sql);
await db.exec(sql);
ok(true, '0162 aplica dos veces sin errores (idempotente)');
const nuevo = (await one(`select prosrc from pg_proc where proname = 'cube_roulette_spins_guard_enabled'`)).prosrc;
ok(md5(nuevo) !== md5(old) && /event_cube_exclusions/.test(nuevo), 'la guardia quedó reemplazada por la versión nueva');
ok((await one(`select count(*)::int n from pg_trigger where tgrelid='public.cube_roulette_spins'::regclass and not tgisinternal and tgname='cube_roulette_spins_guard_enabled'`)).n === 1, 'un solo trigger de guardia en cube_roulette_spins');

// --- pre-check: con un cuerpo distinto, ABORTA ------------------------------------------------------------------------------------------------------
await db.exec(`create or replace function public.cube_roulette_spins_guard_enabled() returns trigger language plpgsql as $$ begin return new; end; $$;`);
let err = null;
try { await db.exec(sql); } catch (e) { err = e; }
await db.exec('rollback');
ok(err && /NO aplicar sin revisar/.test(err.message), 'con un cuerpo vivo distinto el pre-check aborta', err?.message);
await db.exec(`create or replace function public.cube_roulette_spins_guard_enabled() returns trigger language plpgsql security definer set search_path = public as $$${old}$$;`);   // se restaura el cuerpo exacto de la 0160
await db.exec(sql);
ok(true, 'con el cuerpo de la 0160 (variante CRLF del repo) la migración vuelve a aplicar');

// --- estructura y permisos ------------------------------------------------------------------------------------------------------------------------------
const pk = await q(`select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = 'public.event_cube_exclusions'::regclass and i.indisprimary order by a.attname`);
ok(pk.map((r) => r.attname).join() === 'cube_id,event_id', 'clave primaria compuesta (event_id, cube_id)');
ok((await one(`select count(*)::int n from public.event_cube_exclusions`)).n === 0, 'un evento nuevo arranca sin exclusiones');
const pr = await one(`select has_table_privilege('authenticated','public.event_cube_exclusions','insert') i, has_table_privilege('authenticated','public.event_cube_exclusions','delete') d,
  has_table_privilege('authenticated','public.event_cube_exclusions','update') u, has_table_privilege('anon','public.event_cube_exclusions','select') a`);
ok(pr.i && pr.d && !pr.u && !pr.a, 'authenticated: select/insert/delete sin update; anon: nada', pr);

// --- RLS ---------------------------------------------------------------------------------------------------------------------------------------------------------
await db.exec(`grant usage on schema public to authenticated, anon;`);
const asUser = async (n, fn) => {
  await db.exec(`select set_config('request.jwt.claim.sub', '${uuid(n)}', false); select set_config('request.jwt.claim.role', 'authenticated', false); set role authenticated;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
};
const exclude = (n, ev, cube, by = n) => asUser(n, async () => { await db.query(`insert into public.event_cube_exclusions (event_id, cube_id, created_by) values ($1,$2,$3)`, [ev, cube, uuid(by)]); });
const unexclude = (n, ev, cube) => asUser(n, async () => (await db.query(`delete from public.event_cube_exclusions where event_id=$1 and cube_id=$2 returning cube_id`, [ev, cube])).rows.length);
const excl = async (ev) => (await q(`select cube_id from public.event_cube_exclusions where event_id=$1 order by cube_id`, [ev])).map((r) => r.cube_id);
const fail = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

await exclude(2, eP, cA);
ok((await excl(eP)).join() === cA, 'quien tiene la posta (member) puede excluir un cubo de SU evento');
ok((await unexclude(2, eP, cA)) === 1 && (await excl(eP)).length === 0, 'y puede volver a incluirlo');
await exclude(1, eP, cB);
ok((await excl(eP)).join() === cB, 'el organizador del workspace puede excluir un cubo de un evento ajeno (de la posta de otro)');
await unexclude(1, eP, cB);
err = await fail(() => exclude(4, eP, cA));
ok(err && /row-level security/i.test(err.message), 'un member SIN la posta no puede excluir (RLS)', err?.message);
ok((await excl(eP)).length === 0, 'y no quedó ninguna fila');
err = await fail(() => exclude(2, eO, cA));
ok(err && /row-level security/i.test(err.message), 'la posta de un evento NO sirve en otro evento (RLS)', err?.message);
err = await fail(() => exclude(3, eP, cA));
ok(err && /row-level security/i.test(err.message), 'un organizador de OTRO workspace no puede excluir en este (RLS)', err?.message);
err = await fail(() => exclude(2, eP, cA, 1));
ok(err && /row-level security/i.test(err.message), 'no se puede firmar la exclusión como otro usuario (created_by = quien llama)', err?.message);
await exclude(1, eO, cA);
ok((await unexclude(4, eO, cA)) === 0 && (await excl(eO)).join() === cA, 'un member sin la posta no puede borrar una exclusión (0 filas)');
ok((await unexclude(2, eO, cA)) === 0 && (await excl(eO)).join() === cA, 'la posta de otro evento no puede borrarla (0 filas)');

// lectura: miembros del workspace sí, de otro workspace no; cada evento ve solo lo suyo
await exclude(2, eP, cB);   // eP excluye B ; eO excluye A
const seen = (n, ev) => asUser(n, async () => (await db.query(`select cube_id from public.event_cube_exclusions where event_id=$1`, [ev])).rows.map((r) => r.cube_id));
ok((await seen(4, eP)).join() === cB, 'un miembro cualquiera del workspace lee las exclusiones del evento');
ok((await seen(4, eO)).join() === cA, 'cada evento ve las suyas: eP excluye B y eO excluye A, sin mezclarse');
ok((await seen(3, eP)).length === 0, 'un usuario de otro workspace no ve nada');
const asAnon = await asUser(3, async () => (await db.query(`select count(*)::int n from public.event_cube_exclusions`)).rows[0].n);
ok(asAnon === 0, 'un usuario de otro workspace ve 0 filas en total');

// --- guardia de servidor -----------------------------------------------------------------------------------------------------------------------------------------
const spin = (event, type, cube, rtype = 'cubes', extra = null) => db.query(
  `insert into public.cube_roulette_spins (event_id, spun_by, roulette_type, result_type, selected_cube_id, selected_player_user_id) values ($1,$2,$3,$4,$5,$6)`,
  [event, uuid(1), rtype, type, cube, extra]);
// estado: eP excluye B; eO excluye A
err = await fail(() => spin(eP, 'cube', cB));
ok(err && /excluido de este evento/.test(err.message), 'una tirada de un cubo excluido en ese evento se rechaza', err?.message);
err = await fail(() => spin(eP, 'cube', cB, 'players', uuid(2)));
ok(err && /excluido de este evento/.test(err.message), 'la elección manual de un cubo excluido (jugador elige) también se rechaza', err?.message);
await spin(eP, 'cube', cA);
await spin(eP, 'cube', cC);
ok(true, 'el resto de los cubos del evento sale normal');
await spin(eO, 'cube', cB);
ok(true, 'la exclusión de un evento no afecta a otro: eO sí puede sacar B (eP lo excluyó)');
err = await fail(() => spin(eO, 'cube', cA));
ok(err && /excluido de este evento/.test(err.message), 'eO no puede sacar A (lo excluyó)');
await spin(eP, 'player_chooses', null);
await spin(eP, 'everyone_smokes', null);
ok(true, 'las tiradas sin cubo no se ven afectadas');
await db.query(`update public.cubes set is_enabled = false where id = $1`, [cC]);
err = await fail(() => spin(eP, 'cube', cC));
ok(err && /deshabilitado/.test(err.message) && !/excluido/.test(err.message), 'el nivel global sigue rechazando (mensaje del global)', err?.message);
await db.query(`update public.cubes set is_enabled = true where id = $1`, [cC]);
await unexclude(2, eP, cB);
await spin(eP, 'cube', cB);
ok(true, 'al volver a incluirlo, el cubo puede volver a salir');
const hist = (await one(`select count(*)::int n from public.cube_roulette_spins`)).n;
ok(hist === 6, 'solo se registraron las tiradas válidas', hist);
const priv = await one(`select has_function_privilege('anon','public.cube_roulette_spins_guard_enabled()','execute') a, has_function_privilege('authenticated','public.cube_roulette_spins_guard_enabled()','execute') b`);
ok(!priv.a && !priv.b, 'la función del trigger no es ejecutable por anon ni authenticated');
const def = await one(`select prosecdef, proconfig from pg_proc where proname = 'cube_roulette_spins_guard_enabled'`);
ok(def.prosecdef && (def.proconfig ?? []).some((c) => c.startsWith('search_path=')), 'la guardia sigue SECURITY DEFINER con search_path fijo', def);

// --- cascadas ------------------------------------------------------------------------------------------------------------------------------------------------------------
await db.query(`insert into public.event_cube_exclusions (event_id, cube_id, created_by) values ($1,$2,$3),($1,$4,$3)`, [eX, cA, uuid(1), cB]);
await db.query(`delete from public.draft_events where id = $1`, [eX]);
ok((await excl(eX)).length === 0, 'borrar el evento limpia sus exclusiones (ON DELETE CASCADE)');
ok((await excl(eO)).join() === cA, 'y no toca las de otros eventos');
const cD = await mkCube('Cubo D');await db.query(`insert into public.event_cube_exclusions (event_id, cube_id, created_by) values ($1,$2,$3)`, [eO, cD, uuid(1)]);await db.query(`delete from public.cubes where id = $1`, [cD]);ok((await excl(eO)).join() === cA, 'borrar un cubo limpia sus exclusiones y deja las demás');

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

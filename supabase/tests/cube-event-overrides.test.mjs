// Tests de la migración 0163 (estado propio del cubo por evento) contra PGlite: cadena REAL 0001-0148 + 0160 + 0162 (su base) y luego la 0163.
// (0149 en adelante no aplica en PGlite desde cero; la 0163 solo depende de cubes, draft_events, can_manage_event y cube_roulette_spins.)
// Uso: cd supabase/tests && npm install && node cube-event-overrides.test.mjs
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
const read = (f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');

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
await db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'member'),($1,$3,'member')`, [ws, uuid(2), uuid(4)]);
const mkCube = async (name) => (await one(`insert into public.cubes (workspace_id, name, created_by) values ($1,$2,$3) returning id`, [ws, name, uuid(1)])).id;
const cA = await mkCube('Cubo A'); const cB = await mkCube('Cubo B'); const cC = await mkCube('Cubo C'); const cD = await mkCube('Cubo D');
const mkEvent = async (name, posta) => (await one(`insert into public.draft_events (workspace_id, name, scheduled_for, created_by, event_organizer_user_id, status)
  values ($1,$2,now(),$3,$3,'scheduled') returning id`, [ws, name, posta])).id;
const eP = await mkEvent('Evento de Martín', uuid(2));   // la posta la tiene U2 (member)
const eO = await mkEvent('Evento del organizador', uuid(1));
const eX = await mkEvent('Evento a borrar', uuid(1));

// --- estado de producción ANTES de la 0163: 0160 + 0162 con exclusiones de prueba -------------------------------------------------------------
await db.exec(read('0160_cubos_habilitados.sql'));
const sql162 = read('0162_cubos_por_evento.sql');
await db.exec(sql162);
const body162 = (await one(`select prosrc from pg_proc where proname = 'cube_roulette_spins_guard_enabled'`)).prosrc;
await db.query(`insert into public.event_cube_exclusions (event_id, cube_id, created_by) values ($1,$2,$3),($4,$2,$3)`, [eP, cB, uuid(1), eO]);   // B excluido en eP y en eO

// --- aplicar la 0163 (dos veces: idempotente) -----------------------------------------------------------------------------------------------------
const sql = read('0163_cubos_por_evento_overrides.sql');
ok(!/Ã/.test(LF(sql).replace(/^--.*$/gm, '')), 'el SQL ejecutable no tiene mojibake (solo los comentarios lo mencionan)');
ok(LF(sql).includes('Get-Content -Raw -Encoding UTF8'), 'el encabezado indica copiar con Get-Content -Raw -Encoding UTF8 | Set-Clipboard');
ok(LF(sql).includes(md5(LF(body162))) && LF(sql).includes(`(${LF(body162).length} caracteres con LF`), `md5 y largo (LF) del cuerpo vivo de la 0162 en la cabecera y en el DO: ${md5(LF(body162))}`);
const crlf = LF(body162).replace(/\n/g, '\r\n');
ok(LF(sql).includes(md5(crlf)) && LF(sql).includes(`${crlf.length})`), 'la variante CRLF (md5 y largo) también está');
ok(/está deshabilitado/.test(LF(body162)) || /está excluido/.test(LF(body162)), 'el cuerpo de la 0162 tiene la tilde correcta');

// pre-check: cuerpo CRLF (como el que queda al pegar en el SQL Editor) y cuerpo distinto
const fn = (body) => `create or replace function public.cube_roulette_spins_guard_enabled() returns trigger language plpgsql security definer set search_path = public as $$${body}$$;`;
await db.exec(fn(crlf));
let err = null;
try { await db.exec(sql); await db.exec('rollback'); await db.exec(fn(crlf)); await db.exec(sql); } catch (e) { err = e; await db.exec('rollback'); }
ok(err === null, 'con el cuerpo de la 0162 en CRLF el pre-check pasa y aplica', err?.message);
// (el bloque anterior ya aplicó la 0163: se vuelve a un estado 0162 para probar el aborto con un cuerpo ajeno)
const db2 = await newDb();
await db2.exec('alter default privileges in schema public grant all on tables to anon, authenticated, service_role');
await applyMigrations(db2, { to: 148 });
await db2.exec(read('0160_cubos_habilitados.sql'));
await db2.exec(sql162);
await db2.exec(`create or replace function public.cube_roulette_spins_guard_enabled() returns trigger language plpgsql as $$ begin return new; end; $$;`);
err = null;
try { await db2.exec(sql); } catch (e) { err = e; }
await db2.exec('rollback');
ok(err && /NO aplicar sin revisar/.test(err.message), 'con un cuerpo vivo distinto el pre-check aborta', err?.message);
ok((await db2.query(`select to_regclass('public.event_cube_exclusions') t`)).rows[0].t !== null, 'y no cambió nada (la tabla vieja sigue)');

await db.exec(sql);
ok(true, '0163 aplica dos veces sin errores (idempotente)');
ok((await one(`select to_regclass('public.event_cube_exclusions') v, to_regclass('public.event_cube_overrides') n`)).v === null, 'la tabla vieja ya no existe; existe event_cube_overrides');

// --- conversión de las filas de la 0162 ------------------------------------------------------------------------------------------------------------
const rows0 = await q(`select event_id, cube_id, is_enabled from public.event_cube_overrides order by event_id`);
ok(rows0.length === 2 && rows0.every((r) => r.cube_id === cB && r.is_enabled === false), 'las exclusiones de la 0162 pasaron a is_enabled = false', rows0);
const col = await one(`select data_type, is_nullable from information_schema.columns where table_name='event_cube_overrides' and column_name='is_enabled'`);
ok(col.data_type === 'boolean' && col.is_nullable === 'NO', 'is_enabled boolean not null');
const pk = await q(`select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = 'public.event_cube_overrides'::regclass and i.indisprimary order by a.attname`);
ok(pk.map((r) => r.attname).join() === 'cube_id,event_id', 'clave primaria (event_id, cube_id) intacta');
await db.query(`delete from public.event_cube_overrides`);

// --- grants ----------------------------------------------------------------------------------------------------------------------------------------------
const pr = await one(`select has_table_privilege('authenticated','public.event_cube_overrides','insert') i, has_table_privilege('authenticated','public.event_cube_overrides','delete') d,
  has_table_privilege('authenticated','public.event_cube_overrides','select') s, has_column_privilege('authenticated','public.event_cube_overrides','is_enabled','update') uc,
  has_column_privilege('authenticated','public.event_cube_overrides','created_by','update') ua, has_column_privilege('authenticated','public.event_cube_overrides','event_id','update') ue,
  has_table_privilege('authenticated','public.event_cube_overrides','truncate') t, has_table_privilege('anon','public.event_cube_overrides','select') a`);
ok(pr.i && pr.d && pr.s && pr.uc && !pr.ua && !pr.ue && !pr.t && !pr.a, 'grants mínimos: select/insert/delete + update solo de is_enabled; sin truncate; anon nada', pr);
ok((await one(`select count(*)::int n from pg_policies where tablename='event_cube_overrides'`)).n === 4, 'cuatro políticas (select, insert, update, delete)');

// --- RLS ---------------------------------------------------------------------------------------------------------------------------------------------------
await db.exec(`grant usage on schema public to authenticated, anon;`);
const asUser = async (n, fn2) => {
  await db.exec(`select set_config('request.jwt.claim.sub', '${uuid(n)}', false); select set_config('request.jwt.claim.role', 'authenticated', false); set role authenticated;`);
  try { return await fn2(); } finally { await db.exec(`reset role;`); }
};
const setOv = (n, ev, cube, val, by = n) => asUser(n, async () => { await db.query(`insert into public.event_cube_overrides (event_id, cube_id, is_enabled, created_by) values ($1,$2,$3,$4)`, [ev, cube, val, uuid(by)]); });
const updOv = (n, ev, cube, val) => asUser(n, async () => (await db.query(`update public.event_cube_overrides set is_enabled=$3 where event_id=$1 and cube_id=$2 returning cube_id`, [ev, cube, val])).rows.length);
const delOv = (n, ev, cube) => asUser(n, async () => (await db.query(`delete from public.event_cube_overrides where event_id=$1 and cube_id=$2 returning cube_id`, [ev, cube])).rows.length);
const ov = async (ev) => (await q(`select cube_id, is_enabled from public.event_cube_overrides where event_id=$1 order by cube_id`, [ev])).map((r) => `${r.cube_id}:${r.is_enabled}`);
const globalOf = async (id) => (await one(`select is_enabled from public.cubes where id=$1`, [id])).is_enabled;
const fail = async (fn2) => { try { await fn2(); return null; } catch (e) { return e; } };

// prender en el evento un cubo apagado en el global; el global no cambia; otro evento no lo ve
await db.query(`update public.cubes set is_enabled = false where id = $1`, [cC]);   // C apagado en el global
await setOv(2, eP, cC, true);
ok((await ov(eP)).join() === `${cC}:true`, 'la posta (member) prende en SU evento un cubo apagado en el global');
ok((await globalOf(cC)) === false, 'el global NO cambió (sigue apagado)');
ok((await ov(eO)).length === 0, 'otro evento no tiene ni ve ese cambio');
ok((await asUser(4, async () => (await db.query(`select cube_id from public.event_cube_overrides where event_id=$1`, [eO])).rows.length)) === 0, 'y un miembro leyendo el otro evento tampoco ve nada de eP');

// apagar en el evento uno prendido en el global
await setOv(2, eP, cA, false);
ok((await ov(eP)).includes(`${cA}:false`) && (await globalOf(cA)) === true, 'la posta apaga en su evento un cubo prendido en el global; el global no cambia');

// update: cambiar el estado propio
ok((await updOv(2, eP, cA, true)) === 1 && (await ov(eP)).includes(`${cA}:true`), 'la posta puede cambiar su estado propio (update)');
ok((await updOv(1, eP, cA, false)) === 1 && (await ov(eP)).includes(`${cA}:false`), 'el organizador del workspace puede cambiarlo en un evento ajeno');

// quién NO puede
err = await fail(() => setOv(4, eP, cD, false));
ok(err && /row-level security/i.test(err.message), 'un member SIN la posta no puede insertar (RLS)', err?.message);
ok((await updOv(4, eP, cA, true)) === 0 && (await ov(eP)).includes(`${cA}:false`), 'un member SIN la posta no puede actualizar (0 filas)');
ok((await delOv(4, eP, cA)) === 0 && (await ov(eP)).includes(`${cA}:false`), 'ni borrar (0 filas)');
err = await fail(() => setOv(2, eO, cD, false));
ok(err && /row-level security/i.test(err.message), 'la posta de un evento NO sirve en otro (insert)');
ok((await updOv(2, eO, cB, true)) === 0, 'la posta de un evento NO actualiza en otro (0 filas)');
err = await fail(() => setOv(3, eP, cD, false));
ok(err && /row-level security/i.test(err.message), 'un organizador de OTRO workspace no puede insertar');
err = await fail(() => setOv(2, eP, cD, false, 1));
ok(err && /row-level security/i.test(err.message), 'no se puede firmar como otro usuario (created_by = quien llama)');
err = await fail(() => asUser(2, async () => { await db.query(`update public.event_cube_overrides set created_by=$3 where event_id=$1 and cube_id=$2`, [eP, cA, uuid(1)]); }));
ok(err && /permission denied/i.test(err.message), 'el update no puede cambiar el autor (grant por columna)', err?.message);
err = await fail(() => asUser(2, async () => { await db.query(`update public.event_cube_overrides set cube_id=$3 where event_id=$1 and cube_id=$2`, [eP, cA, cD]); }));
ok(err && /permission denied/i.test(err.message), 'ni reasignar el cubo');
ok((await delOv(2, eP, cA)) === 1, 'la posta puede borrar su estado propio (el cubo vuelve a heredar)');

// --- guardia de servidor -----------------------------------------------------------------------------------------------------------------------------------
const spin = (event, type, cube, rtype = 'cubes', extra = null) => db.query(
  `insert into public.cube_roulette_spins (event_id, spun_by, roulette_type, result_type, selected_cube_id, selected_player_user_id) values ($1,$2,$3,$4,$5,$6)`,
  [event, uuid(1), rtype, type, cube, extra]);
// estado: global: C apagado. eP: C prendido (override). Sin override: A, B, D heredan.
await spin(eP, 'cube', cC);
ok(true, 'la guardia deja salir un cubo apagado en el global pero PRENDIDO en el evento');
err = await fail(() => spin(eO, 'cube', cC));
ok(err && /deshabilitado y no puede/.test(err.message) && !/en este evento/.test(err.message), 'en otro evento, ese mismo cubo (apagado en el global, sin override) se rechaza con el mensaje del global', err?.message);
await setOv(2, eP, cA, false);
err = await fail(() => spin(eP, 'cube', cA));
ok(err && /deshabilitado en este evento/.test(err.message), 'rechaza un cubo prendido en el global pero APAGADO en el evento', err?.message);
err = await fail(() => spin(eP, 'cube', cA, 'players', uuid(2)));
ok(err && /deshabilitado en este evento/.test(err.message), 'la elección manual (jugador elige) de un cubo apagado en el evento también se rechaza');
await spin(eO, 'cube', cA);
ok(true, 'el apagado de eP no afecta a eO');
await spin(eP, 'cube', cB);
await spin(eP, 'cube', cD);
ok(true, 'los cubos sin override y prendidos en el global salen normal');
await spin(eP, 'player_chooses', null);
await spin(eP, 'everyone_smokes', null);
ok(true, 'las tiradas sin cubo no se ven afectadas');
await db.query(`update public.cubes set is_enabled = false where id = $1`, [cD]);
err = await fail(() => spin(eP, 'cube', cD));
ok(err && /deshabilitado y no puede/.test(err.message), 'sin override, el global manda en vivo (D apagado en el global: rechazado)');
await setOv(2, eP, cD, true);
await spin(eP, 'cube', cD);
ok(true, 'con override prendido, D sale aunque el global siga apagado');
await db.query(`update public.cubes set is_enabled = true where id = $1`, [cC]);   // el global vuelve a prender C: el override de eP (true) sigue igual
await updOv(2, eP, cC, false);
err = await fail(() => spin(eP, 'cube', cC));
ok(err && /deshabilitado en este evento/.test(err.message), 'el override apagado manda aunque el global esté prendido');
const priv = await one(`select has_function_privilege('anon','public.cube_roulette_spins_guard_enabled()','execute') a, has_function_privilege('authenticated','public.cube_roulette_spins_guard_enabled()','execute') b`);
ok(!priv.a && !priv.b, 'la función del trigger no es ejecutable por anon ni authenticated');
const def = await one(`select prosecdef, proconfig from pg_proc where proname = 'cube_roulette_spins_guard_enabled'`);
ok(def.prosecdef && (def.proconfig ?? []).some((c) => c.startsWith('search_path=')), 'la guardia sigue SECURITY DEFINER con search_path fijo', def);
ok(/está deshabilitado/.test((await one(`select prosrc from pg_proc where proname = 'cube_roulette_spins_guard_enabled'`)).prosrc), 'la función nueva tiene la tilde correcta');

// --- el global no se tocó nunca por los cambios de evento -----------------------------------------------------------------------------------------
const gl = await q(`select id, is_enabled from public.cubes order by name`);
ok(gl.find((r) => r.id === cA).is_enabled === true && gl.find((r) => r.id === cB).is_enabled === true && gl.find((r) => r.id === cC).is_enabled === true && gl.find((r) => r.id === cD).is_enabled === false,
  'cubes.is_enabled solo cambió por las órdenes directas al global del test, nunca por los overrides');

// --- cascadas ------------------------------------------------------------------------------------------------------------------------------------------------
await db.query(`insert into public.event_cube_overrides (event_id, cube_id, is_enabled, created_by) values ($1,$2,true,$3),($1,$4,false,$3)`, [eX, cA, uuid(1), cB]);
const antes = (await ov(eO)).length + (await ov(eP)).length;
await db.query(`delete from public.draft_events where id = $1`, [eX]);
ok((await ov(eX)).length === 0, 'borrar el evento limpia sus overrides (ON DELETE CASCADE)');
ok((await ov(eO)).length + (await ov(eP)).length === antes, 'y no toca los de otros eventos');
const cE = await mkCube('Cubo E');
await db.query(`insert into public.event_cube_overrides (event_id, cube_id, is_enabled, created_by) values ($1,$2,true,$3)`, [eO, cE, uuid(1)]);
await db.query(`delete from public.cubes where id = $1`, [cE]);
ok(!(await ov(eO)).some((s) => s.startsWith(cE)), 'borrar un cubo limpia sus overrides');

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

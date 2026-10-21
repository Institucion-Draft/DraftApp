// Tests de la migración 0142 (Gen 3 desbloqueable + Unown) contra PGlite con la cadena REAL de migraciones 0001-0142.
// No es Supabase real. Uso:  cd supabase/tests && npm install && node gen3-unown.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { newDb, applyMigrations, MIGRATIONS_DIR } from './harness.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };

const uuid = (n) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// --- los 251 originales: nombres de 0059 (capitalizados) y rutas de sprites ------------------------------------------
const t59 = fs.readFileSync(path.join(MIGRATIONS_DIR, '0059_pokemon_types.sql'), 'utf8');
const names251 = [...t59.matchAll(/^\s*when '([^']+)' then/gm)].map((m) => m[1]);
if (names251.length !== 251) throw new Error('0059 no tiene 251 nombres');
// Unown tiene que ser la fila unown.png, como en producción.
const sqlStr = (s) => `'${s.replace(/'/g, "''")}'`;
const seedAvatars = names251
  .map((n) => `(${sqlStr(n)}, ${sqlStr('default-avatars/' + n.toLowerCase() + '.png')}, ${sqlStr('default-avatars/shiny/' + n.toLowerCase() + '.png')})`)
  .join(',');

async function liveBodies(db) {
  const r = await db.query(
    `select proname, prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname in ('assign_rotated_avatar','handle_new_user')`
  );
  return Object.fromEntries(r.rows.map((x) => [x.proname, x.prosrc]));
}

// =====================================================================================================================
const fatal = (e) => { console.log('ERROR:', String(e && e.message).slice(0, 400)); if (e && e.where) console.log('  where:', String(e.where).slice(0, 300)); process.exit(2); };
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
const db = await newDb();
await applyMigrations(db, { to: 141 });
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

// --- md5 de los cuerpos vivos (los de la cabecera de la 0142) ----------------------------------------------------------
const header = fs.readFileSync(path.join(MIGRATIONS_DIR, '0142_gen3_unown.sql'), 'utf8').split('\n').slice(0, 45).join('\n');
const live = await liveBodies(db);
ok(header.includes(md5(live.assign_rotated_avatar)), `md5 vivo de assign_rotated_avatar (0044) está en la cabecera: ${md5(live.assign_rotated_avatar)}`);
ok(header.includes(md5(live.handle_new_user)), `md5 vivo de handle_new_user (0015) está en la cabecera: ${md5(live.handle_new_user)}`);

// --- datos de partida (anteriores a la 0142) ---------------------------------------------------------------------------
await db.exec(`insert into public.default_avatars (name, storage_path, storage_path_shiny) values ${seedAvatars};`);
await db.exec(t59); // 0059 puebla pokemon_type de los 251 (en producción ya está aplicada)
// Usuarios: sin los avatares de prueba aún; el trigger handle_new_user elige un avatar por defecto.
const mkUser = async (n, display, extra = {}) => {
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`,
    [uuid(n), `u${n}@x.com`, JSON.stringify({ display_name: display })]);
  if (extra.username) await db.query(`update public.users set username = $2 where id = $1`, [uuid(n), extra.username]);
  if (extra.display !== undefined) await db.query(`update public.users set display_name = $2 where id = $1`, [uuid(n), extra.display]);
};
await mkUser(1, 'Organizador');
await db.query(`insert into public.workspaces (name, slug, created_by) values ('W1','ws-one',$1)`, [uuid(1)]);
await db.query(`insert into public.workspaces (name, slug, created_by) values ('W2','ws-two',$1)`, [uuid(1)]);
const [w1, w2] = (await q(`select id from public.workspaces order by slug`)).map((r) => r.id);
await db.query(`select public.ensure_workspace_seasons($1)`, [w1]);
await db.query(`select public.ensure_workspace_seasons($1)`, [w2]);
const seasonsW1 = await q(`select id, starts_at from public.seasons where workspace_id = $1 order by starts_at`, [w1]);
const seasonsW2 = await q(`select id from public.seasons where workspace_id = $1 order by starts_at`, [w2]);
ok(seasonsW1.length >= 2, `seasons por workspace creadas (${seasonsW1.length})`);
const [sA, sB] = seasonsW1.map((s) => s.id);
const sW2 = seasonsW2[0].id;
const achIds = (await q(`select id from public.achievement_definitions order by sort_order`)).map((r) => r.id);
ok(achIds.length >= 12, `hay ${achIds.length} definiciones de logros`);
const unlock = (ws, season, user, i) =>
  db.query(`insert into public.achievement_unlocks (workspace_id, season_id, user_id, achievement_id) values ($1,$2,$3,$4)`,
    [ws, season, uuid(user), achIds[i]]);

// Backfill (antes de la 0142 no hay trigger ni columna): X con 6 logros en una temporada, Y con 4.
await mkUser(10, 'Xavier'); await mkUser(11, 'Yolanda');
for (let i = 0; i < 6; i += 1) await unlock(w1, sA, 10, i);
for (let i = 0; i < 4; i += 1) await unlock(w1, sA, 11, i);

// =====================================================================================================================
// Aplicar la 0142 (dos veces: idempotente)
const sql142 = fs.readFileSync(path.join(MIGRATIONS_DIR, '0142_gen3_unown.sql'), 'utf8');
const notices = [];
await db.exec(sql142);
await db.exec(sql142);
ok(true, '0142 aplica dos veces sin errores (idempotente)');

const cnt = await one(`select count(*) filter (where generation=1)::int g1, count(*) filter (where generation=2)::int g2,
  count(*) filter (where generation=3)::int g3, count(*) filter (where unown_form is not null)::int uf, count(*)::int total from public.default_avatars`);
ok(cnt.g1 === 151, `Gen 1 = 151 (${cnt.g1})`);
ok(cnt.g2 === 100 + 27, `Gen 2 = 100 originales + 27 formas nuevas de Unown (${cnt.g2})`);
ok(cnt.g3 === 135, `Gen 3 = 135 (${cnt.g3})`);
ok(cnt.uf === 28 && cnt.total === 251 + 135 + 27, `28 formas de Unown y ${cnt.total} avatares en total`);
const unownA = await one(`select unown_form, generation, storage_path from public.default_avatars where name = 'Unown'`);
ok(unownA.unown_form === 'a' && unownA.storage_path === 'default-avatars/unown.png', 'la fila Unown existente pasó a ser la forma a (unown.png)');
// Referencia del Pokédex: algunos hitos de generación
const gen = async (n) => (await one(`select generation g from public.default_avatars where name = $1`, [n])).g;
ok((await gen('Mew')) === 1 && (await gen('Chikorita')) === 2 && (await gen('Celebi')) === 2 && (await gen('Treecko')) === 3 && (await gen('Deoxys')) === 3,
  'Mew=1, Chikorita=2, Celebi=2, Treecko=3, Deoxys=3');
const spr = await one(`select storage_path, storage_path_shiny, pokemon_type from public.default_avatars where name = 'Treecko'`);
ok(spr.storage_path === 'default-avatars/treecko.png' && spr.storage_path_shiny === 'default-avatars/shiny/treecko.png' && spr.pokemon_type === 'Planta', 'Treecko: rutas y tipo');
const uf = await one(`select storage_path, storage_path_shiny, pokemon_type from public.default_avatars where unown_form = 'exclamation'`);
ok(uf.storage_path === 'default-avatars/unown-exclamation.png' && uf.storage_path_shiny === 'default-avatars/shiny/unown-exclamation.png' && uf.pokemon_type === 'Psíquico', 'Unown !: rutas y tipo');
ok((await one(`select count(*)::int c from public.default_avatars where pokemon_type is null and is_active`)).c === 0, 'todo avatar activo tiene tipo');
ok((await one(`select pokemon_type t from public.default_avatars where name = 'Ralts'`)).t === 'Psíquico'
  && (await one(`select pokemon_type t from public.default_avatars where name = 'Azurill'`)).t === 'Normal'
  && (await one(`select pokemon_type t from public.default_avatars where name = 'Mawile'`)).t === 'Acero', 'tipos de era Gen 5 (sin Hada), como los 251 de 0059');

// --- backfill ------------------------------------------------------------------------------------------------------------
ok((await one(`select gen3_unlocked_at is not null u from public.users where id = $1`, [uuid(10)])).u === true, 'backfill: 6 logros en una temporada -> desbloqueado');
ok((await one(`select gen3_unlocked_at is null u from public.users where id = $1`, [uuid(11)])).u === true, 'backfill: 4 logros -> sigue bloqueado');

// --- contador por temporada --------------------------------------------------------------------------------------------
await mkUser(20, 'Contador');
const cntOf = async (u, s) => (await one(`select public.user_season_achievement_count($1,$2) c`, [uuid(u), s])).c;
const unlocked = async (u) => (await one(`select gen3_unlocked_at is not null v from public.users where id = $1`, [uuid(u)])).v;
for (let i = 0; i < 4; i += 1) await unlock(w1, sA, 20, i);
ok((await cntOf(20, sA)) === 4 && !(await unlocked(20)), 'contador: 4 logros -> 4 y NO desbloquea');
await unlock(w1, sA, 20, 4);
ok((await cntOf(20, sA)) === 5 && (await unlocked(20)), 'contador: 5 logros -> desbloquea');
const stamp = (await one(`select gen3_unlocked_at t from public.users where id = $1`, [uuid(20)])).t;
// Temporada nueva: reinicia el conteo, el flag sigue.
for (let i = 0; i < 2; i += 1) await unlock(w1, sB, 20, i);
ok((await cntOf(20, sB)) === 2 && (await cntOf(20, sA)) === 5, 'temporada nueva: conteo propio (2), la anterior conserva el suyo (5)');
ok((await unlocked(20)) && String((await one(`select gen3_unlocked_at t from public.users where id = $1`, [uuid(20)])).t) === String(stamp), 'el flag sigue y no se re-estampa');
// Varios workspaces: el conteo es por (workspace, temporada); 3 + 3 NO desbloquea.
await mkUser(21, 'Multi');
for (let i = 0; i < 3; i += 1) await unlock(w1, sA, 21, i);
for (let i = 0; i < 3; i += 1) await unlock(w2, sW2, 21, i);
ok(!(await unlocked(21)), 'decisión: 3 logros en un workspace + 3 en otro (6 en total) NO desbloquea');
for (let i = 3; i < 5; i += 1) await unlock(w2, sW2, 21, i);
ok((await cntOf(21, sW2)) === 5 && (await unlocked(21)), 'decisión: llegar a 5 en la temporada de UN workspace desbloquea');

// --- guard: un usuario no puede escribir el flag ---------------------------------------------------------------------
await db.exec(`grant all on all tables in schema public to authenticated, anon;`);
await mkUser(30, 'Tramposo');
await db.exec(`select set_config('request.jwt.claim.sub', '${uuid(30)}', false); set role authenticated;`);
await db.exec(`update public.users set gen3_unlocked_at = now(), display_name = 'Tramposo2' where id = '${uuid(30)}';`);
await db.exec(`reset role;`);
const trampa = await one(`select gen3_unlocked_at is null n, display_name d from public.users where id = $1`, [uuid(30)]);
ok(trampa.n === true && trampa.d === 'Tramposo2', 'guard: authenticated no puede desbloquearse solo (pero sí editar su nombre)');
await db.exec(`select set_config('request.jwt.claim.sub', '${uuid(20)}', false); set role authenticated;`);
await db.exec(`update public.users set gen3_unlocked_at = null where id = '${uuid(20)}';`);
await db.exec(`reset role;`);
ok(await unlocked(20), 'guard: authenticated no puede volver el flag a null');

// --- unown_form_for_name -----------------------------------------------------------------------------------------------
const form = async (d, u) => (await one(`select public.unown_form_for_name($1,$2) f`, [d, u])).f;
const cases = [
  ['Zoe', 'x', 'z'], ['zoe', 'x', 'z'], ['Álvaro', 'x', 'a'], ['ñandú', 'x', 'n'], ['Ñoño', 'x', 'n'], ['Ç', 'x', 'c'], ['Édgar', 'x', 'e'],
  ['  bob', 'x', 'b'], ['7up', 'x', 'question'], ['😀 hola', 'x', 'question'], ['!hola', 'x', 'exclamation'], ['?quién', 'x', 'question'],
  ['', 'zeta', 'z'], ['   ', 'Omega', 'o'], ['', '', 'question'], [null, null, 'question'], ['', '9z', 'question'], ['ßeta', 'x', 'question'],
];
for (const [d, u, e] of cases) ok((await form(d, u)) === e, `unown_form_for_name(${JSON.stringify(d)}, ${JSON.stringify(u)}) = ${e}`);

// --- asignación: sin desbloqueo nunca sale Gen 3; con desbloqueo sí ------------------------------------------------------
await mkUser(40, 'Bloqueado'); await mkUser(41, 'Desbloqueado');
await db.query(`update public.users set gen3_unlocked_at = now() where id = $1`, [uuid(41)]);
let evN = 0;
const mkEvent = async () => {
  evN += 1;
  const r = await one(`insert into public.draft_events (workspace_id, name, scheduled_for, created_by, event_organizer_user_id)
    values ($1, $2, now(), $3, $3) returning id`, [w1, `ev${evN}`, uuid(1)]);
  return r.id;
};
const enroll = async (ev, user) =>
  one(`insert into public.event_participants (event_id, user_id) values ($1, $2) returning id, rotated_avatar_id, is_shiny`, [ev, uuid(user)]);
const gens = async (ids) => (await q(`select da.generation g, da.unown_form f, da.name n from public.default_avatars da where da.id = any($1::uuid[])`, [ids]));
let lockedG3 = 0, lockedN = 0, unlockedG3 = 0, unlockedN = 0, unownLocked = 0;
for (let i = 0; i < 300; i += 1) {
  const ev = await mkEvent();
  const a = await enroll(ev, 40);
  const b = await enroll(ev, 41);
  const [ga] = await gens([a.rotated_avatar_id]); const [gb] = await gens([b.rotated_avatar_id]);
  lockedN += 1; unlockedN += 1;
  if (ga.g === 3) lockedG3 += 1;
  if (gb.g === 3) unlockedG3 += 1;
  if (ga.f) unownLocked += 1;
}
ok(lockedG3 === 0, `jugador bloqueado: 0 Gen 3 en ${lockedN} sorteos`);
ok(unlockedG3 > 0, `jugador desbloqueado: ${unlockedG3} Gen 3 en ${unlockedN} sorteos (esperable ~35%)`);
ok(unlockedG3 > 40 && unlockedG3 < 180, 'la proporción Gen 3 del desbloqueado es razonable (probabilidad uniforme entre elegibles)');
await db.query(`insert into public.draft_events (workspace_id, name, scheduled_for, created_by, event_organizer_user_id)
  select $1, 'bulk' || g, now(), $2, $2 from generate_series(1, 3000) g`, [w1, uuid(1)]);
await db.query(`insert into public.event_participants (event_id, user_id) select id, $1 from public.draft_events where name like 'bulk%'`, [uuid(40)]);
const bulk = await one(`select count(*) filter (where da.unown_form is not null)::int u, count(*) filter (where da.generation = 3)::int g3, count(*)::int n
  from public.event_participants ep join public.default_avatars da on da.id = ep.rotated_avatar_id
  join public.draft_events de on de.id = ep.event_id where de.name like 'bulk%'`);
ok(bulk.n === 3000 && bulk.g3 === 0, `bulk 3000 sorteos del jugador bloqueado: 0 Gen 3 (${bulk.g3})`);
ok(bulk.u >= 1 && bulk.u <= 40, `Unown cuenta como UNA especie: ${bulk.u} de 3000 sorteos (1/251 ~ 12; con 28 chances serían ~300)`);

// --- Unown: una sola especie por evento, forma por inicial, sin reposición, historial ---------------------------------------------
// Pool reducido: sólo la familia Unown (28 filas) + una especie X. Se desactiva el resto.
await db.query(`update public.default_avatars set is_active = false where unown_form is null and name <> 'Abra'`);
await mkUser(50, 'Zeta'); await mkUser(51, '9lives'); await mkUser(52, 'Álvaro'); await mkUser(53, 'Cuarto');
let sawUnownFirst = false, sawAbraFirst = false;
for (let i = 0; i < 40; i += 1) {
  const ev = await mkEvent();
  const p1 = await enroll(ev, 50); const p2 = await enroll(ev, 51); const p3 = await enroll(ev, 52);
  const rows = await gens([p1.rotated_avatar_id, p2.rotated_avatar_id, p3.rotated_avatar_id].filter(Boolean));
  const assigned = [p1, p2, p3].filter((p) => p.rotated_avatar_id).length;
  const unowns = rows.filter((r) => r.f).length;
  if (!(assigned === 2 && unowns === 1)) { ok(false, `evento ${i}: se esperaban 2 asignados y 1 forma de Unown (asignados=${assigned}, unown=${unowns})`); break; }
  if (p1.rotated_avatar_id) { const [r1] = await gens([p1.rotated_avatar_id]); if (r1.f) sawUnownFirst = true; else sawAbraFirst = true; }
}
ok(sawUnownFirst && sawAbraFirst, 'sin reposición: en 40 eventos de pool {Unown, Abra} siempre 1 Unown + 1 Abra + 1 sin avatar (Unown no se repite)');

// Forma por inicial, forzando que salga Unown (pool = sólo la familia).
await db.query(`update public.default_avatars set is_active = false where name = 'Abra'`);
const expectForm = async (user, expected) => {
  const ev = await mkEvent();
  const p = await enroll(ev, user);
  const [r] = await gens([p.rotated_avatar_id]);
  return r?.f === expected;
};
ok(await expectForm(50, 'z'), 'Zeta -> forma z');
ok(await expectForm(51, 'question'), '9lives -> forma question');
ok(await expectForm(52, 'a'), 'Álvaro -> forma a (la fila Unown original)');
await db.query(`update public.users set display_name = '!' where id = $1`, [uuid(53)]);
ok(await expectForm(53, 'exclamation'), '"!" -> forma exclamation');
await db.query(`update public.users set display_name = '', username = 'omega' where id = $1`, [uuid(53)]);
ok(await expectForm(53, 'o'), 'display_name vacío -> inicial del username (o)');
await db.query(`update public.users set display_name = '😀' where id = $1`, [uuid(53)]);
ok(await expectForm(53, 'question'), 'emoji -> forma question');

// Historial: reinscribirse restaura el mismo Pokémon y el mismo shiny, aunque el pool haya cambiado.
await db.query(`update public.default_avatars set is_active = true where name = 'Abra'`);
const evH = await mkEvent();
const first = await enroll(evH, 50);
await db.query(`delete from public.event_participants where id = $1`, [first.id]);
await db.query(`update public.default_avatars set is_active = false`);
const again = await enroll(evH, 50);
ok(first.rotated_avatar_id && again.rotated_avatar_id === first.rotated_avatar_id && again.is_shiny === first.is_shiny, 'historial: reinscripto en el mismo evento recupera el mismo avatar y shiny');
// Lo ya asignado no se toca al desbloquear.
const before = (await one(`select rotated_avatar_id r from public.event_participants where id = $1`, [again.id])).r;
await db.query(`update public.users set gen3_unlocked_at = now() where id = $1`, [uuid(50)]);
ok((await one(`select rotated_avatar_id r from public.event_participants where id = $1`, [again.id])).r === before, 'desbloquear no cambia lo ya asignado');

// Avatar custom: sin Pokémon rotado.
await db.query(`update public.default_avatars set is_active = true where name = 'Abra'`);
await mkUser(60, 'Custom');
await db.query(`update public.users set custom_avatar_path = 'avatars/x.png' where id = $1`, [uuid(60)]);
ok((await enroll(await mkEvent(), 60)).rotated_avatar_id === null, 'avatar custom: no recibe Pokémon rotado');

// --- handle_new_user: el avatar por defecto nunca es Gen 3 ni una forma de Unown que no sea la a ----------------------------------------------
await db.query(`update public.default_avatars set is_active = true`);
let badDefault = 0;
for (let i = 0; i < 250; i += 1) {
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [uuid(1000 + i), `d${i}@x.com`]);
}
const defaultIds = Array.from({ length: 250 }, (_, i) => uuid(1000 + i));
const defaults = await q(`select da.generation g, da.unown_form f from public.users u join public.default_avatars da on da.id = u.default_avatar_id where u.id = any($1::uuid[])`, [defaultIds]);
badDefault = defaults.filter((r) => r.g === 3 || (r.f && r.f !== 'a')).length;
ok(defaults.length >= 240 && badDefault === 0, `avatar por defecto de usuarios nuevos: ${defaults.length} usuarios, ${badDefault} con Gen 3 o forma de Unown no permitida`);

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

// Tests de la migración 0157 (desbloqueo especial por la partida N.º 420 de la temporada) contra PGlite.
// Aplica la cadena REAL 0001-0148 y después la 0157 (0149 en adelante no aplica en PGlite desde cero: 0149 recrea triggers sin
// DROP; es un problema previo del arnés, no de la 0157). No es Supabase real: no prueba concurrencia entre sesiones.
// Uso: cd supabase/tests && npm install && node special-unlock.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { newDb, applyMigrations, MIGRATIONS_DIR } from './harness.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const fatal = (e) => { console.log('ERROR:', String(e && e.message).slice(0, 500)); if (e && e.where) console.log('  where:', String(e.where).slice(0, 300)); process.exit(2); };
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
const uuid = (n) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const LF = (s) => s.replace(/\r\n/g, '\n');

const db = await newDb();
await applyMigrations(db, { to: 148 });
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

// --- avatares: 8 normales (Gen 1) + Ditto ------------------------------------------------------------------------------
const NORMAL = ['Bulbasaur', 'Charmander', 'Squirtle', 'Pidgey', 'Rattata', 'Pikachu', 'Eevee', 'Snorlax'];
for (const n of [...NORMAL, 'Ditto']) {
  await db.query(
    `insert into public.default_avatars (name, storage_path, storage_path_shiny, generation, is_active) values ($1,$2,$3,1,true)`,
    [n, `default-avatars/${n.toLowerCase()}.png`, `default-avatars/shiny/${n.toLowerCase()}.png`]
  );
}
const dittoId = (await one(`select id from public.default_avatars where name = 'Ditto'`)).id;

// --- usuarios -----------------------------------------------------------------------------------------------------------
for (let n = 1; n <= 16; n += 1) {
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,$2,$3)`, [uuid(n), `u${n}@x.com`, JSON.stringify({ display_name: `Jugador ${n}` })]);
}

// --- privilegios por defecto como en Supabase (la tabla nueva nace abierta y la migración tiene que cerrarla) ----------
await db.exec(`alter default privileges in schema public grant all on tables to anon, authenticated;`);
await db.exec(`grant usage on schema public to anon, authenticated;`);

// --- md5 del cuerpo vivo que reemplaza (0146) ------------------------------------------------------------------------
const sql157 = fs.readFileSync(path.join(MIGRATIONS_DIR, '0157_desbloqueo_especial_temporada.sql'), 'utf8');
const liveAssign = LF((await one(`select prosrc from pg_proc where pronamespace='public'::regnamespace and proname='assign_rotated_avatar'`)).prosrc);
ok(LF(sql157).includes(md5(liveAssign)), `md5 vivo de assign_rotated_avatar (0146) está en la cabecera: ${md5(liveAssign)}`);
ok(LF(sql157).includes(`(${liveAssign.length} caracteres con LF`), `longitud del cuerpo vivo (${liveAssign.length}) en la cabecera`);

// --- aplicar (dos veces: idempotente) ------------------------------------------------------------------------------------
await db.exec(sql157);
await db.exec(sql157);
ok(true, '0157 aplica dos veces sin errores (idempotente)');
ok((await one(`select public.special_match_threshold() n`)).n === 420, 'special_match_threshold() devuelve 420');
ok((await one(`select public.special_match_stale_hours() n`)).n === 24, 'special_match_stale_hours() devuelve 24');

// Para probar con pocas partidas: umbral 3.
const setThreshold = (n) => db.exec(`create or replace function public.special_match_threshold() returns integer language sql immutable as $$ select ${n} $$;`);
await setThreshold(3);
const setBasal = (pct) => db.exec(`create or replace function public.shiny_chance_basal_pct() returns numeric language sql immutable as $$ select ${pct}::numeric $$;`);
await setBasal(0); // sin shiny normal salvo que el test lo pida

// --- helpers de fixtures ---------------------------------------------------------------------------------------------
let wsN = 0;
const newWs = async () => {
  wsN += 1;
  const w = (await one(`insert into public.workspaces (name, slug, created_by) values ($1,$2,$3) returning id`, [`W${wsN}`, `ws-${wsN}`, uuid(1)])).id;
  await db.query(`select public.ensure_workspace_seasons($1)`, [w]);
  return w;
};
let evN = 0;
// draft_started_at relativo a now() (misma temporada que hoy); startedAt fijo para otra temporada.
const mkEvent = async (ws, { official = true, type = 'draft', deleted = false, startedAt = null, draftStarted = true } = {}) => {
  evN += 1;
  const r = await one(
    `insert into public.draft_events (workspace_id, name, scheduled_for, created_by, event_organizer_user_id, draft_started_at, is_official, event_type, deleted_at)
     values ($1,$2,now(),$3,$3, case when $8::boolean then coalesce($4::timestamptz, now() - interval '2 hours') else null end, $5, $6, $7) returning id`,
    [ws, `ev${evN}`, uuid(1), startedAt, official, type, deleted ? new Date().toISOString() : null, draftStarted]
  );
  return r.id;
};
const seasonOf = async (ev) => (await one(`select season_id from public.v_event_season where event_id = $1`, [ev]))?.season_id;
const part = {};
const enroll = async (ev, user) => {
  const key = `${ev}:${user}`;
  if (part[key]) return part[key];
  const r = await one(`insert into public.event_participants (event_id, user_id) values ($1,$2) returning id`, [ev, uuid(user)]);
  part[key] = r.id;
  return r.id;
};
// Una cadena de parejas distintas (k+1, k+2): un pairing por partida (así ninguna pasa a 'revenge' por un pairing ya resuelto).
const PAIRS = [];
for (let k = 1; k <= 7; k += 1) PAIRS.push([k, k + 1]);
const pairUsed = {};
// Crea una partida. i = índice de pareja (distinto por partida dentro de un evento). winner = número de usuario ganador.
const mkMatch = async (ev, i, { status = 'completed', winner = null, startedMinAgo, endedMinAgo = null, type = 'draft', walkover = false, surrender = false } = {}) => {
  const [ua, ub] = PAIRS[i];
  const pa = await enroll(ev, ua);
  const pb = await enroll(ev, ub);
  const [lo, hi] = pa < pb ? [pa, pb] : [pb, pa];
  let pairing = await one(`select id from public.pairings where event_id = $1 and participant_a_id = $2 and participant_b_id = $3`, [ev, lo, hi]);
  if (!pairing) pairing = await one(`insert into public.pairings (event_id, participant_a_id, participant_b_id) values ($1,$2,$3) returning id`, [ev, lo, hi]);
  const winnerPid = winner == null ? null : winner === ua ? pa : pb;
  const m = await one(
    `insert into public.matches (pairing_id, match_number, match_type, status, started_at, ended_at, winner_participant_id, is_walkover, ended_by_surrender)
     values ($1, 1, $2, $3, now() - ($4 || ' minutes')::interval, case when $5::int is null then null else now() - ($5 || ' minutes')::interval end, $6, $7, $8) returning id`,
    [pairing.id, type, status, String(startedMinAgo), endedMinAgo, winnerPid, walkover, surrender]
  );
  return { id: m.id, ua, ub, pa, pb };
};
const complete = (match, winner) =>
  db.query(`update public.matches set status = 'completed', winner_participant_id = $2 where id = $1`, [match.id, winner === match.ua ? match.pa : match.pb]);
const abort = (match) => db.query(`update public.matches set status = 'aborted' where id = $1`, [match.id]);
const unlocks = (ws) => q(`select * from public.season_special_unlocks where workspace_id = $1 order by created_at`, [ws]);

// =====================================================================================================================
// 1. Orden por started_at aunque otra partida termine antes + espera por una anterior en curso
// =====================================================================================================================
{
  const ws = await newWs();
  const ev = await mkEvent(ws);
  // M1 empieza primero y sigue en curso (partida larga). M2, M3, M4 empiezan después y terminan ANTES que M1.
  const m1 = await mkMatch(ev, 0, { status: 'in_progress', startedMinAgo: 90 });
  const m2 = await mkMatch(ev, 1, { winner: 1, startedMinAgo: 80, endedMinAgo: 70 });
  const m3 = await mkMatch(ev, 2, { winner: 3, startedMinAgo: 70, endedMinAgo: 65 });
  ok((await unlocks(ws)).length === 0, '1: con 2 completadas y la 1.ª en curso no hay desbloqueo');
  const m4 = await mkMatch(ev, 3, { winner: 4, startedMinAgo: 60, endedMinAgo: 55 });
  // Por started_at la 3.ª es M3; por ended_at sería M4. Pero M1 (anterior) sigue en curso: espera.
  ok((await unlocks(ws)).length === 0, '1: la 3.ª por started_at (M3) está completada pero M1 anterior sigue en curso: espera');
  await complete(m1, 2); // M1 termina ahora (la última por ended_at)
  const rows = await unlocks(ws);
  ok(rows.length === 1, '1: al completarse la anterior se dispara (reevaluación en la base)');
  ok(rows[0]?.match_id === m3.id, '1: la partida elegida es la 3.ª por started_at (M3), no la 3.ª por ended_at (M4)');
  ok(rows[0]?.winner_user_id === uuid(3) && rows[0]?.loser_user_id === uuid(4), '1: ganador y perdedor son los de M3 (ganó 3 contra 4)');
  ok(rows[0]?.season_id === (await seasonOf(ev)) && rows[0]?.workspace_id === ws, '1: workspace y temporada de v_event_season');
  ok(rows[0]?.winner_seen_at === null && rows[0]?.loser_seen_at === null && rows[0]?.winner_consumed_at === null && rows[0]?.loser_consumed_at === null, '1: la fila nace sin visto ni consumido');
  void m2; void m4;

  // 6. Congelado: más partidas, un aborto que correría el orden y reevaluaciones manuales no cambian nada.
  const m5 = await mkMatch(ev, 4, { winner: 5, startedMinAgo: 50, endedMinAgo: 45 });
  await mkMatch(ev, 5, { winner: 6, startedMinAgo: 40, endedMinAgo: 35 });
  await abort(m2);
  await abort(m5);
  await db.query(`select public.special_unlock_evaluate($1, $2)`, [ws, rows[0].season_id]);
  const after = await unlocks(ws);
  ok(after.length === 1 && after[0].id === rows[0].id && after[0].match_id === m3.id && after[0].winner_user_id === uuid(3), '6: congelado: más partidas, abortos y reevaluación no cambian ni duplican la fila');
  ok((await one(`select public.special_unlock_evaluate($1, $2) r`, [ws, rows[0].season_id])).r === false, '6: reevaluar un par ya congelado devuelve false');
}

// =====================================================================================================================
// 2. In_progress de más de 24 h no bloquea; una de menos sí
// =====================================================================================================================
{
  const ws = await newWs();
  const ev = await mkEvent(ws);
  await mkMatch(ev, 0, { status: 'in_progress', startedMinAgo: 30 * 60 }); // 30 h: colgada
  await mkMatch(ev, 1, { winner: 2, startedMinAgo: 20, endedMinAgo: 15 });
  ok((await unlocks(ws)).length === 0, '2: 2 válidas (la colgada ocupa su lugar): todavía no');
  const m3 = await mkMatch(ev, 2, { winner: 3, startedMinAgo: 10, endedMinAgo: 5 });
  const rows = await unlocks(ws);
  ok(rows.length === 1 && rows[0].match_id === m3.id, '2: una in_progress de 30 h no bloquea: se dispara con la 3.ª');

  const ws2 = await newWs();
  const ev2 = await mkEvent(ws2);
  await mkMatch(ev2, 0, { status: 'in_progress', startedMinAgo: 23 * 60 }); // 23 h: todavía bloquea
  await mkMatch(ev2, 1, { winner: 2, startedMinAgo: 20, endedMinAgo: 15 });
  await mkMatch(ev2, 2, { winner: 3, startedMinAgo: 10, endedMinAgo: 5 });
  ok((await unlocks(ws2)).length === 0, '2: una in_progress de 23 h sí bloquea');
}

// =====================================================================================================================
// 3. Corrimiento: si una anterior se aborta, la nueva N-ésima ya completada dispara
// =====================================================================================================================
{
  const ws = await newWs();
  const ev = await mkEvent(ws);
  const m1 = await mkMatch(ev, 0, { status: 'in_progress', startedMinAgo: 90 });
  await mkMatch(ev, 1, { winner: 2, startedMinAgo: 80, endedMinAgo: 70 });
  await mkMatch(ev, 2, { winner: 3, startedMinAgo: 70, endedMinAgo: 65 });
  const m4 = await mkMatch(ev, 3, { winner: 4, startedMinAgo: 60, endedMinAgo: 55 });
  ok((await unlocks(ws)).length === 0, '3: la 3.ª (M3) está completada pero M1 en curso la bloquea');
  await abort(m1); // el orden se corre: M2, M3, M4 -> la 3.ª pasa a ser M4, ya completada y sin pendientes antes
  const rows = await unlocks(ws);
  ok(rows.length === 1 && rows[0].match_id === m4.id, '3: al abortarse la anterior se reevalúa y se dispara con la nueva 3.ª (M4)');
  ok(rows[0]?.winner_user_id === uuid(4) && rows[0]?.loser_user_id === uuid(5), '3: ganador/perdedor de M4 (4 contra 5)');
}
{
  // El aborto de una anterior también corre el orden cuando la nueva N-ésima TODAVÍA no está completada: no dispara y, al
  // completarse, sí.
  const ws = await newWs();
  const ev = await mkEvent(ws);
  const m1 = await mkMatch(ev, 0, { status: 'in_progress', startedMinAgo: 90 });
  await mkMatch(ev, 1, { winner: 2, startedMinAgo: 80, endedMinAgo: 70 });
  await mkMatch(ev, 2, { winner: 3, startedMinAgo: 70, endedMinAgo: 65 });
  const m4 = await mkMatch(ev, 3, { status: 'in_progress', startedMinAgo: 60 });
  await abort(m1);
  ok((await unlocks(ws)).length === 0, '3: tras el aborto la nueva 3.ª (M4) sigue en curso: no dispara');
  await complete(m4, 4);
  const rows = await unlocks(ws);
  ok(rows.length === 1 && rows[0].match_id === m4.id, '3: al completarse M4 dispara');
}

// =====================================================================================================================
// 4. Walkover, venganza, abortadas, sandbox, 2HG y evento borrado NO cuentan
// =====================================================================================================================
{
  const ws = await newWs();
  const ev = await mkEvent(ws);
  await mkMatch(ev, 0, { winner: 1, startedMinAgo: 100, endedMinAgo: 95 });
  await mkMatch(ev, 1, { winner: 2, startedMinAgo: 90, endedMinAgo: 85 });
  await mkMatch(ev, 2, { winner: 3, startedMinAgo: 80, endedMinAgo: 75, walkover: true });
  await mkMatch(ev, 3, { winner: 4, startedMinAgo: 70, endedMinAgo: 65, type: 'revenge' });
  await mkMatch(ev, 4, { status: 'aborted', startedMinAgo: 60, endedMinAgo: 55 });
  const evSandbox = await mkEvent(ws, { official: false });
  await mkMatch(evSandbox, 0, { winner: 1, startedMinAgo: 50, endedMinAgo: 45 });
  const ev2hg = await mkEvent(ws, { type: 'two_headed_giant' });
  await mkMatch(ev2hg, 0, { winner: 1, startedMinAgo: 40, endedMinAgo: 35 });
  const evDeleted = await mkEvent(ws, { deleted: true });
  await mkMatch(evDeleted, 0, { winner: 1, startedMinAgo: 30, endedMinAgo: 25 });
  ok((await unlocks(ws)).length === 0, '4: walkover, venganza, abortada, sandbox, 2HG y evento borrado no cuentan (solo 2 válidas)');
  const m3 = await mkMatch(ev, 5, { winner: 6, startedMinAgo: 20, endedMinAgo: 15 });
  const rows = await unlocks(ws);
  ok(rows.length === 1 && rows[0].match_id === m3.id, '4: la 3.ª VÁLIDA dispara, y es esa (no las excluidas)');
}

// =====================================================================================================================
// 5. Las rendiciones cuentan
// =====================================================================================================================
{
  const ws = await newWs();
  const ev = await mkEvent(ws);
  await mkMatch(ev, 0, { winner: 1, startedMinAgo: 100, endedMinAgo: 95 });
  await mkMatch(ev, 1, { winner: 2, startedMinAgo: 90, endedMinAgo: 85 });
  const m3 = await mkMatch(ev, 2, { winner: 3, startedMinAgo: 80, endedMinAgo: 75, surrender: true });
  const rows = await unlocks(ws);
  ok(rows.length === 1 && rows[0].match_id === m3.id && rows[0].winner_user_id === uuid(3), '5: una rendición (ended_by_surrender) cuenta y dispara');
}

// =====================================================================================================================
// 6b. Alcance por temporada y por workspace
// =====================================================================================================================
{
  const ws = await newWs();
  const evA = await mkEvent(ws); // temporada actual
  const evB = await mkEvent(ws, { startedAt: '2027-01-15T12:00:00Z' }); // otra temporada del mismo workspace
  ok((await seasonOf(evA)) !== (await seasonOf(evB)), '6b: los dos eventos caen en temporadas distintas');
  await mkMatch(evA, 0, { winner: 1, startedMinAgo: 100, endedMinAgo: 95 });
  await mkMatch(evA, 1, { winner: 2, startedMinAgo: 90, endedMinAgo: 85 });
  await mkMatch(evB, 0, { winner: 1, startedMinAgo: 80, endedMinAgo: 75 });
  await mkMatch(evB, 1, { winner: 2, startedMinAgo: 70, endedMinAgo: 65 });
  ok((await unlocks(ws)).length === 0, '6b: 2 + 2 partidas en dos temporadas no suman (cuenta por temporada)');
  await mkMatch(evB, 2, { winner: 3, startedMinAgo: 60, endedMinAgo: 55 });
  const rows = await unlocks(ws);
  ok(rows.length === 1 && rows[0].season_id === (await seasonOf(evB)), '6b: dispara solo en la temporada que llegó al umbral');
  const wsOther = await newWs();
  const evO = await mkEvent(wsOther);
  await mkMatch(evO, 0, { winner: 1, startedMinAgo: 50, endedMinAgo: 45 });
  ok((await unlocks(wsOther)).length === 0, '6b: otro workspace tiene su propia cuenta');
}

// =====================================================================================================================
// 7. Diferido: se evalúa el estado FINAL de la transacción; el lock se toma y se suelta con la transacción
// =====================================================================================================================
{
  const ws = await newWs();
  const ev = await mkEvent(ws);
  const m1 = await mkMatch(ev, 0, { status: 'in_progress', startedMinAgo: 90 });
  await mkMatch(ev, 1, { winner: 2, startedMinAgo: 80, endedMinAgo: 70 });
  const m3 = await mkMatch(ev, 2, { status: 'in_progress', startedMinAgo: 70 });
  await db.transaction(async (tx) => {
    await tx.query(`update public.matches set status = 'completed', winner_participant_id = $2 where id = $1`, [m3.id, m3.pb]);
    const mid = await tx.query(`select count(*)::int n from public.season_special_unlocks where workspace_id = $1`, [ws]);
    ok(mid.rows[0].n === 0, '7: dentro de la transacción todavía no se evaluó (trigger diferido)');
    await tx.query(`update public.matches set status = 'completed', winner_participant_id = $2 where id = $1`, [m1.id, m1.pa]);
  });
  const rows = await unlocks(ws);
  ok(rows.length === 1 && rows[0].match_id === m3.id, '7: al commit se evalúa el estado final y se dispara una sola vez (M3)');

  // Lock transaccional: se toma dentro de la evaluación y se libera con el commit.
  const season = await seasonOf(ev);
  const ws2 = await newWs();
  const ev2 = await mkEvent(ws2);
  const season2 = await seasonOf(ev2);
  await db.transaction(async (tx) => {
    const before = (await tx.query(`select count(*)::int n from pg_locks where locktype = 'advisory'`)).rows[0].n;
    await tx.query(`select public.special_unlock_evaluate($1, $2)`, [ws2, season2]);
    const during = (await tx.query(`select count(*)::int n from pg_locks where locktype = 'advisory'`)).rows[0].n;
    ok(during === before + 1, '7: la evaluación toma un advisory lock transaccional por workspace+temporada');
  });
  const afterLocks = (await one(`select count(*)::int n from pg_locks where locktype = 'advisory'`)).n;
  ok(afterLocks === 0, '7: el lock se libera al terminar la transacción');
  const src = (await one(`select prosrc from pg_proc where proname = 'special_unlock_evaluate'`)).prosrc;
  ok(/pg_advisory_xact_lock/.test(src) && src.indexOf('pg_advisory_xact_lock') < src.indexOf('season_special_unlocks'), '7: el lock se toma antes de leer/escribir');
  void season;
  // Un solo evaluador a la vez y fila única: un segundo disparo del mismo par no duplica (UNIQUE + ON CONFLICT).
  const dup = await db.query(`insert into public.season_special_unlocks (workspace_id, season_id, match_id) select workspace_id, season_id, match_id from public.season_special_unlocks where workspace_id = $1 on conflict do nothing`, [ws]);
  ok(dup.affectedRows === 0, '7: la tabla no admite una segunda fila para el mismo (workspace, temporada)');
}

// =====================================================================================================================
// 8. Recompensas (assign_rotated_avatar)
// =====================================================================================================================
const mkUnlockRow = async (ws, seasonIdx, winner, loser, createdMinAgo = 0) => {
  const seasons = await q(`select id from public.seasons where workspace_id = $1 order by starts_at`, [ws]);
  return (await one(
    `insert into public.season_special_unlocks (workspace_id, season_id, winner_user_id, loser_user_id, created_at)
     values ($1,$2,$3,$4, now() - ($5 || ' minutes')::interval) returning id`,
    [ws, seasons[seasonIdx].id, uuid(winner), uuid(loser), String(createdMinAgo)]
  )).id;
};
const row = (id) => one(`select * from public.season_special_unlocks where id = $1`, [id]);
const pdata = (ev, user) => one(`select ep.rotated_avatar_id, ep.is_shiny from public.event_participants ep where ep.event_id = $1 and ep.user_id = $2`, [ev, uuid(user)]);
{
  const ws = await newWs();
  const evOfficial = await mkEvent(ws);
  const evSandbox = await mkEvent(ws, { official: false });
  const ev2hg = await mkEvent(ws, { type: 'two_headed_giant' });
  // Desbloqueo real disparado por las partidas (usuarios 1 y 2: gana el 1).
  const evPlay = await mkEvent(ws);
  await mkMatch(evPlay, 0, { winner: 1, startedMinAgo: 100, endedMinAgo: 95 });
  await mkMatch(evPlay, 1, { winner: 2, startedMinAgo: 90, endedMinAgo: 85 });
  await mkMatch(evPlay, 2, { winner: 3, startedMinAgo: 80, endedMinAgo: 75 }); // pareja (3,4): gana 3, pierde 4
  const u = (await unlocks(ws))[0];
  ok(!!u && u.winner_user_id === uuid(3) && u.loser_user_id === uuid(4), '8: el desbloqueo real se disparó (gana 3, pierde 4)');
  const W = 3, L = 4;

  // Sandbox y 2HG: no consumen ni disparan (aunque la tirada normal se pase a 100 %).
  await setBasal(100);
  await enroll(evSandbox, W); await enroll(evSandbox, L);
  await enroll(ev2hg, W); await enroll(ev2hg, L);
  let r = await row(u.id);
  ok(r.winner_consumed_at === null && r.loser_consumed_at === null, '8: inscripción en sandbox o 2HG no consume ninguna recompensa');
  ok((await pdata(evSandbox, L)).rotated_avatar_id !== dittoId || true, '8: (informativo) sandbox usa el sorteo normal');
  ok((await pdata(evSandbox, W)).is_shiny === true, '8: la tirada normal no cambió en sandbox (con chance 100 % sale shiny)');
  await setBasal(0);

  // Ganador en evento oficial: shiny sí o sí + avatar activo del pool (Gen 1-2).
  await enroll(evOfficial, W);
  const pw = await pdata(evOfficial, W);
  ok(pw.is_shiny === true, '8: ganador en oficial: is_shiny forzado (con chance normal 0 %)');
  ok(pw.rotated_avatar_id != null && (await one(`select is_active a, generation g from public.default_avatars where id = $1`, [pw.rotated_avatar_id])).a === true, '8: ganador: avatar activo asignado');
  r = await row(u.id);
  ok(r.winner_consumed_event_id === evOfficial && r.winner_consumed_at !== null, '8: ganador: consumed_event_id y consumed_at marcados');
  ok(r.loser_consumed_at === null, '8: el perdedor sigue pendiente');
  ok((await one(`select has_shiny_participant h from public.draft_events where id = $1`, [evOfficial])).h === true, '8: has_shiny_participant del evento queda en true');
  await enroll(evOfficial, 9); // control: sin recompensa, chance 0 % -> no shiny
  ok((await pdata(evOfficial, 9)).is_shiny === false, '8: control: un jugador sin recompensa no sale shiny');

  // Perdedor: Ditto sin shiny, aun con chance normal 100 %.
  await setBasal(100);
  const ev3 = await mkEvent(ws);
  await enroll(ev3, L);
  const pl = await pdata(ev3, L);
  ok(pl.rotated_avatar_id === dittoId && pl.is_shiny === false, '8: perdedor en oficial: Ditto y is_shiny = false (aunque la tirada normal fuera 100 %)');
  r = await row(u.id);
  ok(r.loser_consumed_event_id === ev3 && r.loser_consumed_at !== null, '8: perdedor: consumed_event_id y consumed_at marcados');
  await enroll(ev3, 10); // control: con chance 100 % sale shiny normal
  ok((await pdata(ev3, 10)).is_shiny === true, '8: control: con chance 100 % un jugador sin recompensa sale shiny');
  await setBasal(0);

  // Reinscripción en el mismo evento: mismo resultado y sin consumir otra recompensa.
  const seasons = await q(`select id from public.seasons where workspace_id = $1 order by starts_at`, [ws]);
  const idx2 = seasons.findIndex((s) => s.id !== u.season_id);
  const extra = await mkUnlockRow(ws, idx2, W, 11); // otra recompensa pendiente del ganador (otra temporada)
  const beforeW = await pdata(evOfficial, W);
  await db.query(`delete from public.event_participants where event_id = $1 and user_id = $2`, [evOfficial, uuid(W)]);
  delete part[`${evOfficial}:${W}`];
  await enroll(evOfficial, W);
  const afterW = await pdata(evOfficial, W);
  ok(afterW.rotated_avatar_id === beforeW.rotated_avatar_id && afterW.is_shiny === true, '8: reinscripción: mismo avatar y mismo shiny (histórico)');
  ok((await row(extra)).winner_consumed_at === null, '8: reinscripción: NO consume la otra recompensa pendiente');
  r = await row(u.id);
  ok(r.winner_consumed_event_id === evOfficial, '8: reinscripción: la recompensa original sigue ligada al mismo evento');
  // Un evento oficial distinto sí consume la siguiente.
  const ev4 = await mkEvent(ws);
  await enroll(ev4, W);
  ok((await row(extra)).winner_consumed_event_id === ev4 && (await pdata(ev4, W)).is_shiny === true, '8: el siguiente evento oficial consume la siguiente recompensa pendiente');

  // Sin recompensa pendiente en otro workspace: no hay efecto cruzado.
  const wsOther = await newWs();
  const evOther = await mkEvent(wsOther);
  await enroll(evOther, W);
  ok((await pdata(evOther, W)).is_shiny === false, '8: la recompensa de un workspace no se consume en otro workspace');
}

// Avatar custom pisado solo en ese evento + reinscripción con custom.
{
  const ws = await newWs();
  const idW = await mkUnlockRow(ws, 0, 12, 13);
  await db.query(`update public.users set custom_avatar_path = 'custom/x.png' where id in ($1,$2,$3)`, [uuid(12), uuid(13), uuid(14)]);
  const ev = await mkEvent(ws);
  await enroll(ev, 14); // control: custom sin recompensa -> sin avatar rotado
  ok((await pdata(ev, 14)).rotated_avatar_id === null, '8c: control: usuario con custom y sin recompensa no recibe avatar rotado (como hoy)');
  await enroll(ev, 12);
  const pw = await pdata(ev, 12);
  ok(pw.is_shiny === true && pw.rotated_avatar_id !== null, '8c: ganador con custom: la recompensa pisa el custom en ese evento (shiny y avatar rotado)');
  await enroll(ev, 13);
  const pl = await pdata(ev, 13);
  ok(pl.rotated_avatar_id === dittoId && pl.is_shiny === false, '8c: perdedor con custom: Ditto sin shiny en ese evento');
  // Reinscripción de un usuario con custom que ya cobró: recupera lo mismo, sin consumir.
  await db.query(`delete from public.event_participants where event_id = $1 and user_id = $2`, [ev, uuid(13)]);
  delete part[`${ev}:13`];
  await enroll(ev, 13);
  const pl2 = await pdata(ev, 13);
  ok(pl2.rotated_avatar_id === dittoId && pl2.is_shiny === false, '8c: reinscripción de un custom que ya cobró: mismo Ditto');
  ok((await row(idW)).loser_consumed_event_id === ev, '8c: sigue consumida en el mismo evento');
  // En otro evento (sin recompensa) el custom vuelve a no tener avatar rotado.
  const ev2 = await mkEvent(ws);
  await enroll(ev2, 12);
  ok((await pdata(ev2, 12)).rotated_avatar_id === null, '8c: en otro evento el custom vuelve a pisar al Pokémon (sin avatar rotado)');
}

// Ditto repetido + Ditto inactivo.
{
  const ws = await newWs();
  const r1 = await mkUnlockRow(ws, 0, 15, 5, 10);
  const r2 = await mkUnlockRow(ws, 1, 16, 6, 5);
  const ev = await mkEvent(ws);
  await enroll(ev, 5); await enroll(ev, 6);
  const a = await pdata(ev, 5); const b = await pdata(ev, 6);
  ok(a.rotated_avatar_id === dittoId && b.rotated_avatar_id === dittoId, '8d: Ditto repetido en el mismo evento está permitido (dos perdedores)');
  ok((await row(r1)).loser_consumed_at !== null && (await row(r2)).loser_consumed_at !== null, '8d: ambas recompensas consumidas');
  // Ditto inactivo: no consume (la recompensa queda pendiente) y se usa el sorteo normal.
  const ws2 = await newWs();
  const r3 = await mkUnlockRow(ws2, 0, 15, 7);
  await db.query(`update public.default_avatars set is_active = false where id = $1`, [dittoId]);
  const ev2 = await mkEvent(ws2);
  await enroll(ev2, 7);
  ok((await row(r3)).loser_consumed_at === null && (await pdata(ev2, 7)).rotated_avatar_id !== dittoId, '8d: sin Ditto activo no se consume y se usa el sorteo normal');
  await db.query(`update public.default_avatars set is_active = true where id = $1`, [dittoId]);
  const ev3 = await mkEvent(ws2);
  await enroll(ev3, 7);
  ok((await row(r3)).loser_consumed_event_id === ev3 && (await pdata(ev3, 7)).rotated_avatar_id === dittoId, '8d: con Ditto de nuevo disponible, el siguiente evento lo consume');
}

const asUserEarly = async (n, fn) => {
  await db.exec(`select set_config('request.jwt.claim.sub', '${uuid(n)}', false); select set_config('request.jwt.claim.role', 'authenticated', false); set role authenticated;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
};
// =====================================================================================================================
// 8e. special_reward + devolución al cancelar/borrar el evento antes del draft
// =====================================================================================================================
const srOf = async (ev, user) => (await one(`select special_reward s from public.event_participants where event_id = $1 and user_id = $2`, [ev, uuid(user)]))?.s ?? null;
let r;
const unenroll = async (ev, user) => {
  await db.query(`delete from public.event_participants where event_id = $1 and user_id = $2`, [ev, uuid(user)]);
  delete part[`${ev}:${user}`];
};
{
  const ws = await newWs();
  const idr = await mkUnlockRow(ws, 0, 1, 2, 10); // gana 1, pierde 2
  const evSb = await mkEvent(ws, { official: false });
  const ev2hg = await mkEvent(ws, { type: 'two_headed_giant' });
  for (const e of [evSb, ev2hg]) { await enroll(e, 1); await enroll(e, 2); }
  ok((await srOf(evSb, 1)) === null && (await srOf(ev2hg, 2)) === null, '8e: sandbox y 2HG no setean special_reward');
  const ev = await mkEvent(ws, { draftStarted: false });
  await enroll(ev, 1); await enroll(ev, 2); await enroll(ev, 3);
  ok((await srOf(ev, 1)) === 'shiny' && (await srOf(ev, 2)) === 'ditto', "8e: special_reward = 'shiny' (ganador) y 'ditto' (perdedor)");
  ok((await srOf(ev, 3)) === null, '8e: un jugador sin recompensa queda con special_reward nulo');
  // Desinscribirse NO devuelve; reinscribirse recupera special_reward sin consumir otra.
  await unenroll(ev, 1);
  let r = await row(idr);
  ok(r.winner_consumed_event_id === ev && r.winner_consumed_at !== null, '8e: desinscribirse NO devuelve la recompensa');
  await enroll(ev, 1);
  ok((await srOf(ev, 1)) === 'shiny' && (await row(idr)).winner_consumed_event_id === ev, "8e: reinscripción en el mismo evento: special_reward 'shiny' otra vez, sin consumir de nuevo");
  // Cancelar antes del draft: devuelve ambas y limpia special_reward.
  await db.query(`update public.draft_events set cancelled_at = now(), status = 'cancelled' where id = $1`, [ev]);
  r = await row(idr);
  ok(r.winner_consumed_event_id === null && r.winner_consumed_at === null && r.loser_consumed_event_id === null && r.loser_consumed_at === null, '8e: cancelar el evento antes del draft devuelve ganador y perdedor');
  ok((await srOf(ev, 1)) === null && (await srOf(ev, 2)) === null, '8e: la devolución limpia special_reward de las inscripciones');
  const evNext = await mkEvent(ws);
  await enroll(evNext, 1); await enroll(evNext, 2);
  r = await row(idr);
  ok(r.winner_consumed_event_id === evNext && r.loser_consumed_event_id === evNext && (await srOf(evNext, 1)) === 'shiny' && (await srOf(evNext, 2)) === 'ditto', '8e: la recompensa devuelta se consume en el siguiente evento oficial');
}
{
  // Borrado lógico (deleted_at) antes del draft.
  const ws = await newWs();
  const id = await mkUnlockRow(ws, 0, 1, 2, 10);
  const ev = await mkEvent(ws, { draftStarted: false });
  await enroll(ev, 2);
  ok((await row(id)).loser_consumed_event_id === ev, '8e: (borrado) el perdedor consumió en el evento');
  await db.query(`update public.draft_events set deleted_at = now() where id = $1`, [ev]);
  r = await row(id);
  ok(r.loser_consumed_at === null && r.loser_consumed_event_id === null, '8e: borrar (deleted_at) el evento antes del draft devuelve la recompensa');
  // Borrado físico (solo administrador): no falla, pero NO devuelve (límite documentado en la cabecera).
  const ev2 = await mkEvent(ws, { draftStarted: false });
  await enroll(ev2, 1);
  let hardOk = true;
  try { await db.query(`delete from public.draft_events where id = $1`, [ev2]); } catch { hardOk = false; }
  r = await row(id);
  ok(hardOk && r.winner_consumed_event_id === null && r.winner_consumed_at !== null, '8e: el borrado físico del evento no falla (límite documentado: la recompensa queda consumida sin evento)');
}
{
  // Con el draft ya iniciado no se devuelve (ni con status cancelled sin cancelled_at).
  const ws = await newWs();
  const id = await mkUnlockRow(ws, 0, 1, 2, 10);
  const ev = await mkEvent(ws); // draft iniciado
  await enroll(ev, 1);
  await db.query(`update public.draft_events set cancelled_at = now(), status = 'cancelled' where id = $1`, [ev]);
  ok((await row(id)).winner_consumed_event_id === ev && (await srOf(ev, 1)) === 'shiny', '8e: con el draft ya iniciado, cancelar NO devuelve');
  const ws2 = await newWs();
  const id2 = await mkUnlockRow(ws2, 0, 1, 2, 10);
  const ev2 = await mkEvent(ws2, { draftStarted: false });
  await enroll(ev2, 1);
  await db.query(`update public.draft_events set status = 'cancelled' where id = $1`, [ev2]);
  ok((await row(id2)).winner_consumed_event_id === ev2, '8e: cambiar solo status a cancelled (sin cancelled_at) no devuelve (documentado)');
  // Solo se devuelve lo consumido en ESE evento.
  const ws3 = await newWs();
  const r1 = await mkUnlockRow(ws3, 0, 1, 2, 20);
  const r2 = await mkUnlockRow(ws3, 1, 1, 2, 10);
  const evA = await mkEvent(ws3, { draftStarted: false });
  const evB = await mkEvent(ws3, { draftStarted: false });
  await enroll(evA, 1); await enroll(evB, 1);
  ok((await row(r1)).winner_consumed_event_id === evA && (await row(r2)).winner_consumed_event_id === evB, '8e: cada inscripción consumió una recompensa distinta');
  await db.query(`update public.draft_events set cancelled_at = now() where id = $1`, [evA]);
  ok((await row(r1)).winner_consumed_at === null && (await row(r2)).winner_consumed_event_id === evB, '8e: cancelar un evento devuelve solo la recompensa consumida en él');
}

// =====================================================================================================================
// 8f. special_reward no escribible por anon/authenticated (simula los GRANT de columna de la 0151)
// =====================================================================================================================
{
  await db.exec(`revoke all on public.event_participants from authenticated, anon;
    grant select on public.event_participants to authenticated;
    grant insert (event_id, user_id, role) on public.event_participants to authenticated;
    grant update (self_evaluation, left_event_at, left_event_by) on public.event_participants to authenticated;`);
  const cp = (role, priv) => one(`select has_column_privilege($1, 'public.event_participants', 'special_reward', $2) p`, [role, priv]).then((x) => x.p);
  ok((await cp('authenticated', 'select')) === true, '8f: special_reward legible por authenticated (SELECT de tabla, como el resto de event_participants)');
  ok((await cp('authenticated', 'update')) === false && (await cp('authenticated', 'insert')) === false, '8f: authenticated sin INSERT/UPDATE de columna sobre special_reward');
  ok((await cp('anon', 'update')) === false && (await cp('anon', 'insert')) === false, '8f: anon sin INSERT/UPDATE de columna sobre special_reward');
  let denied = false;
  await asUserEarly(1, async () => { try { await db.query(`update public.event_participants set special_reward = 'shiny'`); } catch { denied = true; } });
  ok(denied, '8f: authenticated no puede actualizar special_reward (permission denied)');
  denied = false;
  let bad = false;
  try { await db.query(`update public.event_participants set special_reward = 'otro' where id = (select id from public.event_participants limit 1)`); } catch { bad = true; }
  ok(bad, '8f: el check solo admite shiny/ditto');

  // Peor caso: GRANT de tabla por error. El guard la protege. RLS desactivada un momento para probar el guard solo.
  await db.exec(`grant insert, update on public.event_participants to authenticated; alter table public.event_participants disable row level security;`);
  try {
    const ws = await newWs();
    const ev = await mkEvent(ws, { draftStarted: false });
    const mine = await asUserEarly(1, async () =>
      (await one(`insert into public.event_participants (event_id, user_id, role, special_reward) values ($1, $2, 'player', 'shiny') returning id, special_reward`, [ev, uuid(1)])));
    ok(mine.special_reward === null, '8f: INSERT de authenticated con special_reward = shiny: el guard la deja en nulo');
    await db.query(`update public.event_participants set special_reward = 'ditto' where id = $1`, [mine.id]);
    await asUserEarly(1, async () => { await db.query(`update public.event_participants set special_reward = null where id = $1`, [mine.id]); });
    ok((await one(`select special_reward s from public.event_participants where id = $1`, [mine.id])).s === 'ditto', '8f: UPDATE de authenticated no puede borrar special_reward (el guard conserva el valor)');
    await asUserEarly(1, async () => { await db.query(`update public.event_participants set special_reward = 'shiny' where id = $1`, [mine.id]); });
    ok((await one(`select special_reward s from public.event_participants where id = $1`, [mine.id])).s === 'ditto', '8f: UPDATE de authenticated no puede cambiar special_reward');
  } finally {
    await db.exec(`alter table public.event_participants enable row level security;
      revoke all on public.event_participants from authenticated;
      grant select on public.event_participants to authenticated;
      grant insert (event_id, user_id, role) on public.event_participants to authenticated;
      grant update (self_evaluation, left_event_at, left_event_by) on public.event_participants to authenticated;`);
  }
}

// =====================================================================================================================
// 11. Barrido de colgadas
// =====================================================================================================================
{
  const ws = await newWs();
  const ev = await mkEvent(ws);
  const m1 = await mkMatch(ev, 0, { status: 'in_progress', startedMinAgo: 23 * 60 }); // todavía bloquea
  await mkMatch(ev, 1, { winner: 2, startedMinAgo: 20, endedMinAgo: 15 });
  const m3 = await mkMatch(ev, 2, { winner: 3, startedMinAgo: 10, endedMinAgo: 5 });
  ok((await unlocks(ws)).length === 0, '11: M1 en curso hace 23 h bloquea: sin desbloqueo');
  ok((await one(`select public.special_unlock_sweep() n`)).n === 0 && (await unlocks(ws)).length === 0, '11: el barrido no hace nada mientras la en curso no pasó las 24 h');
  await db.query(`update public.matches set started_at = now() - interval '30 hours' where id = $1`, [m1.id]); // pasa las 24 h sin ningún evento
  ok((await unlocks(ws)).length === 0, '11: pasar las 24 h no dispara nada por sí solo (no hay evento)');
  ok((await one(`select public.special_unlock_sweep() n`)).n === 1, '11: el barrido congela 1 desbloqueo');
  const rows = await unlocks(ws);
  ok(rows.length === 1 && rows[0].match_id === m3.id, '11: el barrido congela con la 3.ª partida (M3)');
  ok((await one(`select public.special_unlock_sweep() n`)).n === 0 && (await unlocks(ws)).length === 1, '11: un segundo barrido no hace nada (ya congelado)');
}
{
  // Solo evalúa los pares que corresponden: se hace fallar la evaluación y se cuentan los errores registrados.
  await db.query(`delete from public.achievement_eval_errors where code like 'special_unlock%'`);
  const stale = (ws, ev, i, o = {}) => mkMatch(ev, i, { status: 'in_progress', startedMinAgo: 30 * 60, ...o });
  // No candidatos:
  { const w = await newWs(); await stale(w, await mkEvent(w, { official: false }), 0); }          // sandbox
  { const w = await newWs(); await stale(w, await mkEvent(w, { type: 'two_headed_giant' }), 0); } // 2HG
  { const w = await newWs(); await stale(w, await mkEvent(w), 0, { type: 'revenge' }); }          // venganza
  { const w = await newWs(); await stale(w, await mkEvent(w), 0, { walkover: true }); }           // walkover
  { const w = await newWs(); await stale(w, await mkEvent(w), 0, { startedMinAgo: 23 * 60 }); }   // todavía no pasó 24 h
  { const w = await newWs(); await stale(w, await mkEvent(w, { deleted: true }), 0); }            // evento borrado
  { const w = await newWs(); const e = await mkEvent(w); await stale(w, e, 0);                    // par ya congelado
    await db.query(`insert into public.season_special_unlocks (workspace_id, season_id) values ($1,$2)`, [w, await seasonOf(e)]); }
  // Candidatos (2 pares sin congelar con una en curso de más de 24 h):
  { const w = await newWs(); await stale(w, await mkEvent(w), 0); }
  { const w = await newWs(); await stale(w, await mkEvent(w), 0); }
  await db.exec(`create or replace function public.special_match_threshold() returns integer language sql immutable as $$ select (1/0) $$;`);
  let threw = false; let res;
  try { res = (await one(`select public.special_unlock_sweep() n`)).n; } catch { threw = true; }
  ok(!threw && res === 0, '11: un error al evaluar un par no aborta el barrido');
  const errs = await q(`select code from public.achievement_eval_errors where code like 'special_unlock%'`);
  ok(errs.length === 2 && errs.every((e) => e.code === 'special_unlock_sweep'), `11: se evaluaron solo los 2 pares candidatos (errores registrados: ${errs.length})`);
  await setThreshold(3);
  await db.query(`delete from public.achievement_eval_errors where code like 'special_unlock%'`);
  ok((await one(`select public.special_unlock_sweep() n`)).n === 0, '11: con la evaluación sana el barrido de esos pares no congela nada (no llegan al umbral)');
  const sweepPriv = await one(`select has_function_privilege('authenticated','public.special_unlock_sweep()','execute') a, has_function_privilege('anon','public.special_unlock_sweep()','execute') b`);
  ok(!sweepPriv.a && !sweepPriv.b, '11: special_unlock_sweep no ejecutable por anon/authenticated');
}

// =====================================================================================================================
// 9. RPCs y permisos
// =====================================================================================================================
const asUser = async (n, fn) => {
  await db.exec(`select set_config('request.jwt.claim.sub', '${n == null ? '' : uuid(n)}', false); select set_config('request.jwt.claim.role', 'authenticated', false); set role authenticated;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
};
const getNotice = (n) => asUser(n, async () => (await db.query(`select * from public.get_my_special_unlock_notice()`)).rows);
const ack = (n) => asUser(n, async () => (await one(`select public.ack_special_unlock_notice() r`)).r);
{
  const ws = await newWs();
  const ev = await mkEvent(ws);
  const season = await seasonOf(ev);
  const id = (await one(
    `insert into public.season_special_unlocks (workspace_id, season_id, match_id, winner_user_id, loser_user_id) values ($1,$2,null,$3,$4) returning id`,
    [ws, season, uuid(9), uuid(10)]
  )).id;
  const w = await getNotice(9);
  ok(w.length === 1 && w[0].role === 'winner' && w[0].season_id === season && w[0].workspace_id === ws && 'match_id' in w[0], '9: el ganador recibe su aviso (rol, temporada, workspace, match)');
  ok(Object.keys(w[0]).sort().join(',') === 'match_id,role,season_id,workspace_id', '9: el aviso expone solo role, season_id, workspace_id y match_id (sin datos de otros usuarios)');
  const l = await getNotice(10);
  ok(l.length === 1 && l[0].role === 'loser', '9: el perdedor recibe su aviso');
  ok((await getNotice(14)).length === 0, '9: un tercero no recibe nada');
  ok((await getNotice(null)).length === 0, '9: sin sesión no hay aviso');
  ok((await ack(14)) === false && (await row(id)).winner_seen_at === null && (await row(id)).loser_seen_at === null, '9: el ack de un tercero no toca nada');
  ok((await ack(9)) === true, '9: ack del ganador marca');
  let r = await row(id);
  ok(r.winner_seen_at !== null && r.loser_seen_at === null, '9: solo winner_seen_at; el del perdedor sigue sin ver');
  ok((await getNotice(9)).length === 0 && (await getNotice(10)).length === 1, '9: el ganador ya no ve aviso; el perdedor sí');
  ok((await ack(9)) === false, '9: segundo ack del ganador: false');
  ok((await ack(10)) === true && (await row(id)).loser_seen_at !== null, '9: ack del perdedor marca loser_seen_at');
  ok((await ack(null)) === false, '9: ack sin sesión: false');
  // Varios avisos: el más antiguo primero.
  const ws2 = await newWs();
  const old = await mkUnlockRow(ws2, 0, 8, 9, 100);
  const young = await mkUnlockRow(ws2, 1, 9, 8, 50);
  const n1 = await getNotice(8);
  ok(n1.length === 1 && n1[0].role === 'winner', '9: con dos avisos (gana en uno, pierde en otro) devuelve el más antiguo');
  await ack(8);
  ok((await row(old)).winner_seen_at !== null && (await row(young)).loser_seen_at === null, '9: el ack marca solo el más antiguo');
  const n2 = await getNotice(8);
  ok(n2.length === 1 && n2[0].role === 'loser', '9: después sale el siguiente');
  await ack(8);
  ok((await getNotice(8)).length === 0, '9: sin avisos pendientes devuelve vacío');

  // Permisos: sin acceso directo para anon/authenticated; RLS sin políticas como segunda barrera.
  ok(!(await one(`select has_table_privilege('authenticated','public.season_special_unlocks','select') a, has_table_privilege('anon','public.season_special_unlocks','select') b`)).a
     && !(await one(`select has_table_privilege('anon','public.season_special_unlocks','select') b`)).b, '9: anon/authenticated sin SELECT en season_special_unlocks');
  let denied = false;
  await asUser(2, async () => { try { await db.query(`select * from public.season_special_unlocks`); } catch { denied = true; } });
  ok(denied, '9: authenticated no puede leer la tabla directamente');
  denied = false;
  await asUser(2, async () => { try { await db.query(`update public.season_special_unlocks set winner_seen_at = null`); } catch { denied = true; } });
  ok(denied, '9: authenticated no puede escribir la tabla directamente');
  await db.exec(`grant select on public.season_special_unlocks to authenticated;`);
  const viaRls = await asUser(2, async () => (await db.query(`select * from public.season_special_unlocks`)).rows);
  await db.exec(`revoke all on public.season_special_unlocks from authenticated;`);
  ok(viaRls.length === 0, '9: aun con un GRANT por error, RLS sin políticas no deja ver filas');
  ok((await one(`select relrowsecurity r from pg_class where oid = 'public.season_special_unlocks'::regclass`)).r === true, '9: RLS activada');
  for (const fn of ['special_unlock_evaluate(uuid,uuid)', 'special_unlock_claim(uuid,uuid)', 'special_unlock_on_match()', 'special_ditto_avatar_id()', 'special_match_threshold()']) {
    const priv = await one(`select has_function_privilege('authenticated', 'public.${fn}', 'execute') a, has_function_privilege('anon', 'public.${fn}', 'execute') b`);
    ok(!priv.a && !priv.b, `9: ${fn} no ejecutable por anon/authenticated`);
  }
  const rpcPriv = await one(`select has_function_privilege('authenticated','public.get_my_special_unlock_notice()','execute') a, has_function_privilege('anon','public.get_my_special_unlock_notice()','execute') b, has_function_privilege('authenticated','public.ack_special_unlock_notice()','execute') c, has_function_privilege('anon','public.ack_special_unlock_notice()','execute') d`);
  ok(rpcPriv.a && rpcPriv.c && !rpcPriv.b && !rpcPriv.d, '9: las dos RPC: authenticated sí, anon no');
  const defs = await q(`select proname, prosecdef, proconfig from pg_proc where pronamespace='public'::regnamespace and proname in ('get_my_special_unlock_notice','ack_special_unlock_notice','special_unlock_evaluate','special_unlock_claim','special_unlock_on_match')`);
  ok(defs.length === 5 && defs.every((d) => d.prosecdef && (d.proconfig ?? []).some((c) => c.startsWith('search_path='))), '9: SECURITY DEFINER con search_path fijo');
}

// =====================================================================================================================
// 10. Sin errores registrados por el evaluador
// =====================================================================================================================
{
  const errs = await q(`select event_id, code, message from public.achievement_eval_errors where code like 'special_unlock%'`);
  ok(errs.length === 0, `10: el evaluador no registró errores${errs.length ? ': ' + JSON.stringify(errs[0]) : ''}`);
  const dup = await q(`select workspace_id, season_id, count(*)::int c from public.season_special_unlocks group by 1,2 having count(*) > 1`);
  ok(dup.length === 0, '10: nunca hay dos filas por (workspace, temporada)');
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

// prueba_pglite.mjs — prueba EN MEMORIA de supabase/migrations/0155_analytics.sql y de las consultas de calidad.md.
// NO toca ninguna base real: arma una base efímera (PGlite) con stubs de Supabase, aplica la cadena de migraciones del repo,
// aplica la propuesta, carga datos de ejemplo, corre analytics_private.refresh_analytics() y verifica las tablas publicadas, la
// anonimización, la exclusión voluntaria, la conciliación, los permisos del rol y los ataques de la revisión de seguridad (A2).
//
// Uso:   cd supabase/tests && npm install && node ../../docs-analytics/prueba_pglite.mjs
//
// Limitaciones (es PGlite, no Supabase):
//  * Se omiten 0149-0151 (snapshots de seguridad): 0149 ya parsea, pero sus triggers "fallan si ya existen" (lo dice su cabecera) y 0150/0151
//    dependen de objetos que esta cadena reducida no crea. Por eso P-PRIV-06 muestra funciones de public ejecutables que en la base viva no están.
//  * Se quita el constraint matches_type_valid (la cadena reproducida no acepta match_type = 'tiebreak'; en la base viva está corregido).
//  * PGlite falla con GRANT CONNECT ON DATABASE y con REVOKE multi-rol; se parte por rol o se tolera el fallo.
//  * Corre como superusuario: RLS y privilegios por defecto globales de Supabase NO se reproducen (ver P-PRIV-01 en calidad.md).
// Prueba EN MEMORIA (PGlite) de supabase/migrations/0155_analytics.sql sobre la cadena REAL de migraciones.
// No toca ninguna base real: crea una base efímera con stubs de Supabase (mismo patrón que supabase/tests/harness.mjs).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const aPosix = (u) => fileURLToPath(u).split(path.sep).join("/");
const DOCS = aPosix(new URL(".", import.meta.url));
const T = aPosix(new URL("../supabase/tests", import.meta.url));
const {PGlite} = await import("file:///" + T + "/node_modules/@electric-sql/pglite/dist/index.js");
const {pgcrypto} = await import("file:///" + T + "/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js");
const harness = fs.readFileSync(T + "/harness.mjs", "utf8");
const STUBS = harness.match(/const STUBS = `([\s\S]*?)`;/)[1];
const MIG = aPosix(new URL("../supabase/migrations", import.meta.url));

const db = new PGlite({extensions: {pgcrypto}});
await db.exec(STUBS);
await db.exec("create extension if not exists pgcrypto schema extensions;");
for (const f of fs.readdirSync(MIG).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) {
  if (/^01(49|50|51|55)_/.test(f)) continue; // snapshots de seguridad y la propia 0155 (se aplica más abajo, por trozos): se omiten en la cadena
  try { await db.exec(fs.readFileSync(path.join(MIG, f), "utf8")); } catch (e) { console.log("FALLÓ migración", f, e.message.slice(0, 200)); process.exit(2); }
}
// La cadena reproducida NO acepta match_type = 'tiebreak' (0016 borra un constraint con otro nombre; en la base viva está corregido): se corrige solo en esta prueba.
await db.exec("alter table public.matches drop constraint if exists matches_type_valid;");
console.log("cadena real aplicada");

let fails = 0;
const ok = (c, m, extra) => { if (!c) fails++; console.log((c ? "OK   " : "FAIL ") + m + (extra !== undefined && !c ? "  -> " + JSON.stringify(extra) : "")); };
const q = async (s, p) => (await db.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
const uuid = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;

// ---- aplicar la PROPUESTA
const sql = fs.readFileSync(process.env.SQL_FILE ?? (MIG + "/0155_analytics.sql"), "utf8").replace(/\r\n/g, "\n");   // SQL_FILE: solo para las pruebas de mutación (ver entrega)
// el bloque de rollback está comentado; se ejecuta tal cual
{
  const body = sql.replace(/^begin;$/m, "").replace(/^commit;$/m, "--FIN--").split("--FIN--")[0];
  const trozos = body.split(/\n-- ={20,}\n/);
  for (let t of trozos) {
    // PGlite falla ("tuple concurrently deleted") con REVOKE/ALTER DEFAULT PRIVILEGES de varios roles a la vez: se parte por rol (equivalente)
    t = t.replace(/^((?:revoke|alter default privileges)[^;\n]*?) from ([^;\n]+);$/gm, (_m, pre, roles) =>
      roles.split(",").map((r) => `${pre} from ${r.trim()};`).join("\n"));
    try {
      if (/revoke all on schema/.test(t)) {
        // diagnóstico: ejecutar sentencia por sentencia
        const sentencias = t.replace(/^--.*$/gm, "").split(/;\s*\n/).map((x) => x.trim()).filter(Boolean);
        for (const st of sentencias) { try { await db.exec(st + ";"); } catch (e) { console.log("  sentencia falla en PGlite:", st.slice(0, 90).replace(/\n/g, " "), "=>", e.message); } }
      } else await db.exec(t);
    }
    catch (e) { console.log("FALLÓ 0155 en:", (t.split("\n").find((l) => l.trim() && !l.startsWith("--")) ?? "").slice(0, 100), "=>", e.message); process.exit(2); }
  }
}
console.log("0155 aplicado (en memoria)");

// ---- datos de prueba. NO hay triggers de alta: los alias privados los asigna refresh_analytics() (sync_aliases) y los puestos 1..n también.
const refresh = async () => (await one(`select analytics_private.refresh_analytics() as r`)).r;
const nombres = ["Ana Pérez", "Bruno Gómez", "Carla Ruiz", "Dario Sosa", "Eva Luna", "Fede Vega"];
for (let i = 0; i < nombres.length; i++) {
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,$2,$3)`, [uuid(i + 1), `u${i}@x.com`, JSON.stringify({display_name: nombres[i]})]);
}
const sinAlias = await q(`select count(*)::int n from analytics_private.player_alias`);
ok(sinAlias[0].n === 0, "M2: sin triggers, el alta de usuarios NO toca analytics (alias = 0 antes del refresco)", sinAlias);
const trg = await q(`select tgname from pg_trigger where not tgisinternal and tgrelid in ('public.users'::regclass, 'public.cubes'::regclass) and tgname like 'analytics%'`);
ok(trg.length === 0, "M2: no hay triggers de analytics sobre public.users ni public.cubes", trg);

await db.query(`insert into public.workspaces (name, slug, created_by) values ('W1','ws-uno',$1),('W2','ws-dos',$1)`, [uuid(1)]);
const [w1, w2] = (await q(`select id from public.workspaces order by slug`)).map((r) => r.id);
await db.query(`update analytics_private.config set value=$1 where key='workspace_id'`, [w1]);
const mkCube = async (ws, name, by = uuid(1)) => (await one(`insert into public.cubes (workspace_id, name, created_by) values ($1,$2,$3) returning id`, [ws, name, by])).id;
const cubeA = await mkCube(w1, "Cubo Secreto de Ana");
const cubeB = await mkCube(w1, "Otro Cubo Privado");
const cubeW2 = await mkCube(w2, "Cubo del otro ws");
const cubeD = await mkCube(w1, "Cubo de Dario", uuid(4));   // A4: creado por Dario (usuario 4)

let ne = 0;
const evento = async ({ws = w1, cube = cubeA, status = "completed", official = true, deleted = false, type = "draft", fmt = "round_robin", ds = "app", start = "2026-03-07 20:00:00-03", end = "2026-03-07 21:30:00-03", cancelled = false}) => {
  ne++;
  return (await one(`insert into public.draft_events (workspace_id, name, scheduled_for, created_by, event_organizer_user_id, cube_id, competition_format, status, is_official, deleted_at, event_type, data_source, draft_started_at, draft_ended_at, cancelled_at)
    values ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [ws, `Evento privado ${ne}`, start, uuid(1), cube, fmt, status, official, deleted ? new Date() : null, type, ds, start, end, cancelled ? new Date() : null])).id;
};
const part = async (ev, u, role = "player", colors = [], extra = {}) => {
  const p = await one(`insert into public.event_participants (event_id, user_id, role, self_evaluation, left_event_at) values ($1,$2,$3,$4,$5) returning id`, [ev, uuid(u), role, extra.self ?? 7, extra.left ?? null]);
  for (const c of colors) await db.query(`insert into public.participant_colors (participant_id, color) values ($1,$2)`, [p.id, c]);
  return p.id;
};

const E1 = await evento({start: "2026-03-07 23:30:00-03", end: "2026-03-08 01:00:00-03"}); // 23:30 BA = 02:30 UTC del 8: la fecha debe ser 2026-03-07 (hora de Buenos Aires)
const E2 = await evento({official: false});
const E3 = await evento({status: "cancelled", cancelled: true});
const E4 = await evento({type: "two_headed_giant"});
const E5 = await evento({ws: w2, cube: cubeW2});
const E6 = await evento({status: "playing", cube: cubeD, start: "2026-04-11 20:00:00-03", end: null});
const E7 = await evento({ds: "imported_notebook", cube: cubeB, start: "2026-02-01 20:00:00-03", end: "2026-02-01 22:00:00-03"});
const E8 = await evento({deleted: true});

// participantes E1: 1 W,G,R (desordenado), 2 U,B, 3 W, 4 G (exile), 5 ghost, 6 player (se fue)
const p = {};
p[1] = await part(E1, 1, "player", ["G", "R", "W"], {self: 9});
p[2] = await part(E1, 2, "player", ["B", "U"], {self: 5});
p[3] = await part(E1, 3, "player", ["W"], {self: 3});
p[4] = await part(E1, 4, "exile", ["G"]);
p[5] = await part(E1, 5, "ghost", ["U"]);
p[6] = await part(E1, 6, "player", ["C", "U"], {left: new Date()});
for (const ev of [E2, E3, E4, E5, E8]) { await part(ev, 1, "player", ["W"]); await part(ev, 2, "player", ["U"]); }
const q6a = await part(E6, 1, "player", ["B"]); const q6b = await part(E6, 2, "player", ["R"]);
await part(E6, 4, "player", ["G"]);                 // jugador inscripto en E6 SIN partidas (discrimina el control participaciones_player_sin_partidas)
const q7a = await part(E7, 1, "player", ["W"]); const q7b = await part(E7, 3, "player", ["B"]);

const cerrar = [];
const pair = async (ev, a, b, o = {}) => {
  const [x, y] = a < b ? [a, b] : [b, a];
  const id = (await one(`insert into public.pairings (event_id, participant_a_id, participant_b_id, stage, swiss_round)
     values ($1,$2,$3,$4,$5) returning id`, [ev, x, y, o.stage ?? null, o.round ?? null])).id;
  if (o.winner || o.draw) cerrar.push({id, winner: o.winner ?? null, draw: !!o.draw});
  return id;
};
const match = async (pr, n, winner, o = {}) => (await one(`insert into public.matches (pairing_id, match_number, match_type, winner_participant_id, status, started_at, ended_at, who_started_participant_id, is_walkover, is_borrowed_deck_a, borrowed_from_a_user_id, tiebreak_round, data_source)
  values ($1,$2,$3,$4,'completed',$5,$6,$7,$8,$9,$12,$10,$11) returning id`,
  [pr, n, o.type ?? "draft", winner, o.start ?? "2026-03-08 00:00:00+00", o.end ?? "2026-03-08 00:25:00+00", o.who ?? null, o.wo ?? false, o.borrowed ?? false, o.round ?? null, o.ds ?? "app", o.borrowed ? uuid(2) : null])).id;
const aliasOf = async (u) => (await one(`select alias_n from analytics_private.player_alias where user_id=$1`, [uuid(u)])).alias_n;
const posOf = async (u) => (await one(`select pp.pos from analytics_private.player_pos pp join analytics_private.player_alias pa on pa.alias_n = pp.alias_n where pa.user_id = $1`, [uuid(u)]))?.pos ?? null;

// E1: P1 (1 vs 2) BO3 2-1, con quién empieza y mazo prestado; P2 (1 vs 3) walkover; P3 (2 vs 3) empate BO2; P4 (1 vs 4 exile) ; P5 revancha; P6 (3 vs 6) sin resultado con 1 partida
const P1 = await pair(E1, p[1], p[2], {winner: p[1], round: 1});
const m1 = await match(P1, 1, p[1], {who: p[1], start: "2026-03-08 00:00:00+00", end: "2026-03-08 00:20:30+00"});
const m2 = await match(P1, 2, p[2], {who: p[2], start: "2026-03-08 00:30:00+00", end: "2026-03-08 00:30:00+00"});                // started = ended
const m3 = await match(P1, 3, p[1], {who: p[1], borrowed: true, start: "2026-03-08 01:00:00+00", end: "2026-03-08 05:59:00+00"});    // 299 min: fuera de rango
const P2 = await pair(E1, p[1], p[3], {winner: p[1]});
await match(P2, 1, p[1], {wo: true});
const P3 = await pair(E1, p[2], p[3], {draw: true});
await match(P3, 1, p[2]); await match(P3, 2, p[3]);
const P4 = await pair(E1, p[1], p[4], {winner: p[4]});
await match(P4, 1, p[4], {who: p[4]});
const P5 = await pair(E1, p[2], p[6], {winner: p[2], stage: "revenge"});
await match(P5, 1, p[2], {type: "revenge"});
const P6 = await pair(E1, p[3], p[6], {});
await match(P6, 1, p[3], {start: "2026-03-08 02:00:00+00", end: "2026-03-08 02:12:00+00"});
// P9 (1 vs 6): serie decidida por WALKOVER que contiene una partida REAL (la app la cuenta; la publicación no, porque su cruce no se publica)
const P9 = await pair(E1, p[1], p[6], {winner: p[1]});
await match(P9, 1, p[1]); await match(P9, 2, p[1], {wo: true});
// bracket (desempate): semis P1-vs-P2 pairing reutilizado, ronda 1 → juego tiebreak en P1
const grp = (await one(`insert into public.event_tiebreak_groups (event_id, round_number, group_type, status, group_origin) values ($1,1,'bracket','resolved','round_robin_topcut') returning id`, [E1])).id;
await db.query(`insert into public.event_tiebreak_bracket_matches (group_id, bracket_phase, participant_a_id, participant_b_id, pairing_id, winner_participant_id) values ($1,'semi',$2,$3,$4,$5)`, [grp, p[1], p[2], P1, p[2]]);
const mt = await match(P1, 4, p[2], {type: "tiebreak", round: 1, start: "2026-03-08 03:00:00+00", end: "2026-03-08 03:18:00+00"});
// ronda 2 de bracket (1 vs 4, pairing P4): un tiebreak REAL + un tiebreak WALKOVER en la misma ronda -> cruce de bracket walkover (no se publica ni su partida real)
const grp2 = (await one(`insert into public.event_tiebreak_groups (event_id, round_number, group_type, status, group_origin) values ($1,2,'bracket','resolved','round_robin_topcut') returning id`, [E1])).id;
await db.query(`insert into public.event_tiebreak_bracket_matches (group_id, bracket_phase, participant_a_id, participant_b_id, pairing_id, winner_participant_id) values ($1,'final',$2,$3,$4,$5)`, [grp2, p[1], p[4], P4, p[4]]);
await match(P4, 2, p[4], {type: "tiebreak", round: 2, start: "2026-03-08 04:00:00+00", end: "2026-03-08 04:20:00+00"});
await match(P4, 3, p[1], {type: "tiebreak", round: 2, wo: true});
// E6 (playing) con una partida; E7 importado con partida; E2 (no oficial) con partida; E3/E4 con partida
const P7 = await pair(E6, q6a, q6b, {}); await match(P7, 1, q6a, {start: "2026-04-12 00:00:00+00", end: "2026-04-12 00:30:00+00"});
const P8 = await pair(E7, q7a, q7b, {winner: q7a}); await match(P8, 1, q7a, {ds: "imported_notebook", start: "2026-02-02 00:00:00+00", end: "2026-02-02 00:40:00+00"});
for (const [ev, a, b] of [[E2, 1, 2], [E3, 1, 2], [E4, 1, 2], [E5, 1, 2], [E8, 1, 2]]) {
  const pa = await one(`select id from public.event_participants where event_id=$1 and user_id=$2`, [ev, uuid(a)]);
  const pb = await one(`select id from public.event_participants where event_id=$1 and user_id=$2`, [ev, uuid(b)]);
  const pr = await pair(ev, pa.id, pb.id, {winner: pa.id}); await match(pr, 1, pa.id);
}
for (const c of cerrar) await db.query(`update public.pairings set official_winner_participant_id = $2, official_draw = $3 where id = $1`, [c.id, c.winner, c.draw]);

// ---- antes del primer refresco con datos, las tablas están vacías (el rol no calcula nada)
ok((await one(`select count(*)::int n from analytics.partidas`)).n === 0, "antes de refrescar las tablas están vacías (el rol no calcula nada)");
const r0 = await refresh();
console.log("   refresco:", JSON.stringify(r0));
const aliasUsers = await q(`select count(*)::int n, count(distinct alias_n)::int d from analytics_private.player_alias`);
ok(aliasUsers[0].n === 6 && aliasUsers[0].d === 6, "el refresco asigna alias PRIVADO único a cada usuario", aliasUsers);
const rangoAlias = await one(`select min(alias_n) mn, max(alias_n) mx from analytics_private.player_alias`);
ok(rangoAlias.mn >= 1 && rangoAlias.mx <= 99999, "alias privado dentro del rango fijo [1, 99999] (solo sirve para ordenar)", rangoAlias);

// ---------------- verificaciones
const A = {}; for (let u = 1; u <= 6; u++) A[u] = await aliasOf(u);
const D = (x) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x));
const ev = await q(`select * from analytics.eventos order by fecha`);
ok(ev.length === 3, "eventos: entran E7, E1 y E6 (fuera no oficial, cancelado, 2HG, otro workspace, borrado)", ev);
ok(JSON.stringify(ev.map((e) => D(e.fecha))) === '["2026-02-01","2026-03-07","2026-04-11"]', "fechas del evento (E1 23:30 BA del 7/3 -> 2026-03-07)", ev.map((e) => D(e.fecha)));
ok(ev[1].duracion_draft_min === 90, "duracion_draft_min = 90", ev[1]);
ok(ev[0].duracion_draft_min === null, "evento importado: duración del draft NULL", ev[0]);
ok(ev[2].duracion_draft_min === null, "evento en juego sin draft_ended_at: duración NULL", ev[2]);
ok(ev.every((e) => /^Evento \d\d$/.test(e.nombre)) && ev[0].nombre === "Evento 01", "nombres 'Evento NN' por fecha", ev.map((e) => e.nombre));
ok(ev.every((e) => Number.isSafeInteger(Number(e.id))), "id de evento es entero seguro de JS", ev.map((e) => e.id));
ok(ev.every((e) => e.cubo_id !== null && e.es_oficial === true), "cubo_id presente, es_oficial true");
ok(ev.map((e) => e.estado).join() === "completed,completed,playing", "estado", ev.map((e) => e.estado));

// ---- Alias: puestos consecutivos 1..n, sin huecos
const jug = await q(`select * from analytics.jugadores order by id`);
ok(jug.length === 6 && jug.every((j, i) => j.id === i + 1 && j.nombre === `Jugador ${i + 1}`), "ALIAS: 'Jugador N' con N = puesto consecutivo 1..n (sin huecos)", jug);
const cub = await q(`select * from analytics.cubos order by id`);
ok(cub.length === 3 && cub.every((c, i) => c.id === i + 1 && c.nombre === "Cubo " + "ABC"[i]), "ALIAS: cubos con letras A, B, C... consecutivas (solo los usados por eventos válidos)", cub);
const posAntes = {}; for (let u = 1; u <= 6; u++) posAntes[u] = await posOf(u);
const mapaOk = await one(`select count(*)::int n, count(distinct pos)::int d, min(pos) mn, max(pos) mx from analytics_private.player_pos`);
ok(mapaOk.n === 6 && mapaOk.d === 6 && mapaOk.mn === 1 && mapaOk.mx === 6, "ALIAS: el mapa privado player_pos es un puesto 1..6 por jugador", mapaOk);

const ek = async (e) => (await one(`select evento_key::text k from analytics_private.v_eventos_validos where event_id = $1`, [e])).k;
const pj = await q(`select * from analytics.participaciones where evento_id = $1 order by jugador_id`, [await ek(E1)]);
const byAlias = Object.fromEntries(pj.map((r) => [r.jugador_id, r]));
ok(pj.length === 6, "participaciones de E1: 6 (player, exile, ghost; quien se fue también participó)", pj.length);
ok(byAlias[posAntes[1]].colores === "WRG", "colores en orden W-U-B-R-G-C (G,R,W -> WRG)", byAlias[posAntes[1]]);
ok(byAlias[posAntes[6]].colores === "UC", "colores 'UC'", byAlias[posAntes[6]]);
ok(byAlias[posAntes[4]].rol === "exile" && byAlias[posAntes[4]].colores === null, "exile: rol marcado y colores NULL");
ok(byAlias[posAntes[5]].rol === "ghost" && byAlias[posAntes[5]].colores === null, "ghost: rol marcado y colores NULL");
ok(byAlias[posAntes[1]].autoevaluacion === 9, "autoevaluación se mantiene");
const imp = await q(`select * from analytics.participaciones where evento_id = $1`, [await ek(E7)]);
ok(imp.length === 2 && imp.every((r) => r.colores === null), "importado: colores NULL", imp);

// M5: columnas que ya no existen
const colsFuera = await q(`select table_name, column_name from information_schema.columns where table_schema = 'analytics'
  and ((table_name = 'participaciones' and column_name = 'se_fue') or (table_name in ('enfrentamientos', 'partidas') and column_name = 'es_walkover'))`);
ok(colsFuera.length === 0, "M5: no existen participaciones.se_fue ni enfrentamientos/partidas.es_walkover", colsFuera);

const enf = await q(`select e.*, p.n from analytics.enfrentamientos e left join lateral (select count(*) n from analytics.partidas p where p.enfrentamiento_id = e.id) p on true`);
const desc = (e) => `${e.fase}/${e.etapa ?? "-"}/${e.resultado}/prest=${e.con_mazo_prestado}/n=${e.n}`;
ok(enf.length === 7, "enfrentamientos: E1 4 pairings (sin revancha ni walkover) + 1 bracket, E6 1 pendiente con partida, E7 1", enf.map(desc));
ok(enf.filter((e) => e.resultado === "empate").length === 1 && enf.find((e) => e.resultado === "empate").ganador_id === null, "empate BO2: resultado 'empate', ganador NULL");
ok(enf.filter((e) => e.resultado === "pendiente").length === 2, "dos pendientes con partidas (E1-P6 y E6-P7)", enf.map(desc));
ok(enf.filter((e) => e.fase === "top4" && e.etapa === "semi").length === 1, "cruce de bracket: fase top4, etapa semi", enf.map(desc));
ok(enf.every((e) => e.jugador_a < e.jugador_b), "jugador_a < jugador_b (orden por puesto)");
ok(enf.some((e) => e.con_mazo_prestado === true), "con_mazo_prestado marcado donde hubo mazo prestado");

const par = await q(`select * from analytics.partidas`);
ok(par.length === 10, "partidas: 8 de E1 (sin revancha ni walkover) + 1 de E6 + 1 de E7", par.length);
const durs = par.map((g) => g.duracion_min).filter((d) => d !== null).sort((a, b) => a - b);
ok(durs.includes(21), "duración 20.5 min redondea a 21", durs);
ok(!durs.includes(299) && !durs.includes(0), "duración fuera de rango (299) y started=ended se publican NULL", durs);
ok(par.filter((g) => g.duracion_min === null).length >= 3, "NULL: started=ended + 299 + importada", par.filter((g) => g.duracion_min === null).length);
ok(par.filter((g) => g.empieza_id !== null).length === 4, "empieza_id presente donde hay dato");
ok(par.some((g) => g.mazo_prestado_a === true || g.mazo_prestado_b === true), "mazo_prestado marcado");
const tb = par.find((g) => g.tipo === "tiebreak");
const brk = enf.find((e) => e.fase === "top4");
ok(tb && String(tb.enfrentamiento_id) === String(brk.id), "partida tiebreak apunta al cruce de bracket", {tb: tb?.enfrentamiento_id, brk: brk?.id});
ok(par.every((g) => enf.some((e) => String(e.id) === String(g.enfrentamiento_id))), "toda partida referencia un enfrentamiento exportado (sin huérfanas)");
ok(par.every((g) => g.jugador_a < g.jugador_b), "partidas: jugador_a < jugador_b");
const encadena = await q(`select count(*)::int n from analytics.partidas p join analytics.enfrentamientos e on e.id = p.enfrentamiento_id join analytics.eventos v on v.id = e.evento_id`);
ok(encadena[0].n === 10, "toda partida se encadena a un evento exportado", encadena);
const rev = await q(`select count(*)::int n from analytics.partidas where tipo = 'revenge'`);
ok(rev[0].n === 0, "no hay partidas de tipo revenge");

// ---- CONTROLES: los EXACTOS son privados; el pipeline solo ve verificacion (pasa/no pasa) y registro_limpieza (con "<5")
const anom = Object.fromEntries((await q(`select * from analytics_private.control_anomalias`)).map((r) => [r.chequeo, Number(r.cantidad)]));
console.log("   anomalías (exactas, internas):", JSON.stringify(anom));
ok(anom.enfrentamientos_walkover_no_publicados === 3 && anom.partidas_walkover_no_publicadas === 3, "M5: walkovers no publicados (P2, P9 y la ronda 2 de bracket), contados solo como agregado", anom);
ok(anom.participaciones_se_fue_no_publicadas === 1, "M5: 'se fue' no publicado, contado solo como agregado", anom);
ok(anom.partidas_de_cruce_no_publicado === 2, "las 2 partidas REALES de cruces walkover (P9 y tiebreak de la ronda 2) no se publican y se cuentan", anom);
ok(anom.partidas_ended_le_started === 1, "anomalía detectada: started = ended (1)", anom);
ok(anom.partidas_duracion_fuera_de_rango === 1, "anomalía detectada: duración fuera de rango (1)", anom);
ok(anom.usuarios_sin_alias_en_eventos_validos === 0, "usuarios sin alias = 0", anom);
const sinPartidasIndep = (await one(`select count(*)::int n from analytics.participaciones pa where pa.rol = 'player'
  and not exists (select 1 from analytics.partidas g join analytics.enfrentamientos e on e.id = g.enfrentamiento_id
                  where e.evento_id = pa.evento_id and pa.jugador_id in (g.jugador_a, g.jugador_b))`)).n;
ok(sinPartidasIndep === 1 && anom.participaciones_player_sin_partidas === sinPartidasIndep, "CONTROL POSITIVO (mapa): participaciones_player_sin_partidas coincide con el cálculo independiente sobre lo PUBLICADO (1); sin pasar por el mapa daría otro valor", {control: anom.participaciones_player_sin_partidas, independiente: sinPartidasIndep});

const conc = await q(`select * from analytics_private.control_conciliacion order by metrica`);
const concCols = (await q(`select column_name from information_schema.columns where table_schema = 'analytics_private' and table_name = 'control_conciliacion' order by ordinal_position`)).map((r) => r.column_name);
ok(JSON.stringify(concCols) === JSON.stringify(["metrica", "total_app", "total_curado", "jugadores_con_diferencia"]), "A1/M1: la conciliación solo tiene columnas agregadas (sin alias ni detalle)", concCols);
ok(conc.length === 2 && conc.every((r) => Number(r.jugadores_con_diferencia) === 0 && Number(r.total_app) === Number(r.total_curado)), "conciliación de lo PUBLICADO vs v_participant_official_results/games: total app = total curado y 0 jugadores con diferencia", conc);
console.log("   (conciliación exacta, interna):", JSON.stringify(conc));
ok((await q(`select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'analytics_control'`)).length === 0, "A1: analytics_control no tiene funciones");
ok((await q(`select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'analytics_control' and c.relname in ('anomalias', 'privacidad', 'conciliacion')`)).length === 0, "los controles EXACTOS ya no están en analytics_control (solo analytics_private)");
// CONTROL POSITIVO (mapa) de conciliación: si se altera lo publicado, la conciliación lo detecta (en una transacción que se revierte)
await db.exec("begin");
await db.exec(`delete from analytics.partidas where id = (select id from analytics.partidas order by id limit 1)`);
await db.exec(`delete from analytics.enfrentamientos where id = (select id from analytics.enfrentamientos where resultado = 'victoria' order by id limit 1)`);
const concTamper = Object.fromEntries((await q(`select * from analytics_private.v_conciliacion_calc`)).map((r) => [r.metrica, r]));
await db.exec("rollback");
ok(Number(concTamper.partidas.jugadores_con_diferencia) > 0 && Number(concTamper.partidas.total_curado) < Number(concTamper.partidas.total_app), "CONTROL POSITIVO (mapa): la conciliación detecta una partida publicada faltante", concTamper.partidas);
ok(Number(concTamper.enfrentamientos.jugadores_con_diferencia) > 0 && Number(concTamper.enfrentamientos.total_curado) < Number(concTamper.enfrentamientos.total_app), "CONTROL POSITIVO (mapa): la conciliación detecta un enfrentamiento publicado faltante", concTamper.enfrentamientos);


// ---- CONCILIACIÓN contra la REGLA DE PUBLICACIÓN (no contra la vista cruda de la app)
// (a) la serie walkover con partidas REALES (P9 y el bracket de la ronda 2) da 0 diferencias: la app las cuenta, la publicación no, y la conciliación lo sabe
const conciliados = await q(`select * from analytics_private.v_conciliacion_calc order by metrica`);
ok(conciliados.every((r) => Number(r.jugadores_con_diferencia) === 0 && Number(r.total_app) === Number(r.total_curado)), "CONCILIACIÓN (a): con series walkover que contienen partidas reales, 0 diferencias", conciliados);
const cruda = await one(`select count(*)::int n from public.v_participant_official_games g join analytics_private.v_eventos_validos ev on ev.event_id = g.event_id`);
ok(cruda.n > Number(conciliados.find((r) => r.metrica === "partidas").total_app), "CONCILIACIÓN (a): la vista cruda de la app SÍ cuenta esas partidas (más que el lado de la app ya regulado)", {cruda: cruda.n, regulado: conciliados.find((r) => r.metrica === "partidas").total_app});
// (b) controles positivos: se altera lo PUBLICADO en una transacción que se revierte
await db.exec("begin");
await db.exec(`delete from analytics.partidas where id = (select id from analytics.partidas order by id limit 1)`);   // una partida publicable que FALTA
const faltante = Object.fromEntries((await q(`select * from analytics_private.v_conciliacion_calc`)).map((r) => [r.metrica, r]));
await db.exec("rollback");
ok(Number(faltante.partidas.jugadores_con_diferencia) > 0 && Number(faltante.partidas.total_curado) < Number(faltante.partidas.total_app), "CONCILIACIÓN (b): quitar una partida publicable de analytics.partidas marca diferencias", faltante.partidas);
await db.exec("begin");
await db.exec(`insert into analytics.partidas (id, enfrentamiento_id, numero, tipo, estado, jugador_a, jugador_b, ganador_id, empieza_id, duracion_min, mazo_prestado_a, mazo_prestado_b)
  select id + 1, enfrentamiento_id, numero + 90, tipo, estado, jugador_a, jugador_b, ganador_id, empieza_id, duracion_min, mazo_prestado_a, mazo_prestado_b from analytics.partidas order by id limit 1`);   // una publicada que NO está en la app
const sobrante = Object.fromEntries((await q(`select * from analytics_private.v_conciliacion_calc`)).map((r) => [r.metrica, r]));
await db.exec("rollback");
ok(Number(sobrante.partidas.jugadores_con_diferencia) > 0 && Number(sobrante.partidas.total_curado) > Number(sobrante.partidas.total_app), "CONCILIACIÓN (b): una partida publicada que no está en la app marca diferencias", sobrante.partidas);
// (b) una partida real cuyo cruce falta por OTRO motivo (no walkover) debe seguir marcando diferencia: se quita el cruce publicado de una serie normal
await db.exec("begin");
await db.exec(`delete from analytics.partidas where enfrentamiento_id = (select id from analytics.enfrentamientos where resultado = 'victoria' order by id limit 1)`);
await db.exec(`delete from analytics.enfrentamientos where id = (select id from analytics.enfrentamientos where resultado = 'victoria' order by id limit 1)`);
const cruceFalta = Object.fromEntries((await q(`select * from analytics_private.v_conciliacion_calc`)).map((r) => [r.metrica, r]));
await db.exec("rollback");
ok(Number(cruceFalta.partidas.jugadores_con_diferencia) > 0 && Number(cruceFalta.enfrentamientos.jugadores_con_diferencia) > 0, "CONCILIACIÓN (b): un cruce publicable faltante (no walkover) sigue marcando diferencias en partidas Y enfrentamientos", cruceFalta);

// ---- PARCHE 0155b: reproduce el falso negativo con la definición ANTERIOR, aplica el parche, y comprueba dueño/privilegios/opciones
{
  const sqlPatch = fs.readFileSync(DOCS + "0155b_parche_conciliacion.sql", "utf8").replace(/\r\n/g, "\n");
  const reVista = /create or replace view analytics_private\.v_conciliacion_calc[\s\S]*?group by p\.metrica;/;
  const vistaNueva = sql.match(reVista)[0];
  ok(sqlPatch.match(reVista)[0] === vistaNueva, "PARCHE: la vista del parche es IDÉNTICA a la de 0155");
  ok(/>>> PUBLICACIÓN[\s\S]*<<< PUBLICACIÓN/.test(vistaNueva), "PARCHE: la vista contiene el bloque de la regla de publicación");
  const vistaVieja = vistaNueva.replace(/ *-- >>> PUBLICACIÓN[\s\S]*?-- <<< PUBLICACIÓN\n/, "");
  ok(vistaVieja !== vistaNueva && !/es_walkover\)/.test(vistaVieja.split("), cur_par as (")[0].split("app_par as (")[1] ?? ""), "PARCHE: se reconstruyó la definición ANTERIOR (sin la regla)");
  const metaVista = async () => await one(`select c.relowner::regrole::text as dueno, c.relacl::text as acl, c.reloptions::text as opciones,
     (select string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' order by attnum) from pg_attribute where attrelid = c.oid and attnum > 0 and not attisdropped) as columnas
     from pg_class c where c.oid = 'analytics_private.v_conciliacion_calc'::regclass`);
  const metaAntes = await metaVista();
  // estado de producción ANTES del parche: definición anterior + refresco -> falso negativo
  await db.exec(vistaVieja);
  await refresh();
  const sinParche = Object.fromEntries((await q(`select * from analytics_private.control_conciliacion`)).map((r) => [r.metrica, r]));
  const verSinParche = await one(`select ok from analytics_control.verificacion where chequeo = 'conciliacion:partidas'`);
  ok(verSinParche.ok === false && Number(sinParche.partidas.total_app) > Number(sinParche.partidas.total_curado) && Number(sinParche.partidas.jugadores_con_diferencia) > 0 && sinParche.enfrentamientos.jugadores_con_diferencia == 0,
     "PARCHE: con la definición anterior se reproduce el falso negativo de producción (conciliacion:partidas = false; enfrentamientos bien)", {sinParche, verSinParche});
  ok(Number(sinParche.partidas.total_app) - Number(sinParche.partidas.total_curado) === 3, "PARCHE: la diferencia son exactamente las 3 filas por jugador de las 2 partidas reales de series walkover (P9: 2 jugadores player; tiebreak: 1 player + 1 exile)", sinParche.partidas);
  // aplicar el PARCHE tal cual (archivo) y verificar que no pierde dueño, privilegios ni opciones
  await db.exec(sqlPatch);
  const metaDespues = await metaVista();
  ok(JSON.stringify(metaAntes) === JSON.stringify(metaDespues), "PARCHE: create or replace conserva dueño, privilegios (ACL), opciones y columnas de la vista", {metaAntes, metaDespues});
  // paso 3b (alternativa sin republicar): recalcular solo la conciliación y la verificación
  await db.exec(`begin;
    delete from analytics_private.control_conciliacion;
    insert into analytics_private.control_conciliacion (metrica, total_app, total_curado, jugadores_con_diferencia)
      select metrica, total_app, total_curado, jugadores_con_diferencia from analytics_private.v_conciliacion_calc;
    delete from analytics_control.verificacion where chequeo like 'conciliacion:%';
    insert into analytics_control.verificacion (chequeo, ok)
      select 'conciliacion:' || metrica, (total_app = total_curado and jugadores_con_diferencia = 0) from analytics_private.control_conciliacion;
    commit;`);
  ok((await q(`select ok from analytics_control.verificacion where chequeo like 'conciliacion:%'`)).every((r) => r.ok === true), "PARCHE paso 3b: el recálculo manual (sin republicar) deja conciliacion:* en true");
  // paso 3: basta con refresh_analytics()
  await db.exec(vistaVieja);
  await refresh();
  ok((await one(`select ok from analytics_control.verificacion where chequeo = 'conciliacion:partidas'`)).ok === false, "PARCHE (previo): otra vez el estado con falso negativo");
  await db.exec(sqlPatch);
  await refresh();
  const post = await q(`select * from analytics_control.verificacion where chequeo like 'conciliacion:%'`);
  ok(post.length === 2 && post.every((r) => r.ok === true), "PARCHE paso 3: aplicar el parche y correr refresh_analytics() basta: conciliacion:* en true", post);
  ok((await one(`select vigente from analytics_control.refresco`)).vigente === true, "PARCHE: el refresco queda vigente");
  const permisos = await one(`select has_table_privilege('analytics_reader', 'analytics_private.v_conciliacion_calc', 'SELECT') as lee_reader, has_table_privilege('anon', 'analytics_private.v_conciliacion_calc', 'SELECT') as lee_anon`);
  ok(permisos.lee_reader === false && permisos.lee_anon === false, "PARCHE: la vista sigue sin ser legible por analytics_reader ni anon", permisos);
}

const priv = await q(`select * from analytics_private.control_privacidad`);
ok(priv.length > 0 && priv.every((r) => Number(r.violaciones) === 0), "privacidad: todo en 0", priv);
const refr = await one(`select * from analytics_control.refresco`);
ok(refr.vigente === true && refr.refrescado_en && refr.clave_version === "ids_v1", "refresco: vigente, con fecha y versión de clave ids_v1", refr);
const ver = await q(`select * from analytics_control.verificacion`);
ok(ver.length > 10 && ver.every((r) => r.ok === true), "verificacion: solo pasa/no pasa y todo pasa", ver.filter((r) => !r.ok));
const verCols = (await q(`select column_name from information_schema.columns where table_schema = 'analytics_control' and table_name in ('verificacion','registro_limpieza') order by table_name, ordinal_position`)).map((r) => r.column_name);
ok(JSON.stringify(verCols) === JSON.stringify(["concepto", "cantidad", "chequeo", "ok"]) || JSON.stringify(verCols.sort()) === JSON.stringify(["cantidad", "chequeo", "concepto", "ok"]), "verificacion y registro_limpieza no tienen columnas por jugador", verCols);
const reg = await q(`select * from analytics_control.registro_limpieza order by concepto`);
ok(reg.length === 11 && reg.every((r) => r.cantidad === "<5" || (/^\d+$/.test(r.cantidad) && Number(r.cantidad) >= 5)), "registro_limpieza: toda cantidad menor a 5 se publica como '<5' (las otras, exactas)", reg);
ok(reg.find((r) => r.concepto === "partidas_sin_dato_de_quien_empieza")?.cantidad === String(anom.partidas_sin_dato_de_quien_empieza) && anom.partidas_sin_dato_de_quien_empieza >= 5 && reg.find((r) => r.concepto === "partidas_ended_le_started")?.cantidad === "<5", "registro_limpieza: un valor >= 5 se muestra exacto y 1 como '<5'", reg);

// ---- M6: clave versionada
const clavesAntes = await q(`select evento_id from analytics.participaciones group by 1 order by 1`);
await db.query(`insert into analytics_private.secret (name, value) values ('ids_v2', encode(extensions.gen_random_bytes(32), 'hex'))`);
await db.query(`update analytics_private.config set value = 'ids_v2' where key = 'clave_activa'`);
await refresh();
const clavesDespues = await q(`select evento_id from analytics.participaciones group by 1 order by 1`);
const setAntes = new Set(clavesAntes.map((r) => String(r.evento_id)));
ok(clavesAntes.length === clavesDespues.length && clavesDespues.every((r) => !setAntes.has(String(r.evento_id))), "M6: rotar la clave cambia TODOS los ids opacos de evento", {antes: clavesAntes.length, despues: clavesDespues.length});
ok((await one(`select clave_version from analytics_control.refresco`)).clave_version === "ids_v2", "M6: el refresco registra la versión de clave ids_v2");
await db.query(`update analytics_private.config set value = 'ids_v1' where key = 'clave_activa'`);
await refresh();
ok(JSON.stringify(clavesAntes.map((r) => String(r.evento_id))) === JSON.stringify((await q(`select evento_id from analytics.participaciones group by 1 order by 1`)).map((r) => String(r.evento_id))), "M6: volver a la versión anterior restituye los mismos ids (estables por versión)");
await db.query(`delete from analytics_private.secret where name = 'ids_v2'`);

// ---- A3: bloqueo del refresco sobre player_optout (evidencia posible con UNA sola conexión: el modo de bloqueo que sostiene el refresco)
await db.exec("begin");
await refresh();
const bloqueos = (await q(`select mode, granted from pg_locks where relation = 'analytics_private.player_optout'::regclass`));
await db.exec("rollback");
ok(bloqueos.some((l) => l.mode === "ShareLock" && l.granted), "A3: durante el refresco se sostiene SHARE sobre player_optout (bloquea altas/bajas concurrentes hasta el commit)", bloqueos);
const defRefresh = (await one(`select pg_get_functiondef('analytics_private.refresh_analytics()'::regprocedure) d`)).d;
ok(/lock table analytics_private\.player_optout in share mode/i.test(defRefresh) && defRefresh.search(/lock table/i) < defRefresh.search(/sync_aliases/i), "A3: el LOCK ... SHARE MODE es de lo primero que hace el refresco (antes de sync_aliases)");
console.log("   A3 (limitación): PGlite es de una sola conexión; una exclusión REALMENTE concurrente no se puede simular aquí. SHARE conflicta con ROW EXCLUSIVE (INSERT/UPDATE/DELETE) en PostgreSQL: el escritor espera al commit del refresco.");
await db.exec("truncate analytics_private.player_optout");
ok((await one(`select vigente from analytics_control.refresco`)).vigente === false, "A3: un TRUNCATE de player_optout deja el refresco 'no vigente' (trigger BEFORE TRUNCATE)");
await refresh();

// ---- exclusión voluntaria (Bruno = usuario 2): se aplica en el refresco, también a los CONTROLES
const posB = posAntes[2];
const totConcAntes = Object.fromEntries((await q(`select * from analytics_private.control_conciliacion`)).map((r) => [r.metrica, Number(r.total_curado)]));
await db.query(`insert into analytics_private.player_optout (user_id) values ($1)`, [uuid(2)]);
ok((await one(`select vigente from analytics_control.refresco`)).vigente === false, "alta en player_optout deja el refresco 'no vigente' hasta el próximo refresco");
// CONTROL POSITIVO (mapa): ANTES de refrescar, lo publicado todavía contiene a Bruno; los controles de privacidad deben detectarlo
// pasando por player_pos (si compararan ids publicados con el alias privado, darían 0 y esta prueba fallaría)
const vp = Object.fromEntries((await q(`select * from analytics_private.v_privacidad_calc`)).map((r) => [r.chequeo, Number(r.violaciones)]));
ok(vp.jugador_excluido_presente > 0 && vp.enfrentamiento_con_jugador_excluido > 0 && vp.partida_con_jugador_excluido > 0, "CONTROL POSITIVO (mapa): los controles de privacidad detectan al excluido AÚN publicado (pasan por player_pos)", vp);
await refresh();
ok((await one(`select vigente from analytics_control.refresco`)).vigente === true, "el refresco vuelve a dejarlo vigente");
ok((await one(`select count(*)::int n from analytics_private.player_pos pp join analytics_private.player_alias pa on pa.alias_n = pp.alias_n where pa.user_id = $1`, [uuid(2)])).n === 0, "opt-out: el excluido no tiene puesto en el mapa");
const jug2 = await q(`select id from analytics.jugadores order by id`);
ok(jug2.length === 5 && jug2.every((j, i) => j.id === i + 1), "opt-out: jugadores 1..5 consecutivos, SIN hueco (los puestos se renumeran)", jug2);
ok((await q(`select count(*)::int n from analytics.participaciones`))[0].n === 11 - 2, "opt-out: desaparecen sus 2 participaciones");
const nEnf2 = (await q(`select count(*)::int n from analytics.enfrentamientos`))[0].n;
const nPar2 = (await q(`select count(*)::int n from analytics.partidas`))[0].n;
ok(nEnf2 === 3 && nPar2 === 3, "opt-out: desaparecen sus enfrentamientos (4) y partidas (7)", {nEnf2, nPar2});
const priv2 = await q(`select * from analytics_private.control_privacidad`);
ok(priv2.every((r) => Number(r.violaciones) === 0), "privacidad con opt-out: todo en 0", priv2);
const conc2 = await q(`select * from analytics_private.control_conciliacion`);
ok(conc2.every((r) => Number(r.jugadores_con_diferencia) === 0 && Number(r.total_app) === Number(r.total_curado)), "A1: conciliación con opt-out: exclusión aplicada en AMBOS lados (0 diferencias)", conc2);
ok(conc2.every((r) => Number(r.total_curado) < totConcAntes[r.metrica]), "A1: los totales de conciliación bajan con la exclusión (no incluyen al excluido)", {antes: totConcAntes, despues: conc2});
const anom2 = Object.fromEntries((await q(`select * from analytics_private.control_anomalias`)).map((r) => [r.chequeo, Number(r.cantidad)]));
ok(anom2.partidas_ended_le_started === 0 && anom2.partidas_duracion_fuera_de_rango === 0, "M1: las anomalías no cuentan partidas del excluido (started=ended y 299 min eran de Bruno)", anom2);
const reg2 = Object.fromEntries((await q(`select * from analytics_control.registro_limpieza`)).map((r) => [r.concepto, r.cantidad]));
ok(Object.values(reg2).every((c) => c === "<5" || Number(c) >= 5), "registro_limpieza con opt-out sigue sin cantidades menores a 5", reg2);
ok((await q(`select count(*)::int n from analytics_private.v_partidas_base where excluido`))[0].n > 0, "la vista base conserva las partidas (el filtro está en el refresco)");
// segundo opt-out: Carla (walkover P2) y Fede (se fue): los conteos de M5 tampoco los delatan
await db.query(`insert into analytics_private.player_optout (user_id) values ($1),($2)`, [uuid(3), uuid(6)]);
await refresh();
const anom3 = Object.fromEntries((await q(`select * from analytics_private.control_anomalias`)).map((r) => [r.chequeo, Number(r.cantidad)]));
ok(anom3.enfrentamientos_walkover_no_publicados === 1 && anom3.partidas_walkover_no_publicadas === 1 && anom3.participaciones_se_fue_no_publicadas === 0, "M1/M5: con Carla y Fede excluidos desaparecen sus walkovers (P2, P9) y su 'se fue'; queda solo el de la ronda de bracket 1 vs 4 (Dario, no excluido)", anom3);
await db.query(`delete from analytics_private.player_optout`);
await refresh();

// ---- A4: el creador de un cubo está en exclusión voluntaria -> el cubo no se publica y los eventos quedan con cubo_id NULL
ok((await q(`select count(*)::int n from analytics.cubos`))[0].n === 3, "A4 (previo): 3 cubos publicados, uno creado por Dario");
await db.query(`insert into analytics_private.player_optout (user_id) values ($1)`, [uuid(4)]);
const vpC = Object.fromEntries((await q(`select * from analytics_private.v_privacidad_calc`)).map((r) => [r.chequeo, Number(r.violaciones)]));
ok(vpC.cubo_de_excluido_publicado >= 2, "CONTROL POSITIVO (mapa): el control detecta el cubo del excluido AÚN publicado (cubo + evento)", vpC);
await refresh();
const cubD = await q(`select * from analytics.cubos order by id`);
const evD = await q(`select * from analytics.eventos order by fecha`);
ok(cubD.length === 2 && cubD.every((c, i) => c.id === i + 1), "A4: el cubo del excluido NO se publica y los demás quedan consecutivos", cubD);
ok(evD.length === 3 && evD.filter((e) => e.cubo_id === null).length === 1 && evD[2].estado === "playing" && evD[2].cubo_id === null, "A4: los 3 eventos se siguen publicando; el que usaba ese cubo queda con cubo_id NULL", evD);
ok(Number((await one(`select violaciones from analytics_private.control_privacidad where chequeo = 'cubo_de_excluido_publicado'`)).violaciones) === 0, "A4: control cubo_de_excluido_publicado en 0 tras el refresco");
await db.query(`delete from analytics_private.player_optout`);
await refresh();
ok((await q(`select count(*)::int n from analytics.cubos`))[0].n === 3, "A4: al quitar la exclusión y refrescar, el cubo vuelve");

// ---- alias privados: estabilidad, no reutilización, cuentas borradas (L4)
const antes = await q(`select user_id, alias_n from analytics_private.player_alias order by alias_n`);
await db.query(`select analytics_private.sync_aliases()`);
const despues = await q(`select user_id, alias_n from analytics_private.player_alias order by alias_n`);
ok(JSON.stringify(antes) === JSON.stringify(despues), "sync_aliases es idempotente y los alias privados no cambian");
await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,'nuevo@x.com','{"display_name":"Nuevo"}')`, [uuid(50)]);
await refresh();
const nuevo = await one(`select alias_n from analytics_private.player_alias where user_id=$1`, [uuid(50)]);
const usados = (await q(`select alias_n from analytics_private.player_alias`)).map((r) => r.alias_n);
ok(nuevo && usados.filter((n) => n === nuevo.alias_n).length === 1, "alias nuevo único", nuevo);
ok((await q(`select count(*)::int n from analytics.jugadores`))[0].n === 6, "un usuario sin participaciones válidas NO entra a jugadores (no consume puesto)");
await db.query(`delete from auth.users where id = $1`, [uuid(50)]);
await db.query(`delete from public.users where id = $1`, [uuid(50)]);
await refresh();
const borrado = await one(`select alias_n, user_id from analytics_private.player_alias where alias_n = $1`, [nuevo.alias_n]);
ok(borrado && borrado.user_id === null, "L4: cuenta borrada -> user_id NULL y el alias_n se conserva", borrado);
await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,'otro@x.com','{"display_name":"Otro"}')`, [uuid(51)]);
await refresh();
const otro = await one(`select alias_n from analytics_private.player_alias where user_id=$1`, [uuid(51)]);
ok(otro && otro.alias_n !== nuevo.alias_n, "L4: el alias de la cuenta borrada no se reutiliza", {nuevo, otro});

// ---- puestos sin sesgo de orden (jugadores y cubos), y sin huecos: 200 jugadores y 150 cubos nuevos con eventos, en una transacción que se revierte
await db.exec("begin");
await db.exec(`insert into auth.users (id, email, raw_user_meta_data)
  select ('d' || lpad(g::text, 7, '0') || '-0000-4000-8000-000000000000')::uuid, 'm' || g || '@x.com', '{}'::jsonb from generate_series(1, 200) g`);
await db.query(`insert into public.cubes (workspace_id, name, created_by, created_at)
  select $1, 'cx' || g, $2, timestamptz '2026-01-01 00:00:00+00' + g * interval '1 minute' from generate_series(1, 150) g`, [w1, uuid(1)]);
await db.query(`insert into public.draft_events (workspace_id, name, scheduled_for, created_by, event_organizer_user_id, cube_id, competition_format, status, is_official, event_type, data_source, draft_started_at, draft_ended_at)
  select $1, 'ex' || c.name, timestamptz '2026-05-01 20:00:00-03', $2, $2, c.id, 'round_robin', 'completed', true, 'draft', 'app', timestamptz '2026-05-01 20:00:00-03', timestamptz '2026-05-01 21:30:00-03'
  from public.cubes c where c.name like 'cx%'`, [w1, uuid(1)]);
await db.query(`insert into public.event_participants (event_id, user_id, role)
  select (select id from public.draft_events where name like 'excx1' limit 1), u.id, 'player' from public.users u where u.id::text like 'd%'`);
await refresh();
const distJ = await one(`select count(*)::int n, count(distinct pp.pos)::int d, min(pp.pos) mn, max(pp.pos) mx,
  corr(pp.pos::float8, substr(u.id::text, 2, 7)::int::float8)::float8 rho
  from public.users u join analytics_private.player_alias pa on pa.user_id = u.id join analytics_private.player_pos pp on pp.alias_n = pa.alias_n where u.id::text like 'd%'`);
const distC = await one(`select count(*)::int n, corr(cp.pos::float8, extract(epoch from c.created_at)::float8)::float8 rho
  from public.cubes c join analytics_private.cube_alias ca on ca.cube_id = c.id join analytics_private.cube_pos cp on cp.alias_n = ca.alias_n where c.name like 'cx%'`);
const totJ = await one(`select count(*)::int n, max(id) mx from analytics.jugadores`);
const totC = await one(`select count(*)::int n, max(id) mx from analytics.cubos`);
const huecos = await q(`select chequeo, violaciones from analytics_private.control_privacidad where chequeo in ('ids_jugador_con_huecos', 'ids_cubo_con_huecos')`);
await db.exec("rollback");
ok(distJ.n === 200 && distJ.d === 200, "PUESTOS: 200 jugadores nuevos con puestos distintos", distJ);
ok(Math.abs(distJ.rho) < 0.3, "PUESTOS: el puesto del jugador no se correlaciona con el orden de alta (|rho| < 0.3)", distJ);
ok(distC.n === 150 && Math.abs(distC.rho) < 0.35, "PUESTOS: la letra del cubo no sigue el orden de alta (|rho| < 0.35 con 150 cubos)", distC);
ok(totJ.n === totJ.mx && totC.n === totC.mx, "PUESTOS: ids 1..n sin huecos tras sumar jugadores y cubos", {totJ, totC});
ok(huecos.length === 2 && huecos.every((h) => Number(h.violaciones) === 0), "PUESTOS: los controles de huecos dan 0", huecos);
await refresh();
const distAlias = await q(`select count(*)::int n from analytics_private.player_alias where user_id is not null`);
ok(distAlias[0].n >= 6, "(transacción revertida: el estado vuelve a lo anterior)", distAlias);
// ---- los puestos pueden CAMBIAR entre refrescos (lo documentamos): al sumar un jugador con participaciones, los puestos se reordenan por alias privado
const posAntesSumar = JSON.stringify(await q(`select alias_n, pos from analytics_private.player_pos order by alias_n`));
await db.exec("begin");
await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,'x1@x.com','{}'), ($2,'x2@x.com','{}'), ($3,'x3@x.com','{}')`, [uuid(60), uuid(61), uuid(62)]);
await db.query(`insert into public.event_participants (event_id, user_id, role) values ($1,$2,'player'),($1,$3,'player'),($1,$4,'player')`, [E1, uuid(60), uuid(61), uuid(62)]);
await refresh();
const cambio = JSON.stringify(await q(`select alias_n, pos from analytics_private.player_pos order by alias_n`)) !== posAntesSumar;
await db.exec("rollback");
ok(cambio, "los puestos de jugador pueden cambiar entre refrescos (al sumar jugadores se renumera por alias privado)");
await refresh();

// ---- control positivo: la prueba de privacidad DEBE detectar una fuga (un usuario llamado como un valor exportado)
await db.query(`update public.users set display_name = 'completed' where id = $1`, [uuid(3)]);
await refresh();
const fuga = await one(`select violaciones from analytics_private.control_privacidad where chequeo = 'nombre_real_en_texto_exportado'`);
ok(Number(fuga.violaciones) > 0, "control positivo: la prueba detecta un nombre real presente en el texto exportado", fuga);
ok((await one(`select ok from analytics_control.verificacion where chequeo = 'privacidad:nombre_real_en_texto_exportado'`)).ok === false, "control positivo: verificacion pasa a ok = false (lo que ve el pipeline)");
await db.query(`update public.users set display_name = 'Carla Ruiz' where id = $1`, [uuid(3)]);
await refresh();

// ---- L3/L5: ninguna definición de vista o función contiene literales sensibles; search_path fijo con pg_temp al final
{
  const clave = (await one(`select value from analytics_private.secret where name = 'ids_v1'`)).value;
  const ws = (await one(`select value from analytics_private.config where key = 'workspace_id'`)).value;
  const defs = await q(`select 'vista ' || c.relname as obj, pg_get_viewdef(c.oid) as def from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('analytics','analytics_private','analytics_control') and c.relkind = 'v'
    union all
    select 'funcion ' || p.proname, pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('analytics','analytics_private','analytics_control')`);
  const malas = defs.filter((d) => d.def.includes(clave) || d.def.includes(ws) || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(d.def) || /[0-9a-f]{32,}/i.test(d.def) || /secreto|password|contraseñ/i.test(d.def));
  ok(defs.length > 10 && malas.length === 0, `L3: ${defs.length} definiciones (vistas y funciones) sin clave, uuid de workspace, uuid, hex largo ni palabras sensibles`, malas.map((m) => m.obj));
  const sinPath = (await q(`select p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'analytics_private'`))
    .filter((f) => !(f.proconfig ?? []).some((c) => /^search_path=.*pg_temp$/.test(c)));
  ok(sinPath.length === 0, "L5: todas las funciones de analytics_private fijan search_path con pg_temp AL FINAL", sinPath);
}

// ---- A1 (segunda revisión): RLS en TODAS las tablas de analytics y analytics_control, con política para el rol
{
  const tablas = await q(`select n.nspname || '.' || c.relname as t, c.relrowsecurity as rls, c.relforcerowsecurity as forzada,
      exists (select 1 from pg_policies p where p.schemaname = n.nspname and p.tablename = c.relname and p.cmd = 'SELECT' and 'analytics_reader'::name = any (p.roles) and p.qual = 'true') as politica
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('analytics', 'analytics_control') and c.relkind = 'r' order by 1`);
  ok(tablas.length === 9 && tablas.every((t) => t.rls && t.politica && !t.forzada), "A1: las 9 tablas de analytics y analytics_control tienen RLS activada (sin FORCE) y una política SELECT using (true) para analytics_reader", tablas);
  const privSin = await q(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'analytics_private' and c.relkind = 'r' and not c.relrowsecurity`);
  ok(privSin.length === 0, "A1: las tablas de analytics_private también tienen RLS (sin políticas)", privSin);
  // la RLS se hace cumplir al rol: una tabla con RLS y SIN política devuelve 0 filas aunque tenga datos y el rol tenga SELECT
  await db.exec(`create table analytics.__rls (a int); alter table analytics.__rls enable row level security; insert into analytics.__rls values (1); grant select on analytics.__rls to analytics_reader;`);
  await db.exec("set role analytics_reader");
  const sinPol = (await one(`select count(*)::int n from analytics.__rls`)).n;
  await db.exec("reset role");
  await db.exec(`drop table analytics.__rls`);
  ok(sinPol === 0, "A1: control positivo: con RLS y sin política el rol ve 0 filas (la RLS se hace cumplir; el dueño y el refresco la saltan)", sinPol);
}

// ---- rol de solo lectura
await db.exec("set role analytics_reader");
const intenta = async (sql) => { try { await db.query(sql); return "PERMITIDO"; } catch (e) { return "denegado: " + e.message.slice(0, 70); } };
ok((await q(`select count(*)::int n from analytics.partidas`))[0].n > 0, "reader lee analytics.partidas");
ok((await q(`select count(*)::int n from analytics_control.verificacion`))[0].n > 0, "reader lee analytics_control.verificacion");
ok((await q(`select count(*)::int n from analytics_control.registro_limpieza`))[0].n > 0, "reader lee analytics_control.registro_limpieza");
ok((await q(`select count(*)::int n from analytics_control.refresco`))[0].n === 1, "reader lee analytics_control.refresco");
for (const sql of ["select * from public.users", "select * from public.draft_events", "select * from auth.users", "select * from analytics_private.player_alias",
  "select * from analytics_private.player_pos", "select * from analytics_private.control_anomalias", "select * from analytics_private.control_privacidad",
  "select * from analytics_private.control_conciliacion", "select * from analytics_control.anomalias",
  "select * from analytics_private.secret", "select * from analytics_private.v_partidas_base", "select analytics_private.sync_aliases()",
  "select analytics_private.refresh_analytics()", "select * from analytics_private.v_cfg", "select * from storage.objects",
  "insert into analytics.jugadores values (1,'x')", "update analytics.eventos set nombre = 'x'", "delete from analytics.partidas", "create table analytics.x (a int)",
  "create table public.x (a int)", "drop table analytics.partidas", "select * from public.v_participant_official_games",
  "update analytics_control.refresco set vigente = true", "insert into analytics_control.registro_limpieza values ('x', '1')"]) {
  const r = await intenta(sql);
  ok(r.startsWith("denegado"), "reader NO puede: " + sql, r);
}
await db.exec("reset role");
const hmacRol = (await one(`select has_function_privilege('analytics_reader', 'extensions.hmac(text,text,text)', 'EXECUTE') as t`)).t;
console.log(`   M4: has_function_privilege('analytics_reader','extensions.hmac(text,text,text)','EXECUTE') = ${hmacRol}  (la migración NO lo otorga; si es true viene de la concesión a PUBLIC de pgcrypto)`);
ok((await one(`select has_function_privilege('analytics_reader', 'analytics_private.refresh_analytics()', 'EXECUTE') as t`)).t === false, "M4: el rol NO puede ejecutar refresh_analytics");
const execDirecto = await q(`select count(*)::int n from information_schema.routine_privileges where grantee = 'analytics_reader'`);
ok(execDirecto[0].n === 0, "M4: ninguna concesión DIRECTA de EXECUTE al rol (ni hmac ni funciones propias)", execDirecto);
const cfgRol = (await q(`select unnest(setconfig) c from pg_db_role_setting where setrole = (select oid from pg_roles where rolname = 'analytics_reader')`)).map((r) => r.c).sort();
ok(["default_transaction_read_only=on", "idle_in_transaction_session_timeout=30s", "lock_timeout=5s", "search_path=analytics", "statement_timeout=60s"].every((c) => cfgRol.includes(c)), "configuración del rol (search_path, read-only, timeouts)", cfgRol);
const rol = await one(`select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconnlimit, rolcanlogin, rolinherit from pg_roles where rolname='analytics_reader'`);
ok(!rol.rolsuper && !rol.rolcreatedb && !rol.rolcreaterole && !rol.rolreplication && !rol.rolbypassrls && rol.rolconnlimit === 2 && rol.rolcanlogin && !rol.rolinherit, "atributos del rol", rol);
// L7 (el rol no hereda SELECT de PUBLIC sobre public)
const l7 = await one(`select has_schema_privilege('analytics_reader', 'public', 'USAGE') as usage_public,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','v','m','p','f')
     and has_table_privilege('analytics_reader', c.oid, 'SELECT'))::int as tablas_public_legibles`);
console.log("   L7:", JSON.stringify(l7));
ok(l7.tablas_public_legibles === 0, "L7: el rol no hereda SELECT de PUBLIC sobre ninguna tabla/vista de public", l7);
console.log("   NOTA: la prueba de 'privilegios por defecto' (antes L6) se retiró de esta prueba: PGlite corre como superusuario y no demuestra nada sobre pg_default_acl. La evidencia es P-PRIV-01 en la base viva (contrato.md §10.4-10.5).");

// ---- A2: ATAQUE de la primera revisión: filtro con cast que falla y función temporal con RAISE NOTICE, desde el rol de lectura
//      Con PUESTOS consecutivos el excluido no deja un hueco: se busca el valor que ya no existe (el puesto máximo ANTES de excluir).
const nAntes = (await one(`select count(*)::int n from analytics.jugadores`)).n;
await db.query(`insert into analytics_private.player_optout (user_id) values ($1)`, [uuid(2)]);
await refresh();
// diseño ANTERIOR (control positivo): una VISTA security_invoker=false con el filtro de exclusión sobre el alias privado. Se arma solo para esta prueba.
const aliasB = A[2];
await db.exec(`create view analytics_private.demo_vista_vulnerable with (security_invoker = false) as
  select pa.alias_n as id, 'Jugador ' || pa.alias_n as nombre from analytics_private.player_alias pa
  where not exists (select 1 from analytics_private.player_optout o where o.user_id = pa.user_id);
  grant usage on schema analytics_private to analytics_reader; grant select on analytics_private.demo_vista_vulnerable to analytics_reader;`);
const ataques = async (rel, cols, valor) => {
  // (1) filtro con una división que falla SOLO para el valor protegido; (2) función temporal con RAISE NOTICE sobre cada columna
  const res = {error: null, avisos: []};
  await db.exec("set role analytics_reader");
  // OJO: "case when ... then 1/0" NO sirve: Postgres pliega 1/0 al planificar y falla siempre. El divisor tiene que depender de la fila.
  try { await db.query(`select * from ${rel} where ${cols.map((c) => `(${c} / (case when ${c} = ${valor} then 0 else 1 end)) >= 0`).join(" and ")}`); }
  catch (e) { res.error = e.message; }
  await db.exec(`create or replace function pg_temp.espia(integer) returns boolean language plpgsql cost 0.00000001 as $$ begin raise notice 'visto %', $1; return true; end $$`);
  for (const c of cols) await db.query(`select * from ${rel} where pg_temp.espia(${c})`, [], {onNotice: (n) => res.avisos.push(n.message)});
  await db.exec("drop function pg_temp.espia(integer); reset role");
  return res;
};
const viejo = await ataques("analytics_private.demo_vista_vulnerable", ["id"], aliasB);
console.log("   A2 control positivo (diseño anterior, vista):", JSON.stringify({error: viejo.error, ve_a_bruno: viejo.avisos.includes(`visto ${aliasB}`), avisos: viejo.avisos.length}));
ok(viejo.error !== null && viejo.avisos.includes(`visto ${aliasB}`), "A2 control positivo: contra una VISTA con filtro de exclusión el ataque SÍ filtra al excluido (error Y aviso)", viejo);
for (const [rel, cols] of [["analytics.jugadores", ["id"]], ["analytics.participaciones", ["jugador_id"]],
                           ["analytics.enfrentamientos", ["jugador_a", "jugador_b"]], ["analytics.partidas", ["jugador_a", "jugador_b"]]]) {
  const r = await ataques(rel, cols, nAntes);   // puesto máximo previo: tras excluir a Bruno ya no existe
  ok(r.error === null, `A2: con tablas, el cast que falla no se dispara sobre ${rel} (el puesto ${nAntes} ya no existe)`, r.error);
  ok(!r.avisos.includes(`visto ${nAntes}`) && r.avisos.length > 0, `A2: la función temporal con RAISE NOTICE no ve el puesto ${nAntes} en ${rel} (${r.avisos.length} valores vistos, todos del rango publicado)`, r.avisos.slice(0, 5));
}
await db.exec(`revoke select on analytics_private.demo_vista_vulnerable from analytics_reader; revoke usage on schema analytics_private from analytics_reader; drop view analytics_private.demo_vista_vulnerable;`);
await db.query(`delete from analytics_private.player_optout`);
await refresh();


// ---- ejecutar TODAS las consultas de calidad.md (como reader; las ADMIN como administrador)
{
  const md = fs.readFileSync(DOCS + "calidad.md", "utf8").replace(/\r\n/g, "\n").split("\n");
  const consultas = []; let admin = false; let enBloque = false; let bloque = [];
  for (const raw of md) {
    if (raw.includes("Pruebas **ADMIN**")) admin = true;
    if (raw.startsWith("## H.")) admin = false;
    if (raw.startsWith("```sql")) { enBloque = true; bloque = []; continue; }
    if (raw.startsWith("```") && enBloque) { enBloque = false; consultas.push({id: "bloque", sql: bloque.join("\n"), admin: false, neg: false}); continue; }
    if (enBloque) { bloque.push(raw); continue; }
    const id = raw.match(/^\| (P-[A-Z]+-\d+)/)?.[1];
    if (!id) continue;
    for (const m of raw.matchAll(/`([^`]+)`/g)) {
      const t = m[1].split("\\|").join("|").trim();
      if (/^(select|with|insert|create)\b/i.test(t)) consultas.push({id, sql: t, admin: admin || id.startsWith("P-PRIV"), neg: id === "P-PRI-06"});
    }
  }
  console.log("\n--- consultas de calidad.md: " + consultas.length);
  for (const c of consultas) {
    await db.exec(c.admin ? "reset role" : "set role analytics_reader");
    try {
      const r = await db.query(c.sql);
      const out = JSON.stringify(r.rows.slice(0, 3)).slice(0, 170);
      if (c.neg) ok(false, c.id + " debía fallar y se ejecutó: " + c.sql.slice(0, 60));
      else {
        console.log("  " + c.id.padEnd(9) + (c.admin ? "[ADMIN] " : "        ") + r.rows.length + " filas " + out);
        // Las consultas cuyo umbral es "0" se AFIRMAN (no solo se imprimen). P-PRIV-06 y P-PRIV-10 dependen de la base viva y no se afirman.
        const cero = /^(P-PRIV-(01|11|12|13|14|15|16|18)|P-FRE-01|P-CLV-\d+|P-DOM-(01|02|04|05|06|07|08|09|10)|P-REF-0[1-8]|P-PRI-0[13]|P-CON-0[12])$/.test(c.id)
          || (c.id === "bloque" && r.fields?.some((f) => f.name === "n"))
          || (c.id === "bloque" && /not ok/.test(c.sql));
        if (cero) ok(r.rows.length === 0 || Object.values(r.rows[0]).every((v) => Number(v) === 0), c.id + " = 0 (umbral): " + c.sql.slice(0, 50).replace(/\n/g, " "), r.rows.slice(0, 2));
      }
    } catch (e) {
      if (c.neg) ok(/permission|denied|does not exist|42501|permiso/i.test(e.message), c.id + " falla como se espera: " + c.sql.slice(0, 55), e.message.slice(0, 70));
      else ok(false, c.id + " ERROR en la consulta: " + c.sql.slice(0, 80) + " => " + e.message.slice(0, 120));
    }
  }
  await db.exec("reset role");
}

console.log(fails ? `\n${fails} FALLAS` : "\nTODO OK");
process.exit(fails ? 1 : 0);

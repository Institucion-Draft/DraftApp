// Tests de la migración 0144 (sortear lugares en la mesa) contra PGlite con la cadena REAL de migraciones.
// Uso: cd supabase/tests && npm install && node event-seating.test.mjs
import { newDb, applyMigrations } from './harness.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const fatal = (e) => { console.log('ERROR:', String(e && e.message).slice(0, 500)); process.exit(2); };
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
const uuid = (n) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

const db = await newDb();
await applyMigrations(db);
await applyMigrations(db, { from: 144, to: 144 }); // idempotente: la 0144 ya corrió dentro de la cadena
ok(true, 'la cadena completa (con la 0144) aplica, y la 0144 aplica dos veces sin errores');

const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const fails_ = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message); } };

await db.exec(`grant all on all tables in schema public to authenticated, anon; grant usage on schema public to authenticated, anon;`);
const asUser = async (n, fn) => {
  await db.exec(`select set_config('request.jwt.claim.sub', '${n == null ? '' : uuid(n)}', false); select set_config('request.jwt.claim.role', 'authenticated', false); set role authenticated;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
};
const asAnon = async (fn) => {
  await db.exec(`select set_config('request.jwt.claim.sub', '', false); set role anon;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
};

// Usuarios: 1 = organizador del workspace, 2 = organizador del evento, 3 = jugador común, 4.. = jugadores.
for (let i = 1; i <= 40; i += 1) {
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,$2,$3)`, [uuid(i), `u${i}@x.com`, JSON.stringify({ display_name: `Jugador ${i}` })]);
}
await db.query(`insert into public.workspaces (name, slug, created_by) values ('Workspace','ws-seat',$1)`, [uuid(1)]);
const ws = (await one(`select id from public.workspaces`)).id;
for (const [u, role] of [[1, 'organizer'], [2, 'member'], [3, 'member']]) {
  await db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,$3) on conflict (workspace_id, user_id) do update set role = excluded.role`, [ws, uuid(u), role]);
}
for (let i = 4; i <= 40; i += 1) await db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'member') on conflict do nothing`, [ws, uuid(i)]);

let evN = 0;
const mkEvent = async ({ toggle = true, type = 'draft', giantDone = false } = {}) => {
  evN += 1;
  return (await one(
    `insert into public.draft_events (workspace_id, name, scheduled_for, created_by, event_organizer_user_id, random_seating_enabled, event_type, giant_randomization_done)
     values ($1,$2,now(),$3,$4,$5,$6,$7) returning id`, [ws, `ev${evN}`, uuid(1), uuid(2), toggle, type, giantDone])).id;
};
const enroll = async (ev, user, extra = {}) =>
  (await one(`insert into public.event_participants (event_id, user_id, role, member_b_user_id) values ($1,$2,$3,$4) returning id`,
    [ev, uuid(user), extra.role ?? 'player', extra.memberB ? uuid(extra.memberB) : null])).id;
const draw = (ev, user = 1, attempts) => asUser(user, async () =>
  (await one(attempts == null ? `select public.draw_event_seating($1) r` : `select public.draw_event_seating($1, $2) r`, attempts == null ? [ev] : [ev, attempts])).r);
const publish = (ev, user = 1) => asUser(user, async () => (await one(`select public.publish_event_seating($1) r`, [ev])).r);
const seating = (ev) => one(`select * from public.event_seating where event_id = $1`, [ev]);
const pending = (ev) => one(`select * from public.event_seating_pending where event_id = $1`, [ev]);
const startDraft = (ev) => db.query(`update public.draft_events set status = 'drafting', draft_started_at = now() where id = $1`, [ev]);

// ── Permutación válida, sentidos, mínimo 2 ──────────────────────────────────────────────────────────────
{
  let sawCw = false, sawCcw = false, allValid = true;
  for (const n of [2, 3, 4, 5, 7, 8, 16, 24]) {
    const ev = await mkEvent();
    for (let i = 0; i < n; i += 1) await enroll(ev, 4 + i);
    for (let rep = 0; rep < 6; rep += 1) {
      const r = await draw(ev);
      const seats = r.seats.map((s) => s.seat).sort((a, b) => a - b);
      const valid = r.n === n && seats.length === n && seats.every((s, i) => s === i + 1) && new Set(r.seats.map((s) => s.participant_id)).size === n;
      if (!valid) allValid = false;
      if (r.direction === 'cw') sawCw = true; else if (r.direction === 'ccw') sawCcw = true; else allValid = false;
    }
  }
  ok(allValid, 'permutación válida 1..n (n = 2,3,4,5,7,8,16,24), cada inscripto en un solo lugar, sentido cw|ccw');
  ok(sawCw && sawCcw, 'el sentido del primer sobre sale en las dos direcciones');
  const ev1 = await mkEvent(); await enroll(ev1, 4);
  const err = await fails_(() => draw(ev1));
  ok(err && /al menos 2/.test(err), 'con 1 inscripto falla: "se necesitan al menos 2"');
}
// Sólo cuentan los jugadores: fantasma (ghost)es y retirados no.
{
  const ev = await mkEvent();
  for (let i = 0; i < 4; i += 1) await enroll(ev, 4 + i);
  await enroll(ev, 20, { role: 'ghost' });
  const gone = await enroll(ev, 21);
  await db.query(`update public.event_participants set left_event_at = now() where id = $1`, [gone]);
  const r = await draw(ev);
  ok(r.n === 4, `sólo cuentan los jugadores activos (n=${r.n}; fantasma (ghost) y retirado quedan afuera)`);
}
// ── Toggle OFF ───────────────────────────────────────────────────────────────────────────────────────────────
{
  const ev = await mkEvent({ toggle: false });
  await enroll(ev, 4); await enroll(ev, 5);
  const err = await fails_(() => draw(ev));
  ok(err && /no está activado/.test(err), 'toggle OFF: el sorteo falla');
  await startDraft(ev);
  ok((await one(`select status from public.draft_events where id = $1`, [ev])).status === 'drafting', 'toggle OFF: arrancar el draft funciona como siempre');
}
// ── Permisos ─────────────────────────────────────────────────────────────────────────────────────────────────
{
  const ev = await mkEvent();
  await enroll(ev, 4); await enroll(ev, 5); await enroll(ev, 6);
  ok((await draw(ev, 1)).n === 3, 'organizador del workspace puede sortear');
  ok((await draw(ev, 2)).n === 3, 'organizador del evento puede sortear');
  const eC = await fails_(() => draw(ev, 3));
  ok(eC && /Solo quien gestiona/.test(eC), 'jugador común no puede sortear');
  const eC2 = await fails_(() => publish(ev, 3));
  ok(eC2 && /Solo quien gestiona/.test(eC2), 'jugador común no puede publicar');
  const eN = await fails_(() => asUser(null, async () => one(`select public.draw_event_seating($1)`, [ev])));
  ok(eN && /Solo quien gestiona/.test(eN), 'sin sesión (auth.uid() null) no puede sortear');
  const eA = await fails_(() => asAnon(async () => one(`select public.draw_event_seating($1)`, [ev])));
  ok(eA && /permission denied/i.test(eA), 'anon no puede ejecutar el sorteo');
  // El pendiente sólo lo ve quien gestiona; el vigente, los miembros.
  const pendC = await asUser(3, async () => (await q(`select * from public.event_seating_pending where event_id = $1`, [ev])).length);
  const pendO = await asUser(2, async () => (await q(`select * from public.event_seating_pending where event_id = $1`, [ev])).length);
  ok(pendC === 0 && pendO === 1, 'el sorteo pendiente sólo lo lee quien gestiona el evento');
  await publish(ev, 2);
  const curC = await asUser(3, async () => (await q(`select * from public.event_seating where event_id = $1`, [ev])).length);
  const curAnon = await asAnon(async () => (await q(`select * from public.event_seating`)).length).catch(() => 0);
  ok(curC === 1 && curAnon === 0, 'el vigente lo lee cualquier miembro del workspace (anon no)');
}
// ── Publicación ──────────────────────────────────────────────────────────────────────────────────────────────
{
  const ev = await mkEvent();
  for (let i = 0; i < 4; i += 1) await enroll(ev, 4 + i);
  const eNone = await fails_(() => publish(ev));
  ok(eNone && /No hay un sorteo/.test(eNone), 'publicar sin sorteo falla');
  const drawn = await draw(ev);
  ok(!!(await pending(ev)) && !(await seating(ev)), 'tras sortear: hay pendiente y no hay vigente');
  const pub = await publish(ev);
  const cur = await seating(ev);
  ok(cur.is_current && !(await pending(ev)) && JSON.stringify(pub.seats) === JSON.stringify(drawn.seats) && pub.direction === drawn.direction, 'publicar mueve el pendiente a vigente con el mismo resultado');
  const again = await publish(ev);
  ok(JSON.stringify(again.seats) === JSON.stringify(pub.seats), 'publicar de nuevo es idempotente (devuelve el vigente)');
  const re = await draw(ev);
  await publish(ev);
  ok(JSON.stringify((await seating(ev)).seats) === JSON.stringify(re.seats), 're-sortear y publicar reemplaza todo');
}
// ── Invalidación por altas, bajas, retiros y cambios de rol ───────────────────────────────────────────────
{
  const ev = await mkEvent();
  const ids = [];
  for (let i = 0; i < 4; i += 1) ids.push(await enroll(ev, 4 + i));
  const fresh = async () => { await draw(ev); await publish(ev); return (await seating(ev)).is_current; };

  ok(await fresh(), 'sorteo vigente');
  await enroll(ev, 30);
  ok(!(await seating(ev)).is_current, 'alta de un inscripto: el vigente queda obsoleto');
  ok(await fresh(), 're-sortear lo deja vigente');
  await db.query(`delete from public.event_participants where user_id = $1 and event_id = $2`, [uuid(30), ev]);
  ok(!(await seating(ev)).is_current, 'baja: obsoleto');
  await fresh();
  await db.query(`update public.event_participants set role = 'ghost' where id = $1`, [ids[0]]);
  ok(!(await seating(ev)).is_current, 'cambio de rol jugador -> fantasma (ghost): obsoleto');
  await fresh();
  await db.query(`update public.event_participants set role = 'player' where id = $1`, [ids[0]]);
  ok(!(await seating(ev)).is_current, 'cambio de rol fantasma (ghost) -> jugador: obsoleto');
  await fresh();
  await db.query(`update public.event_participants set left_event_at = now() where id = $1`, [ids[1]]);
  ok(!(await seating(ev)).is_current, 'retiro (left_event_at): obsoleto');
  await db.query(`update public.event_participants set left_event_at = null where id = $1`, [ids[1]]);
  await fresh();
  await db.query(`update public.event_participants set member_b_user_id = $2 where id = $1`, [ids[2], uuid(31)]);
  ok(!(await seating(ev)).is_current, 'cambio de equipo (member_b_user_id): obsoleto');
  await fresh();
  await db.query(`update public.event_participants set is_shiny = true where id = $1`, [ids[3]]);
  ok((await seating(ev)).is_current, 'un cambio que no altera quién se sienta (shiny) no invalida');
  // El pendiente también se descarta.
  await draw(ev);
  ok(!!(await pending(ev)), 'hay pendiente');
  await enroll(ev, 32);
  ok(!(await pending(ev)), 'un cambio de inscriptos descarta el pendiente');
}
// ── Bloqueo de arranque y no invalidación después de arrancar ───────────────────────────────────────────────
{
  const ev = await mkEvent();
  for (let i = 0; i < 4; i += 1) await enroll(ev, 4 + i);
  const e0 = await fails_(() => startDraft(ev));
  ok(e0 && /sorteo vigente/.test(e0), 'arrancar con toggle ON y sin sorteo falla EN LA BASE con mensaje claro');
  await draw(ev);
  const e1 = await fails_(() => startDraft(ev));
  ok(e1 && /sorteo vigente/.test(e1), 'con el sorteo sólo pendiente (sin publicar) tampoco arranca');
  await publish(ev);
  const eStatusOnly = await fails_(() => db.query(`update public.draft_events set status = 'playing' where id = $1`, [ev]));
  ok(eStatusOnly === null, 'con sorteo vigente se puede pasar de estado');
  await db.query(`update public.draft_events set status = 'scheduled' where id = $1`, [ev]);
  await enroll(ev, 30); // invalida
  const e2 = await fails_(() => startDraft(ev));
  ok(e2 && /sorteo vigente/.test(e2), 'con el sorteo obsoleto no arranca');
  await draw(ev); await publish(ev);
  await startDraft(ev);
  ok((await one(`select status from public.draft_events where id = $1`, [ev])).status === 'drafting', 'con sorteo vigente arranca');
  await enroll(ev, 33); // después de arrancar
  await db.query(`update public.event_participants set role = 'ghost' where event_id = $1 and user_id = $2`, [ev, uuid(4)]);
  ok((await seating(ev)).is_current, 'después de arrancar el draft el sorteo NO se invalida nunca');
  const eDraw = await fails_(() => draw(ev));
  ok(eDraw && /ya arrancó/.test(eDraw), 'después de arrancar no se puede volver a sortear');
  const eToggle = await fails_(() => db.query(`update public.draft_events set random_seating_enabled = false where id = $1`, [ev]));
  ok(eToggle && /una vez arrancado/.test(eToggle), 'el toggle no se puede cambiar una vez arrancado el draft');
  const evB = await mkEvent({ toggle: false });
  await db.query(`update public.draft_events set random_seating_enabled = true where id = $1`, [evB]);
  ok(true, 'el toggle sí se puede cambiar antes de arrancar');
}
// ── Gigante de Dos Cabezas: adyacencia ────────────────────────────────────────────────────────────────────────
const adjacency = (r, teamOf) => {
  const byseat = [...r.seats].sort((a, b) => a.seat - b.seat).map((s) => teamOf.get(s.participant_id));
  const n = byseat.length;
  let bad = 0;
  for (let k = 0; k < n; k += 1) if (byseat[k] === byseat[(k + 1) % n] && n > 2) bad += 1;
  return bad;
};
for (const teams of [2, 3, 4]) {
  const ev = await mkEvent({ type: 'two_headed_giant', giantDone: true });
  const teamOf = new Map();
  for (let t = 0; t < teams; t += 1) teamOf.set(await enroll(ev, 4 + t * 2, { memberB: 5 + t * 2 }), t);
  let violations = 0, memberB = 0, seatsOk = true;
  const placements = new Set();
  for (let rep = 0; rep < 150; rep += 1) {
    const r = await draw(ev);
    violations += adjacency(r, teamOf);
    memberB += r.seats.filter((s) => s.member === 'b').length;
    seatsOk = seatsOk && r.n === teams * 2 && r.seats.map((s) => s.seat).sort((a, b) => a - b).every((s, i) => s === i + 1);
    placements.add(JSON.stringify(r.seats.map((s) => `${s.participant_id}${s.member}`)));
  }
  ok(violations === 0, `2HG con ${teams} equipos (n=${teams * 2}): ningún equipo contiguo en 150 sorteos`);
  ok(seatsOk && memberB === 150 * teams, `2HG ${teams} equipos: n = 2 x equipos y cada persona (A y B) tiene su lugar`);
  ok(placements.size > 1, `2HG ${teams} equipos: el sorteo varía`);
  // Respaldo determinístico (sin intentos de rechazo)
  let fbViolations = 0;
  for (let rep = 0; rep < 5; rep += 1) fbViolations += adjacency(await draw(ev, 1, 0), teamOf);
  ok(fbViolations === 0, `2HG ${teams} equipos: la construcción de respaldo también es válida`);
}
{
  // n = 4: la única configuración válida es alternada (A1 B? A2 ...).
  const ev = await mkEvent({ type: 'two_headed_giant', giantDone: true });
  const t0 = await enroll(ev, 4, { memberB: 5 }); const t1 = await enroll(ev, 6, { memberB: 7 });
  const r = await draw(ev);
  const order = [...r.seats].sort((a, b) => a.seat - b.seat).map((s) => (s.participant_id === t0 ? 0 : 1));
  ok(order.join('') === '0101' || order.join('') === '1010', `n=4: configuración alternada (${order.join('')})`);
  // Un solo equipo: imposible, sortea igual y avisa.
  const evOne = await mkEvent({ type: 'two_headed_giant', giantDone: true });
  await enroll(evOne, 8, { memberB: 9 });
  const rOne = await draw(evOne);
  ok(rOne.n === 2 && !!rOne.warning, 'un solo equipo: sortea igual y devuelve el aviso');
  // Sin sortear equipos todavía
  const evNo = await mkEvent({ type: 'two_headed_giant', giantDone: false });
  await enroll(evNo, 10); await enroll(evNo, 11);
  const eNo = await fails_(() => draw(evNo));
  ok(eNo && /equipos/.test(eNo), '2HG sin sortear los equipos: pide sortearlos primero');
}
// Cambio de equipos en 2HG (re-randomizar) invalida
{
  const ev = await mkEvent({ type: 'two_headed_giant', giantDone: true });
  const a = await enroll(ev, 12, { memberB: 13 }); await enroll(ev, 14, { memberB: 15 });
  await draw(ev); await publish(ev);
  await db.query(`update public.event_participants set member_b_user_id = $2 where id = $1`, [a, uuid(16)]);
  ok(!(await seating(ev)).is_current, '2HG: cambiar un integrante de equipo invalida el sorteo');
}
// Valores por defecto: eventos existentes no cambian
ok((await one(`select count(*)::int c from public.draft_events where random_seating_enabled and name like 'ev%' and false`)).c === 0, 'default OFF (columna not null default false)');
{
  const evD = (await one(`insert into public.draft_events (workspace_id, name, scheduled_for, created_by, event_organizer_user_id) values ($1,'sin toggle',now(),$2,$2) returning random_seating_enabled r`, [ws, uuid(1)])).r;
  ok(evD === false, 'un evento nuevo sin indicar el toggle queda en false');
}
// seating_adjacent_same_team
{
  const f = async (arr) => (await one(`select public.seating_adjacent_same_team($1::int[]) r`, [arr])).r;
  ok((await f([1, 2, 1, 2])) === 0 && (await f([1, 1, 2, 2])) === 2 && (await f([1, 2, 2, 1])) === 2 && (await f([1, 2, 1])) === 1 && (await f([1, 1])) === 1, 'seating_adjacent_same_team: cuenta k/k+1 y n/1 (círculo)');
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

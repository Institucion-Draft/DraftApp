// Tests de los cumpleaños de hoy (app/src/lib/birthday.ts): caché por día de Buenos Aires, nameWithCake con el conjunto de ids y fallas.
// node app/scripts/birthday-today.test.mjs
import {
  BIRTHDAY_EMOJI,
  EMPTY_BIRTHDAY_SET,
  buenosAiresDayKey,
  isBirthdayUser,
  nameWithCake,
  parseBirthdayUserIds,
  createBirthdayIdsLoader,
} from '../src/lib/birthday.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };

// --- día de Buenos Aires (UTC-3): no el del teléfono ni el de UTC --------------------------------------------------------------------
ok(buenosAiresDayKey(new Date('2026-05-18T02:59:59Z')) === '2026-05-17', '02:59:59 UTC del 18 todavía es el 17 en Buenos Aires');
ok(buenosAiresDayKey(new Date('2026-05-18T03:00:00Z')) === '2026-05-18', '03:00:00 UTC del 18 ya es el 18 en Buenos Aires (medianoche)');
ok(buenosAiresDayKey(new Date('2026-05-17T23:30:00Z')) === '2026-05-17', '23:30 UTC (20:30 en Buenos Aires): día 17');
ok(buenosAiresDayKey(new Date('2027-01-01T02:59:00Z')) === '2026-12-31', 'fin de año: 02:59 UTC del 1/1 es el 31/12 en Buenos Aires');
ok(buenosAiresDayKey(new Date('2028-03-01T02:59:00Z')) === '2028-02-29', 'bisiesto: 02:59 UTC del 1/3/2028 es el 29/2');

// --- nameWithCake / isBirthdayUser con el conjunto de ids ------------------------------------------------------------------------------
const ids = new Set(['u1', 'u3']);
ok(nameWithCake('Ana', 'u1', ids) === `Ana ${BIRTHDAY_EMOJI}`, 'el id está en el conjunto: nombre con 🎂');
ok(nameWithCake('Beto', 'u2', ids) === 'Beto', 'el id NO está: el nombre tal cual');
ok(nameWithCake('Sin id', null, ids) === 'Sin id' && nameWithCake('Sin id', undefined, ids) === 'Sin id', 'sin id (null/undefined): sin torta');
ok(nameWithCake('Ana', 'u1', EMPTY_BIRTHDAY_SET) === 'Ana', 'conjunto vacío (sin datos o falla): nadie tiene torta');
ok(isBirthdayUser('u3', ids) && !isBirthdayUser('', ids), 'isBirthdayUser: id presente sí; id vacío no');
ok(BIRTHDAY_EMOJI === '🎂', 'el emoji es la torta');

// --- parseo de la respuesta del rpc -----------------------------------------------------------------------------------------------------
ok(JSON.stringify(parseBirthdayUserIds(['a', 'b'])) === '["a","b"]', 'setof uuid: arreglo de strings');
ok(JSON.stringify(parseBirthdayUserIds([])) === '[]', 'arreglo vacío: nadie cumple años (no es una falla)');
ok(JSON.stringify(parseBirthdayUserIds([{ birthday_user_ids_today: 'a' }, { id: 'b' }])) === '["a","b"]', 'también acepta filas con la columna del rpc o con id');
ok(JSON.stringify(parseBirthdayUserIds(['a', '', null, 5, {}])) === '["a"]', 'ignora vacíos y valores raros');
ok(parseBirthdayUserIds(null) === null && parseBirthdayUserIds(undefined) === null && parseBirthdayUserIds('x') === null && parseBirthdayUserIds({}) === null, 'no es un arreglo: null (sin datos fiables)');

// --- caché por día ----------------------------------------------------------------------------------------------------------------------------
const mk = (impl) => {
  let calls = 0;
  let clock = new Date('2026-05-17T15:00:00Z');
  const loader = createBirthdayIdsLoader(async () => { calls += 1; return impl(calls); }, () => clock);
  return { loader, calls: () => calls, setNow: (iso) => { clock = new Date(iso); } };
};
{
  const t = mk(() => ['u1']);
  const a = await t.loader.load('me');
  const b = await t.loader.load('me');
  const c = await t.loader.load('me');
  ok(t.calls() === 1 && a === b && b === c && a.has('u1'), 'el mismo día: una sola llamada (las demás salen de la caché)');
  ok(t.loader.peek('me') === a && t.loader.peek('otro') === EMPTY_BIRTHDAY_SET && t.loader.peek(null) === EMPTY_BIRTHDAY_SET, 'peek: la caché solo de este usuario y de hoy; sin pedir nada');
  // el día UTC cambia pero en Buenos Aires sigue siendo el mismo día (23:30 del 17): sigue la caché
  t.setNow('2026-05-18T02:30:00Z');
  await t.loader.load('me');
  ok(t.calls() === 1, 'a las 23:30 de Buenos Aires (ya es el 18 en UTC) la caché del 17 sigue vigente: no se vuelve a pedir');
  // medianoche de Buenos Aires: cambia el día
  t.setNow('2026-05-18T03:00:00Z');
  ok(t.loader.peek('me') === EMPTY_BIRTHDAY_SET, 'pasada la medianoche de Buenos Aires la caché del día anterior ya no vale (peek vacío)');
  await t.loader.load('me');
  ok(t.calls() === 2, 'a las 00:00 de Buenos Aires se vuelve a pedir (día nuevo)');
  await t.loader.load('me');
  ok(t.calls() === 2, 'y de nuevo queda en caché ese día');
}
{
  // refresco al volver a primer plano: load() es barato, solo llama si cambió el día
  const t = mk(() => ['u1']);
  await t.loader.load('me');
  for (let i = 0; i < 5; i += 1) await t.loader.load('me');   // "la app vuelve a primer plano" 5 veces el mismo día
  ok(t.calls() === 1, 'volver a primer plano varias veces el mismo día no hace llamadas nuevas');
  t.setNow('2026-05-18T12:00:00Z');
  await t.loader.load('me');
  ok(t.calls() === 2, 'volver a primer plano al día siguiente sí pide de nuevo');
}
{
  // una sola llamada en vuelo
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const loader = createBirthdayIdsLoader(async () => { calls += 1; await gate; return ['u1']; }, () => new Date('2026-05-17T15:00:00Z'));
  const p1 = loader.load('me'); const p2 = loader.load('me'); const p3 = loader.load('me');
  release();
  const [a, b, c] = await Promise.all([p1, p2, p3]);
  ok(calls === 1 && a === b && b === c, 'tres pedidos simultáneos comparten una sola llamada');
}
{
  // otro usuario: ve a otras personas, no se reutiliza la caché
  const t = mk((n) => (n === 1 ? ['u1'] : ['u9']));
  const a = await t.loader.load('yo');
  const b = await t.loader.load('otro');
  ok(t.calls() === 2 && a.has('u1') && b.has('u9') && !b.has('u1'), 'al cambiar de usuario se vuelve a pedir y no se mezclan los conjuntos');
  t.loader.clear();
  await t.loader.load('otro');
  ok(t.calls() === 3, 'clear() vacía la caché');
}

// --- fallas: la app no se rompe, solo no hay tortas ----------------------------------------------------------------------------------------
{
  const t = mk((n) => (n === 1 ? null : n === 2 ? (() => { throw new Error('red'); })() : ['u1']));
  const a = await t.loader.load('me');
  ok(a === EMPTY_BIRTHDAY_SET && a.size === 0, 'la llamada devuelve error (null): conjunto vacío, sin tortas');
  const b = await t.loader.load('me');
  ok(b === EMPTY_BIRTHDAY_SET, 'la llamada lanza una excepción: conjunto vacío, no se propaga');
  const c = await t.loader.load('me');
  ok(t.calls() === 3 && c.has('u1'), 'las fallas NO se cachean: la próxima consulta reintenta y funciona');
}
{
  // un conjunto de ayer no se devuelve como si fuera de hoy, ni siquiera si la llamada de hoy falla
  let n = 0;
  let clock = new Date('2026-05-17T15:00:00Z');
  const loader = createBirthdayIdsLoader(async () => { n += 1; return n === 1 ? ['u1'] : null; }, () => clock);
  const a = await loader.load('me');
  clock = new Date('2026-05-18T15:00:00Z');
  const b = await loader.load('me');
  ok(a.has('u1') && b === EMPTY_BIRTHDAY_SET && !b.has('u1'), 'si falla la llamada del día nuevo no se muestran las tortas de ayer');
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

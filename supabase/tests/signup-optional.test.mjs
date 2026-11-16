// Verifica contra la cadena REAL 0001-0148 (handle_new_user de la 0142) que un alta SIN género y/o SIN cumpleaños funciona, y que los APK
// viejos (que mandan género y fecha siempre) siguen igual. Uso: cd supabase/tests && node signup-optional.test.mjs
import { newDb, applyMigrations } from './harness.mjs';

let fails = 0;
const ok = (c, m, extra) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m + (extra !== undefined && !c ? '  -> ' + JSON.stringify(extra) : '')); };
const fatal = (e) => { console.log('ERROR:', String(e && e.message).slice(0, 400)); process.exit(2); };
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
const uuid = (n) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

const db = await newDb();
await applyMigrations(db, { to: 148 });
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
let n = 0;
const signUp = async (meta) => {
  n += 1;
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,$2,$3::jsonb)`, [uuid(n), `u${n}@x.com`, JSON.stringify(meta)]);
  const r = await one(`select gender, to_char(birth_date, 'YYYY-MM-DD') as birth_date from public.users where id = $1`, [uuid(n)]);
  return r;
};

// columnas
const cols = Object.fromEntries((await db.query(`select column_name, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name in ('gender','birth_date')`)).rows.map((r) => [r.column_name, r]));
ok(cols.gender.is_nullable === 'NO' && /prefer_not_to_say/.test(cols.gender.column_default), 'users.gender: NOT NULL con default prefer_not_to_say');
ok(cols.birth_date.is_nullable === 'YES' && cols.birth_date.column_default === null, 'users.birth_date: nullable, sin default');
const chk = (await db.query(`select pg_get_constraintdef(c.oid) d from pg_constraint c where c.conrelid = 'public.users'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) ~ 'gender|birth'`)).rows;
ok(chk.length === 1 && /male.*female.*other.*prefer_not_to_say/.test(chk[0].d), 'un solo CHECK sobre estas columnas: el enum de gender (birth_date no tiene)', chk);

// altas
let r = await signUp({});
ok(r.gender === 'prefer_not_to_say' && r.birth_date === null, 'sin género ni cumpleaños (metadata {}): alta OK -> prefer_not_to_say y birth_date null', r);
r = await signUp({ gender: 'female' });
ok(r.gender === 'female' && r.birth_date === null, 'solo género: se guarda el género, birth_date null', r);
r = await signUp({ birth_date: '2000-05-17' });
ok(r.gender === 'prefer_not_to_say' && r.birth_date === '2000-05-17', 'solo cumpleaños: gender prefer_not_to_say y birth_date 2000-05-17', r);
r = await signUp({ gender: null, birth_date: null });
ok(r.gender === 'prefer_not_to_say' && r.birth_date === null, 'null explícitos: alta OK', r);
r = await signUp({ gender: '', birth_date: '' });
ok(r.gender === 'prefer_not_to_say' && r.birth_date === null, 'strings vacíos: alta OK (el cast de "" a date falla adentro y se captura)', r);
r = await signUp({ gender: '   ', birth_date: '   ' });
ok(r.gender === 'prefer_not_to_say' && r.birth_date === null, 'solo espacios: alta OK', r);
r = await signUp({ gender: 'robot', birth_date: 'basura' });
ok(r.gender === 'prefer_not_to_say' && r.birth_date === null, 'valores inválidos: alta OK con los defaults', r);
r = await signUp({ gender: 'male', birth_date: '1999-12-31' });
ok(r.gender === 'male' && r.birth_date === '1999-12-31', 'APK viejo (género y fecha completa siempre): sin cambios', r);
r = await signUp({ gender: 'other', birth_date: '2000-02-29' });
ok(r.gender === 'other' && r.birth_date === '2000-02-29', 'cliente nuevo con 29/2: 2000-02-29 válida', r);

// guards: nada sobre birth_date ni gender
const trg = (await db.query(`select p.proname from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgrelid = 'public.users'::regclass and not t.tgisinternal and pg_get_functiondef(p.oid) ~* 'birth_date|gender'`)).rows;
ok(trg.length === 0, 'ningún trigger/guard de public.users mira birth_date ni gender', trg);

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

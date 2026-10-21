// Arma una base PGlite con stubs mínimos de Supabase (auth, storage, roles, realtime) y aplica la cadena REAL
// de migraciones de supabase/migrations. No es Supabase real: sólo valida el SQL propio del repo.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '..', 'migrations');

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create role supabase_admin nologin;
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create table storage.buckets (id text primary key, name text, public boolean default false);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
create publication supabase_realtime;
grant usage on schema public, auth, storage to anon, authenticated, service_role;
`;

export function listMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
}

/** Aplica las migraciones cuyo prefijo numérico esté en [from, to]. Devuelve la lista aplicada. */
export async function applyMigrations(db, { from = 1, to = 9999 } = {}) {
  const applied = [];
  for (const f of listMigrations()) {
    const n = parseInt(f.slice(0, 4), 10);
    if (n < from || n > to) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    try {
      await db.exec(sql);
    } catch (e) {
      throw new Error(`Falló ${f}: ${e.message}`);
    }
    applied.push(f);
  }
  return applied;
}

export async function newDb() {
  const db = new PGlite();
  await db.exec(STUBS);
  return db;
}

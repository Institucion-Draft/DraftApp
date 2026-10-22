// Tests de las claves de tipos del life tracker (app/src/lib/pokemonMovepool.ts): Gen 3 y formas de Unown.
// node app/scripts/pokemon-movepool.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POKEMON_TYPES, normalizePokemonKey, getSpecialBehavior } from '../src/lib/pokemonMovepool.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// Las listas salen de las migraciones del repo (no de carpetas locales): Gen 3 y formas de Unown de la 0142, Gen 1-2 de la 0059.
const mig142 = read('supabase/migrations/0142_gen3_unown.sql');
const gen3 = [...mig142.matchAll(/\('([A-Z][A-Za-z-]*)', 'default-avatars\/([a-z0-9-]+)\.png', 'default-avatars\/shiny\/[a-z0-9-]+\.png', '[^']+'\)/g)]
  .map((m) => m[2]).filter((n) => !n.startsWith('unown-'));
ok(gen3.length === 135, `hay 135 Pokémon de Gen 3 en la migración 0142 (${gen3.length})`);
const missing = gen3.filter((n) => !POKEMON_TYPES[normalizePokemonKey(n)]);
ok(missing.length === 0, `todos los Gen 3 tienen tipos en el mapa${missing.length ? ': faltan ' + missing.join(',') : ''}`);
ok(POKEMON_TYPES.treecko[0] === 'grass' && POKEMON_TYPES.gardevoir.join() === 'psychic' && POKEMON_TYPES.flygon.join() === 'ground,dragon' && POKEMON_TYPES.deoxys.join() === 'psychic', 'tipos de muestra (Gen 5 o anterior, sin Hada)');
ok(POKEMON_TYPES[normalizePokemonKey('unown')] != null, 'unown tiene tipos');
const forms = [...mig142.matchAll(/'default-avatars\/(unown-[a-z]+)\.png'/g)].map((m) => m[1]);
const uniqueForms = [...new Set(forms)];
ok(uniqueForms.length === 27 && uniqueForms.every((n) => POKEMON_TYPES[normalizePokemonKey(n)]), '27 formas nuevas de Unown resuelven a tipos');
const mig059 = read('supabase/migrations/0059_pokemon_types.sql');
const gen12 = [...mig059.matchAll(/^\s*when '([^']+)' then/gm)].map((m) => m[1].toLowerCase());
const missing12 = gen12.filter((n) => !POKEMON_TYPES[normalizePokemonKey(n)]);
ok(gen12.length === 251 && missing12.length === 0, `todos los Gen 1-2 (${gen12.length}) resuelven con la clave normalizada${missing12.length ? ': faltan ' + missing12.join(',') : ''}`);

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

// Tests de las claves de tipos del life tracker (app/src/lib/pokemonMovepool.ts): Gen 3 y formas de Unown.
// node app/scripts/pokemon-movepool.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POKEMON_TYPES, normalizePokemonKey, getSpecialBehavior } from '../src/lib/pokemonMovepool.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stems = (dir) => fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4));

ok(normalizePokemonKey('ho-oh') === 'ho_oh' && normalizePokemonKey('nidoran-f') === 'nidoran_f' && normalizePokemonKey('Mr Mime') === 'mr_mime', 'guiones y espacios -> guión bajo');
ok(['unown', 'unown-a', 'unown-b', 'unown-z', 'unown-exclamation', 'unown-question'].every((n) => normalizePokemonKey(n) === 'unown'), 'todas las formas de Unown -> unown');
ok(getSpecialBehavior('ditto') === 'ditto' && getSpecialBehavior('unown-q') === null, 'comportamientos especiales intactos');

const gen3 = stems('gen3-unown-upload/normal').filter((n) => !n.startsWith('unown-'));
ok(gen3.length === 135, `hay 135 sprites de Gen 3 (${gen3.length})`);
const missing = gen3.filter((n) => !POKEMON_TYPES[normalizePokemonKey(n)]);
ok(missing.length === 0, `todos los Gen 3 tienen tipos en el mapa${missing.length ? ': faltan ' + missing.join(',') : ''}`);
ok(POKEMON_TYPES.treecko[0] === 'grass' && POKEMON_TYPES.gardevoir.join() === 'psychic' && POKEMON_TYPES.flygon.join() === 'ground,dragon' && POKEMON_TYPES.deoxys.join() === 'psychic', 'tipos de muestra (Gen 5 o anterior, sin Hada)');
ok(POKEMON_TYPES[normalizePokemonKey('unown')] != null, 'unown tiene tipos');
const forms = stems('gen3-unown-upload/normal').filter((n) => n.startsWith('unown-'));
ok(forms.length === 27 && forms.every((n) => POKEMON_TYPES[normalizePokemonKey(n)]), '27 formas nuevas de Unown resuelven a tipos');
const all251 = stems('shiny-avatars').filter((n) => !n.startsWith('unown-') && !gen3.includes(n));
const missing12 = all251.filter((n) => !POKEMON_TYPES[normalizePokemonKey(n)]);
ok(missing12.length === 0, `todos los Gen 1-2 resuelven con la clave normalizada (${all251.length})${missing12.length ? ': faltan ' + missing12.join(',') : ''}`);

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

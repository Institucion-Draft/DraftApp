// Tests de los iniciales de Gen 3 del aviso (app/src/lib/gen3Starters.ts). node app/scripts/gen3-starters.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gen3Starters, startersLayout, STARTER_SPRITE_PX, STARTER_GAP_PX } from '../src/lib/gen3Starters.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const s = gen3Starters();
ok(s.map((x) => x.species).join() === 'treecko,torchic,mudkip', 'orden: Treecko, Torchic, Mudkip');
ok(s.map((x) => x.dex).join() === '252,255,258', 'números de Pokédex #252, #255, #258');
ok(s.every((x) => x.storagePath === `default-avatars/${x.species}.png`), 'storage_path con el formato de default_avatars (0142)');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mig = fs.readFileSync(path.join(root, 'supabase', 'migrations', '0142_gen3_unown.sql'), 'utf8');
ok(s.every((x) => mig.includes(`'default-avatars/${x.species}.png'`)), 'las tres filas se cargan en la migración 0142 con esos storage_path');

// Medidas: 88 px, separación 8 px, y las tres ventanas entran en el ancho útil del cartel (320 - 2*20 = 280).
{
  const wide = startersLayout(412);
  ok(wide.size === STARTER_SPRITE_PX && STARTER_SPRITE_PX === 88 && STARTER_GAP_PX === 8, 'tamaño 88 px y separación 8 px');
  ok(wide.totalWidth <= 280, `la fila (${wide.totalWidth} px) entra en el ancho útil del cartel (280)`);
  ok(3 * 88 + 2 * 8 <= 280, 'incluso sin recorte, 3 x 88 + 2 x 8 = 280 entra justo');
  ok(wide.clipHeight < wide.size && wide.offsetY < 0 && wide.offsetX < 0, 'el PNG se recorta (ventana menor que el PNG) para no sumar aire transparente');
  for (const w of [320, 360, 375, 390, 412]) {
    const l = startersLayout(w);
    const inner = Math.min(320, w - 64) - 40;
    ok(l.totalWidth <= inner && l.size <= 88 && l.size >= 24, `ancho de pantalla ${w}: fila ${l.totalWidth} px <= ${inner} px útiles (sprite ${l.size})`);
  }
  const tiny = startersLayout(200);
  ok(tiny.size >= 24 && tiny.size < 88, 'pantalla muy angosta: achica el sprite lo mínimo necesario');
}
console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

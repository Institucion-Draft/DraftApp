// Tests de la grilla y el recorrido visual de la ruleta de cubos (app/src/lib/cubeRouletteGrid.ts).
// node app/scripts/cube-roulette-grid.test.mjs
import { cubeGridColumns, cubeJumpPath } from '../src/lib/cubeRouletteGrid.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };

ok(cubeGridColumns(3) === 3 && cubeGridColumns(10) === 3 && cubeGridColumns(15) === 3, '<16 opciones: 3 columnas');
ok(cubeGridColumns(16) === 4 && cubeGridColumns(22) === 4, '>=16 opciones: 4 columnas');

let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
let bad = 0;
for (let t = 0; t < 3000; t += 1) {
  const len = 3 + Math.floor(rnd() * 25);
  const ticks = 2 + Math.floor(rnd() * 40); // en la app siempre >= 14
  const target = Math.floor(rnd() * len);
  const prev = rnd() < 0.5 ? null : Math.floor(rnd() * len);
  const p = cubeJumpPath(len, ticks, target, prev, rnd);
  const inRange = p.every((x) => Number.isInteger(x) && x >= 0 && x < len);
  const noRepeat = p.every((x, i) => x !== (i === 0 ? prev : p[i - 1]));
  const endsOnTarget = p.length === ticks && p[ticks - 1] === target;
  const penult = ticks < 2 || p[ticks - 2] !== target;
  if (!(inRange && noRepeat && endsOnTarget && penult)) bad += 1;
}
ok(bad === 0, 'recorridos: en rango, sin repetir seguidas (ni con la previa), terminan en el resultado, anteúltimo != resultado (3000 casos)');
const visited = new Set(cubeJumpPath(10, 400, 3, null, rnd));
ok(visited.size === 10, 'los saltos recorren toda la grilla (no es secuencial)');
const seq = cubeJumpPath(10, 20, 3, null, rnd);
ok(!seq.every((x, i) => i === 0 || x === (seq[i - 1] + 1) % 10), 'no es el recorrido ordenado de siempre');
const tiny = cubeJumpPath(2, 5, 1, null, rnd);
ok(tiny.length === 5 && tiny[4] === 1, 'len=2 no se cuelga y termina en el resultado');

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLAS`);
process.exit(fails === 0 ? 0 : 1);

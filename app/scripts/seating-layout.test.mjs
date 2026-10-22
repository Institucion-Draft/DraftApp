// Tests de las medidas y adornos de la mesa (app/src/lib/seatingLayout.ts). node app/scripts/seating-layout.test.mjs
import { register } from 'node:module';
// seatingLayout.ts importa './eventSeating' sin extensión: se resuelve a .ts sólo para este test.
register('data:text/javascript,' + encodeURIComponent("export async function resolve(s,c,n){ try { return await n(s,c); } catch(e){ if (s.startsWith('.') && !/\.\w+$/.test(s)) return n(s+'.ts',c); throw e; } }"));
const {
  scatterEmojis, SCATTER_COLS, SCATTER_ROWS, tableBodySize, tableAspect, circuitArrows, insideOval, BODY_MIN_W, BODY_MAX_W,
} = await import('../src/lib/seatingLayout.ts');

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };

// ── Emojis desperdigados ─────────────────────────────────────────────────────────────────────────────────────
{
  const ids = Array.from({ length: 400 }, (_, i) => `evento-${i}-${(i * 7919).toString(16)}`);
  let sameOk = true, rangesOk = true, cellsOk = true, boundsOk = true, centerOk = true, mateOk = true;
  const seenCounts = new Set();
  const layouts = new Set();
  for (const id of ids) {
    const a = scatterEmojis(id);
    const b = scatterEmojis(id);
    if (JSON.stringify(a) !== JSON.stringify(b)) sameOk = false;
    const c = (e) => a.filter((x) => x.emoji === e).length;
    if (c('🥐') < 2 || c('🥐') > 4 || c('🃏') < 2 || c('🃏') > 4 || c('🧉') !== 1 || a.length !== c('🥐') + c('🃏') + 1) rangesOk = false;
    seenCounts.add(`${c('🥐')}-${c('🃏')}`);
    const cells = a.map((x) => `${x.col},${x.row}`);
    if (new Set(cells).size !== cells.length) cellsOk = false; // una celda por emoji: no se superponen
    for (const x of a) {
      // Cada emoji queda dentro de su celda (con margen a la derecha y abajo): dentro de la mesa y sin invadir otras celdas.
      const cw = 1 / SCATTER_COLS, ch = 1 / SCATTER_ROWS;
      if (!(x.left >= x.col * cw - 1e-9 && x.left < (x.col + 0.13) * cw + 1e-9 && x.top >= x.row * ch - 1e-9 && x.top < (x.row + 0.13) * ch + 1e-9)) boundsOk = false;
      if (x.left < 0 || x.top < 0 || x.left + 0.8 * cw > 1 || x.top + 0.8 * ch > 1) boundsOk = false;
      if ((x.col === 1 && (x.row === 1 || x.row === 2))) centerOk = false;
    }
    if (a.filter((x) => x.emoji === '🧉').length !== 1) mateOk = false;
    layouts.add(JSON.stringify(a));
  }
  ok(sameOk, 'mismo id => mismo resultado (400 ids, dos llamadas cada uno)');
  ok(rangesOk && mateOk, 'siempre 2-4 🥐, 2-4 🃏 y exactamente un 🧉');
  ok(seenCounts.size === 9, `salen las 9 combinaciones de cantidades 2-4 x 2-4 (${seenCounts.size})`);
  ok(cellsOk, 'sin superposiciones: cada emoji ocupa su propia celda de la grilla');
  ok(boundsOk, 'todos dentro de los límites de la mesa y de su celda');
  ok(centerOk, 'el área central (dos celdas del medio) queda libre para los vórtices');
  ok(layouts.size > 350, `ids distintos dan distribuciones distintas (${layouts.size} de 400)`);
  ok(JSON.stringify(scatterEmojis('a')) !== JSON.stringify(scatterEmojis('b')), 'dos ids concretos difieren');
  ok(scatterEmojis('').length >= 5 && scatterEmojis(undefined ?? 'x').length >= 5, 'ids raros no rompen');
}

// ── Tamaño de la mesa ────────────────────────────────────────────────────────────────────────────────────────
{
  const CELL = 64;
  for (const w of [100, 130, 160, 400]) {
    const r = (n) => tableBodySize(n, w, CELL);
    const r4 = r(4);
    ok(r4.ratio >= 0.9 && r4.ratio <= 1.15, `ancho libre ${w}: n=4 es casi cuadrada (alto/ancho ${r4.ratio.toFixed(2)})`);
    let prev = r4.ratio, growing = true, rect = true;
    for (let n = 5; n <= 24; n += 1) {
      const x = r(n);
      if (x.ratio < prev - 1e-9) growing = false;
      if (x.ratio < 1.35) rect = false;
      prev = x.ratio;
    }
    ok(rect, `ancho libre ${w}: n>=5 es claramente rectangular (alto/ancho >= 1,35)`);
    ok(growing, `ancho libre ${w}: alto/ancho no decrece al sumar lugares`);
    ok(r(2).height <= r4.height && r(3).height <= r4.height && r(2).height <= r(3).height && (w < 130 || (r(2).height < r4.height && r(3).height < r4.height)), `ancho libre ${w}: n=2 y n=3 son más compactas que n=4 (o iguales al piso mínimo)`);
    ok(r(8).height > r(6).height && r(12).height > r(8).height && r(16).height > r(12).height, `ancho libre ${w}: el largo crece con los lugares por lado (6 < 8 < 12 < 16)`);
    ok([2, 3, 4, 5, 8, 16, 24].every((n) => r(n).width >= BODY_MIN_W && r(n).width <= BODY_MAX_W), `ancho libre ${w}: el ancho queda acotado (${BODY_MIN_W}-${BODY_MAX_W})`);
    // Respeta el scroll vertical: el alto nunca es menor que los lugares de un lado apilados.
    ok([4, 8, 12, 16, 24].every((n) => r(n).height >= Math.floor(n / 2 - 1 + (n % 2 ? 0.5 : 0)) * CELL - 1), `ancho libre ${w}: el alto alcanza para los lugares de cada lado (crece en vertical)`);
  }
  ok(tableAspect(5) === 1.5 && tableAspect(7) === 2 && tableAspect(4) === 1, 'relación base: n=4 -> 1, n=5/6 -> 1,5, n=7/8 -> 2');
}

// ── Flechas curvas ───────────────────────────────────────────────────────────────────────────────────────────
{
  for (const [W, H] of [[290, 330], [290, 560], [330, 900], [260, 300]]) {
    for (const dir of ['cw', 'ccw']) for (const count of [3, 4]) {
      const arrows = circuitArrows(W, H, dir, { count });
      const pts = arrows.flatMap((a) => [...a.points, ...a.head]);
      const inBox = pts.every((p) => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H);
      ok(arrows.length === count && inBox, `${W}x${H} ${dir}: ${count} flechas curvas dentro del área`);
    }
    // El óvalo envuelve a la mesa y a los lugares: el borde exterior de los lugares (a 36 px del borde del área) queda
    // adentro. Puntos más exigentes: la esquina de arriba de las columnas laterales (debajo de la cabecera, ~70 px) y la
    // cabecera misma.
    const a = W / 2 - 6, b = H / 2 - 6;
    const lx = W / 2 - 36, ly = H / 2 - 36;
    ok(insideOval(lx, ly - 70, a, b) && insideOval(lx, -(ly - 70), a, b) && insideOval(35, ly, a, b) && insideOval(35, -ly, a, b), `${W}x${H}: columnas laterales y cabeceras quedan dentro del óvalo (flechas por fuera de los avatares)`);
  }
  // Sentido: arriba a la derecha el sobre avanza hacia la derecha en 'cw' y hacia la izquierda en 'ccw'.
  const topRight = (dir) => {
    const arrows = circuitArrows(290, 400, dir, { count: 4 });
    const a = arrows.find((x) => x.points.every((p) => p.x > 145 && p.y < 200));
    const tip = a.head[0];
    const prev = a.points[a.points.length - 3];
    return { dx: tip.x - prev.x, dy: tip.y - prev.y };
  };
  const cw = topRight('cw'), ccw = topRight('ccw');
  ok(cw.dx > 0 && cw.dy > 0, 'cw: en el cuadrante superior derecho la punta apunta hacia la derecha y abajo (sentido horario)');
  ok(ccw.dx < 0 && ccw.dy < 0, 'ccw: la punta apunta al revés (hacia la izquierda y arriba)');
  const t = circuitArrows(290, 400, 'cw', { count: 4 });
  ok(t.every((a) => a.head[0] === a.points[a.points.length - 1]), 'la punta está al final del arco en el sentido de giro');
  ok(circuitArrows(290, 400, 'cw', { count: 9 }).length === 4 && circuitArrows(290, 400, 'cw', { count: 1 }).length === 3, 'la cantidad se acota a 3-4');
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

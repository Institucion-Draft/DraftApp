/**
 * Presentación de la ruleta de cubos en grilla: columnas y recorrido visual del resaltado.
 * Es sólo estético: el resultado se sortea antes y el recorrido termina siempre en él.
 */

/** 3 columnas en celular; con 16 o más opciones, 4 (y tipografía menor). */
export function cubeGridColumns(optionCount: number): 3 | 4 {
  return optionCount >= 16 ? 4 : 3;
}

/**
 * Índices que se encienden en cada tick: saltos pseudoaleatorios entre `len` tarjetas, sin repetir la misma tarjeta en
 * dos ticks seguidos (ni con `prev`, la que estaba encendida antes de empezar), con el último tick en `target` y el
 * anteúltimo distinto de `target`. `rand` devuelve un número en [0,1).
 */
export function cubeJumpPath(len: number, ticks: number, target: number, prev: number | null, rand: () => number = Math.random): number[] {
  const path: number[] = [];
  let last = prev;
  for (let i = 0; i < ticks; i += 1) {
    let next = target;
    if (i < ticks - 1) {
      const strict: number[] = [];
      const loose: number[] = [];
      for (let j = 0; j < len; j += 1) {
        if (j === last) continue;
        loose.push(j);
        if (i < ticks - 2 || j !== target) strict.push(j);
      }
      const pool = strict.length > 0 ? strict : loose.length > 0 ? loose : [0];
      next = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
    }
    path.push(next);
    last = next;
  }
  return path;
}

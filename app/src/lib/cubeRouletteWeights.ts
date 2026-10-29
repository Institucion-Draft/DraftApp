/**
 * Probabilidades pesadas de la ruleta de cubos. Helper puro (sin red ni React).
 *
 * Los cubos que salieron hace poco pesan menos. Para el próximo evento, cada salida de un cubo a d eventos de
 * distancia (d = 1: salió en el evento anterior) pesa w(d) = 1 - (1 - m) / (1 + ((d - 1) / tau)^2), con
 * tau = max(tau_min, N / k) y N = cantidad de cubos de la ruleta. Un cubo con varias salidas acumula el producto de
 * sus w (modo 'prod') o sólo el de la más reciente (modo 'last'); uno que nunca salió pesa 1.
 * "Todos fuman" y "Jugador elige" quedan fijos en 1/(N+2) cada uno; los cubos se reparten el resto:
 * P_i = N/(N+2) * w_i / sum(w_j).
 */

export type CubeWeightMode = 'prod' | 'last';

export type CubeWeightParams = {
  /** Peso mínimo (cubo que salió en el evento anterior). 0 <= m <= 1. */
  m: number;
  /** Cuántos eventos de "memoria" por cubo de la ruleta: tau = max(tauMin, N / k). k > 0. */
  k: number;
  tauMin: number;
  mode: CubeWeightMode;
};

export const DEFAULT_CUBE_WEIGHT_PARAMS: CubeWeightParams = { m: 0.05, k: 6, tauMin: 0.75, mode: 'prod' };

/** Un valor inválido (null, NaN, fuera de rango) cae al default de ese campo. Acepta la fila cruda de la base. */
export function sanitizeCubeWeightParams(raw: {
  m?: unknown;
  k?: unknown;
  tau_min?: unknown;
  tauMin?: unknown;
  mode?: unknown;
  accumulation_mode?: unknown;
} | null | undefined): CubeWeightParams {
  const d = DEFAULT_CUBE_WEIGHT_PARAMS;
  const num = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const m = num(raw?.m);
  const k = num(raw?.k);
  const tauMin = num(raw?.tau_min ?? raw?.tauMin);
  const mode = raw?.accumulation_mode ?? raw?.mode;
  return {
    m: m != null && m >= 0 && m <= 1 ? m : d.m,
    k: k != null && k > 0 ? k : d.k,
    tauMin: tauMin != null && tauMin > 0 ? tauMin : d.tauMin,
    mode: mode === 'prod' || mode === 'last' ? mode : d.mode,
  };
}

/** Peso de una salida a d eventos de distancia (d >= 1). */
export function cubeExitWeight(d: number, m: number, tau: number): number {
  const x = (d - 1) / tau;
  return 1 - (1 - m) / (1 + x * x);
}

export type CubeRouletteProbabilities = {
  /** Peso de cada cubo de la ruleta (1 = nunca salió / salió hace mucho). */
  weights: Record<string, number>;
  /** Probabilidad de cada cubo (0..1). */
  cubes: Record<string, number>;
  /** "Todos fuman" y "Jugador elige": 1/(N+2) cada uno. */
  fixed: number;
};

/**
 * @param cubeIds     cubos que están hoy en la ruleta (N = cubeIds.length)
 * @param history     cubo registrado de cada evento contado ANTERIOR, del más reciente al más antiguo
 *                    (history[0] es el evento anterior, d = 1); null = ese evento no tiene cubo contable.
 *                    Cubos que ya no están en la ruleta se ignoran, pero ocupan su lugar en el conteo de eventos.
 * @param weighted    false -> uniforme 1/(N+2), sin historial
 */
export function cubeRouletteProbabilities(
  cubeIds: readonly string[],
  history: readonly (string | null)[],
  params: CubeWeightParams = DEFAULT_CUBE_WEIGHT_PARAMS,
  weighted = true
): CubeRouletteProbabilities {
  const n = cubeIds.length;
  const fixed = 1 / (n + 2);
  const weights: Record<string, number> = {};
  const cubes: Record<string, number> = {};
  if (n === 0) return { weights, cubes, fixed };

  const p = sanitizeCubeWeightParams(params);
  const tau = Math.max(p.tauMin, n / p.k);
  for (const id of cubeIds) weights[id] = 1;

  if (weighted) {
    const seen = new Set<string>();
    history.forEach((cubeId, i) => {
      if (cubeId == null || !(cubeId in weights)) return;
      const w = cubeExitWeight(i + 1, p.m, tau);
      if (p.mode === 'last') {
        if (seen.has(cubeId)) return; // history viene del más reciente al más antiguo: la primera salida es la última
        seen.add(cubeId);
        weights[cubeId] = w;
      } else {
        weights[cubeId] *= w;
      }
    });
  }

  let sum = 0;
  for (const id of cubeIds) sum += weights[id];
  for (const id of cubeIds) cubes[id] = ((n / (n + 2)) * weights[id]) / sum;
  return { weights, cubes, fixed };
}

/** Elige un índice según probabilidades (la suma no hace falta que sea exactamente 1). rand en [0,1). */
export function pickWeighted(probs: readonly number[], rand: number): number {
  let total = 0;
  for (const p of probs) total += p;
  let x = rand * total;
  for (let i = 0; i < probs.length; i += 1) {
    x -= probs[i];
    if (x < 0) return i;
  }
  return probs.length - 1;
}

/** 0.1234 -> "12.3%" */
export function formatPercent1(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

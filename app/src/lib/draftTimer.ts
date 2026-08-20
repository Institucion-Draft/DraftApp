export type TimerParams = {
  alpha: number;
  beta: number;
  gamma: number;
  delta: number;
  rho: number;
  tMin: number;
  tMax: number;
};

export const DEFAULT_TIMER_PARAMS: TimerParams = {
  alpha: 0.30,
  beta: 0.70,
  gamma: 0.80,
  delta: 0.60,
  rho: 0.35,
  tMin: 7,
  tMax: 130,
};

export type PickInfo = {
  globalIndex: number;
  packIndex: number;
  pickInPack: number;   // 1-based
  cardsPresent: number; // C(K)
  ii: number;
  timeSeconds: number;
};

export function computePickTimeline(
  packs: number[],
  numPlayers: number,
  params: TimerParams,
): PickInfo[] {
  const { alpha, beta, gamma, delta, rho, tMin, tMax } = params;
  const J = Math.max(numPlayers, 1);
  const S = packs.length;
  const K_total = packs.reduce((a, b) => a + b, 0);
  if (K_total === 0) return [];

  const N_max = Math.max(...packs);
  const sigma = 0.12 * K_total;
  const peakK = 0.40 * K_total;
  const tau = Math.max(0.15 * K_total, 1);
  const norm = Math.sqrt(N_max * K_total);

  const picks: PickInfo[] = [];
  let K = 0;

  for (let s = 0; s < S; s++) {
    const packSize = packs[s]!;
    const packReduction = S > 1 ? 1 - 0.12 * s / (S - 1) : 1;
    for (let k_s = 1; k_s <= packSize; k_s++) {
      const K_acum = K;
      const C = packSize - k_s + 1;
      const vistas = Math.floor((k_s - 1) / J);
      const term1 = alpha * Math.pow(1 - rho, vistas) * C;
      const term2 = norm > 0 ? beta * C * Math.sqrt(K_acum) / norm : 0;
      const term3 = gamma * Math.exp(-Math.pow(K - peakK, 2) / (2 * sigma * sigma));
      const term4 = delta * Math.exp(-K_acum / tau);
      picks.push({
        globalIndex: K,
        packIndex: s,
        pickInPack: k_s,
        cardsPresent: C,
        ii: (term1 + term2 + term3 + term4) * packReduction,
        timeSeconds: 0,
      });
      K++;
    }
  }

  const decisional = picks.filter((p) => p.cardsPresent > 1);
  const II_min = decisional.length > 0 ? Math.min(...decisional.map((p) => p.ii)) : 0;
  const II_max = picks.length > 0 ? Math.max(...picks.map((p) => p.ii)) : 0;
  const II_range = II_max - II_min;

  for (const pick of picks) {
    if (pick.cardsPresent <= 1) {
      pick.timeSeconds = Math.round(tMin * 0.5);
    } else if (II_range === 0) {
      pick.timeSeconds = tMin;
    } else {
      pick.timeSeconds = Math.round(tMin + (tMax - tMin) * (pick.ii - II_min) / II_range);
    }
  }

  return picks;
}

export function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

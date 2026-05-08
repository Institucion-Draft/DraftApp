import type { MtgColor } from './database.types';

/** Colores de mana para ProDeC (sin incoloro). */
export const PRODEC_BAR_ORDER: MtgColor[] = ['W', 'U', 'B', 'R', 'G'];

export function emptyColorCounts(): Record<MtgColor, number> {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
}

/** Cuenta apariciones declaradas; ignora C (incoloro) para estadísticas ProDeC. */
export function countDeclaredColors(rows: { color: MtgColor }[]): Record<MtgColor, number> {
  const c = emptyColorCounts();
  for (const r of rows) {
    if (r.color === 'C') continue;
    c[r.color] += 1;
  }
  return c;
}

export type FrequencyTier = {
  frequency: number;
  colors: MtgColor[];
};

/** Niveles de frecuencia (solo WUBRG). */
export function buildFrequencyTiers(counts: Record<MtgColor, number>): FrequencyTier[] {
  const byFreq = new Map<number, MtgColor[]>();
  for (const col of PRODEC_BAR_ORDER) {
    const f = counts[col];
    if (!byFreq.has(f)) byFreq.set(f, []);
    byFreq.get(f)!.push(col);
  }
  const freqs = [...byFreq.keys()].sort((a, b) => b - a);
  return freqs.map((frequency) => ({
    frequency,
    colors: (byFreq.get(frequency) ?? []).sort(
      (a, b) => PRODEC_BAR_ORDER.indexOf(a) - PRODEC_BAR_ORDER.indexOf(b)
    ),
  }));
}

export type ProDeCVoter = {
  userId: string;
  participantId: string;
  predictedColor: MtgColor;
};

export function colorToTierIndex(tiers: FrequencyTier[], color: MtgColor): number {
  if (color === 'C') return -1;
  for (let i = 0; i < tiers.length; i += 1) {
    if (tiers[i].colors.includes(color)) return i;
  }
  return -1;
}

export function groupVotersByTier(
  tiers: FrequencyTier[],
  predictions: { user_id: string; predicted_color: string }[],
  userToParticipant: Map<string, string>
): Map<number, ProDeCVoter[]> {
  const map = new Map<number, ProDeCVoter[]>();
  for (let i = 0; i < tiers.length; i += 1) map.set(i, []);

  for (const p of predictions) {
    const col = p.predicted_color as MtgColor;
    const pid = userToParticipant.get(p.user_id);
    if (!pid) continue;
    const ti = colorToTierIndex(tiers, col);
    if (ti < 0) continue;
    map.get(ti)!.push({ userId: p.user_id, participantId: pid, predictedColor: col });
  }
  return map;
}

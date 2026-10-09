/**
 * Instancia alcanzada por un jugador en las copas de un evento (Copa sola y Grupos + Copa), a partir de los
 * cruces (knockout_slots) de la Copa principal (group_origin 'knockout_bracket') y de Consuelo
 * ('knockout_second_chance'). Módulo puro, sin React ni Supabase.
 *
 * La ronda más lejana es la última en la que el jugador aparece como participante de un slot; un bye cuenta como
 * haber alcanzado esa ronda. El perdedor de una semifinal aparece en el slot del 3er puesto (así lo arma el motor):
 * queda 3º o 4º según ese partido y, si está pendiente, "Semifinalista".
 */
import type { BracketPhase } from './knockoutRounds';

// Orígenes de los grupos (knockoutRounds.ts los exporta; acá van literales para que el módulo sea importable sin resolver otros).
const KNOCKOUT_BRACKET_ORIGIN = 'knockout_bracket';
const KNOCKOUT_SECOND_CHANCE_ORIGIN = 'knockout_second_chance';

export type CupSlotInput = {
  round_key: BracketPhase;
  participant_a_id: string | null;
  participant_b_id: string | null;
  is_bye: boolean;
  winner_participant_id: string | null;
};

export type CupGroupInput = {
  /** 'knockout_bracket' (Copa principal) o 'knockout_second_chance' (Consuelo). */
  origin: string;
  slots: readonly CupSlotInput[];
};

export type CupOutcome =
  | 'champion'
  | 'runner_up'
  | 'third'
  | 'fourth'
  | 'finalist'
  | 'semifinalist'
  | 'eliminated'
  | 'in_round';

export type CupReached =
  | { cup: 'main' | 'second'; round: BracketPhase; outcome: CupOutcome }
  | { cup: null; round: null; outcome: 'groups' };

const ROUND_ORDER: Record<BracketPhase, number> = {
  round_of_16: 0,
  quarter: 1,
  semi: 2,
  final: 3,
  third_place: 3,
};

function reachedInGroup(
  participantId: string,
  group: CupGroupInput
): { round: BracketPhase; outcome: CupOutcome } | null {
  const mine = group.slots.filter((s) => s.participant_a_id === participantId || s.participant_b_id === participantId);
  if (mine.length === 0) return null;

  const fin = mine.find((s) => s.round_key === 'final');
  if (fin) {
    if (fin.winner_participant_id === participantId) return { round: 'final', outcome: 'champion' };
    if (fin.winner_participant_id != null) return { round: 'final', outcome: 'runner_up' };
    return { round: 'final', outcome: 'finalist' };
  }
  const third = mine.find((s) => s.round_key === 'third_place');
  if (third) {
    if (third.winner_participant_id === participantId) return { round: 'third_place', outcome: 'third' };
    if (third.winner_participant_id != null) return { round: 'third_place', outcome: 'fourth' };
    return { round: 'semi', outcome: 'semifinalist' };
  }
  const farthest = mine.reduce((a, b) => (ROUND_ORDER[b.round_key] > ROUND_ORDER[a.round_key] ? b : a));
  if (farthest.round_key === 'semi') return { round: 'semi', outcome: 'semifinalist' };
  if (farthest.winner_participant_id != null && farthest.winner_participant_id !== participantId) {
    return { round: farthest.round_key, outcome: 'eliminated' };
  }
  return { round: farthest.round_key, outcome: 'in_round' };
}

/**
 * Copa principal primero, después Consuelo. Sin copa: "Fase de grupos" en Grupos + Copa (isZones) y null en Copa sola
 * (el llamador conserva su texto de siempre).
 */
export function cupReachedInstance(input: {
  participantId: string;
  groups: readonly CupGroupInput[];
  isZones: boolean;
}): CupReached | null {
  const { participantId, groups, isZones } = input;
  const order: [string, 'main' | 'second'][] = [
    [KNOCKOUT_BRACKET_ORIGIN, 'main'],
    [KNOCKOUT_SECOND_CHANCE_ORIGIN, 'second'],
  ];
  for (const [origin, cup] of order) {
    const g = groups.find((x) => x.origin === origin);
    if (!g) continue;
    const r = reachedInGroup(participantId, g);
    if (r) return { cup, round: r.round, outcome: r.outcome };
  }
  return isZones ? { cup: null, round: null, outcome: 'groups' } : null;
}

const ROUND_IN_TEXT: Partial<Record<BracketPhase, string>> = { quarter: 'cuartos', round_of_16: 'octavos' };

/** Texto visible: "Campeón Copa Quito", "Eliminado en cuartos de Copa Consuelo", "Fase de grupos"... */
export function cupReachedText(
  r: CupReached,
  opts: {
    /** cupPrimaName(sede) y CUP_CONSUELO_NAME (knockoutRounds.ts). */
    mainName: string;
    consueloName: string;
    /** resolveGenderedText con el género del jugador (genderText.ts): (masculino, femenino) -> texto. */
    gendered: (masculine: string, feminine: string) => string;
  }
): string {
  if (r.cup == null) return 'Fase de grupos';
  const name = r.cup === 'main' ? opts.mainName : opts.consueloName;
  const g = opts.gendered;
  const round = ROUND_IN_TEXT[r.round] ?? 'semifinales';
  switch (r.outcome) {
    case 'champion':
      return `${g('Campeón', 'Campeona')} ${name}`;
    case 'runner_up':
      return `${g('Subcampeón', 'Subcampeona')} ${name}`;
    case 'third':
      return `3er puesto ${name}`;
    case 'fourth':
      return `4to puesto ${name}`;
    case 'finalist':
      return `Finalista ${name}`;
    case 'semifinalist':
      return `Semifinalista ${name}`;
    case 'eliminated':
      return `${g('Eliminado', 'Eliminada')} en ${round} de ${name}`;
    case 'in_round':
      return `En ${round} de ${name}`;
    default:
      return name;
  }
}

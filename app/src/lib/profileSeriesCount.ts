/**
 * Contador de "Enfrentamientos ganados / completados" del perfil en el evento.
 *
 * Enfrentamiento = una serie completa entre dos jugadores en una fase: un pairing de grupos/interzonal
 * (resultado en official_* del pairing, según match_format) o un cruce de llaves (ganador en
 * event_tiebreak_bracket_matches, según topcut_format). Las partidas sueltas no cuentan, las venganzas nunca,
 * y un bye de la Copa tampoco (no es un cruce entre dos jugadores).
 *
 * Quién gana cada serie ya viene resuelto de la base (BO1: la partida; BO2: 2-0 gana, 1-1 es empate; BO3: quien
 * llega a 2; walkover por abandono: gana el que se queda). Acá sólo se cuenta, sin duplicar entre fases.
 */

export type ProfileGroupPairing = {
  participant_a_id: string;
  participant_b_id: string;
  official_winner_participant_id: string | null;
  official_draw?: boolean | null;
  stage?: string | null;
};

export type ProfileBracketMatch = {
  participant_a_id: string | null;
  participant_b_id: string | null;
  winner_participant_id: string | null;
};

export type SeriesCount = { completed: number; won: number };

/** Fase de grupos (zona e interzonal) en Grupos + Copa; en el resto de los formatos, todo pairing con resultado oficial. */
export function countGroupSeries(
  participantId: string,
  pairings: ProfileGroupPairing[],
  onlyGroupStages: boolean
): SeriesCount {
  let completed = 0;
  let won = 0;
  for (const p of pairings) {
    if (p.participant_a_id !== participantId && p.participant_b_id !== participantId) continue;
    // Venganzas y pairings de llaves ('bracket') nunca son un enfrentamiento de grupos.
    if (onlyGroupStages && p.stage !== 'zone' && p.stage !== 'interzonal') continue;
    if (p.stage === 'revenge') continue;
    if (p.official_winner_participant_id != null) {
      completed += 1;
      if (p.official_winner_participant_id === participantId) won += 1;
    } else if (p.official_draw === true) {
      completed += 1; // BO2 1-1: completado, no ganado
    }
  }
  return { completed, won };
}

/** Cruces resueltos de Copa y Consuelo en los que juega el participante. Sin dos jugadores reales (bye) no cuenta. */
export function countCupSeries(participantId: string, bracketMatches: ProfileBracketMatch[]): SeriesCount {
  let completed = 0;
  let won = 0;
  for (const bm of bracketMatches) {
    if (bm.participant_a_id == null || bm.participant_b_id == null) continue;
    if (bm.participant_a_id !== participantId && bm.participant_b_id !== participantId) continue;
    if (bm.winner_participant_id == null) continue;
    completed += 1;
    if (bm.winner_participant_id === participantId) won += 1;
  }
  return { completed, won };
}

/** Total del perfil: Grupos + Copa suma grupos y llaves; Copa sola sólo llaves; el resto, sólo pairings. */
export function countProfileSeries(args: {
  participantId: string;
  competitionFormat: string;
  pairings: ProfileGroupPairing[];
  bracketMatches: ProfileBracketMatch[];
}): SeriesCount {
  const { participantId, competitionFormat, pairings, bracketMatches } = args;
  if (competitionFormat === 'knockout') return countCupSeries(participantId, bracketMatches);
  const g = countGroupSeries(participantId, pairings, competitionFormat === 'zones_knockout');
  if (competitionFormat !== 'zones_knockout') return g;
  const c = countCupSeries(participantId, bracketMatches);
  return { completed: g.completed + c.completed, won: g.won + c.won };
}

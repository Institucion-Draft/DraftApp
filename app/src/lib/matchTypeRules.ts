/**
 * Qué match_type recibe una partida nueva en un pairing. Única fuente para PairingDetailScreen
 * (botón "Iniciar") y MatchResultScreen (botón de revancha).
 *
 * Los pairings de la Copa (pairings.stage = 'bracket', 0129/0130) sólo existen para sus cruces de
 * llaves y nunca tienen resultado oficial ('draft'): mientras la serie está abierta las partidas
 * son 'tiebreak'; fuera de la serie (cruce ya resuelto) cualquier partida nueva es una venganza.
 * En el resto de los formatos stage es null y las reglas son las de siempre.
 */
import type { CompetitionFormat } from './eventMode';

export type NewMatchType = 'draft' | 'revenge' | 'tiebreak';

/** Pairing de un cruce de llaves de la Copa. */
export function isKnockoutBracketPairing(stage: string | null | undefined): boolean {
  return stage === 'bracket';
}

/**
 * Pairing creado sólo para jugar venganzas en la Copa (ensure_revenge_pairing, 0134): nunca tiene serie de
 * llaves ni resultado oficial. Si más adelante el cuadro cruza a esos dos, el servidor lo pasa a 'bracket'.
 */
export function isKnockoutRevengePairing(stage: string | null | undefined): boolean {
  return stage === 'revenge';
}

export type NextMatchTypeInput = {
  /** Hay una serie de llaves / desempate abierta en este pairing. */
  isTiebreakPending: boolean;
  isBracketGroup: boolean;
  tiebreakWinnerParticipantId: string | null;
  competitionFormat: CompetitionFormat;
  swissRound: number | null;
  currentSwissRound: number | null;
  /** Resultado oficial cerrado (ganador, empate BO2 o BO1 resuelto). */
  officialResolved: boolean;
  pairingStage: string | null;
};

/** Tipo de la partida que crea "Iniciar" en PairingDetailScreen. */
export function resolveNextMatchType(i: NextMatchTypeInput): NewMatchType {
  // Un pairing de sólo venganza nunca arranca otra cosa que una venganza.
  if (isKnockoutRevengePairing(i.pairingStage)) return 'revenge';
  if (i.isTiebreakPending && (i.isBracketGroup || i.tiebreakWinnerParticipantId == null)) {
    return 'tiebreak';
  }
  // Copa: este pairing no tiene partida oficial; todo lo que no sea la serie de llaves es venganza.
  if (isKnockoutBracketPairing(i.pairingStage)) return 'revenge';
  if (
    i.competitionFormat === 'swiss' &&
    (i.swissRound == null || i.currentSwissRound == null || i.swissRound !== i.currentSwissRound)
  ) {
    return 'revenge';
  }
  if (
    !i.officialResolved &&
    (i.competitionFormat !== 'swiss' ||
      (i.swissRound != null && i.currentSwissRound != null && i.swissRound === i.currentSwissRound))
  ) {
    return 'draft';
  }
  return 'revenge';
}

export type RematchTypeInput = {
  /** match_type de la partida que acaba de terminar. */
  currentMatchType: string;
  competitionFormat: CompetitionFormat;
  swissRound: number | null;
  currentSwissRound: number | null;
  /** pairing.official_winner_participant_id definido, o BO1 ya resuelto por una partida. */
  officialDecided: boolean;
  pairingStage: string | null;
};

/** Tipo de la partida que crea el botón de revancha en MatchResultScreen. */
export function resolveRematchType(i: RematchTypeInput): NewMatchType | 'two_headed_giant' {
  if (isKnockoutRevengePairing(i.pairingStage)) return 'revenge';
  if (i.currentMatchType === 'tiebreak') return 'tiebreak';
  if (isKnockoutBracketPairing(i.pairingStage)) return 'revenge';
  if (
    i.competitionFormat === 'swiss' &&
    (i.swissRound == null || i.currentSwissRound == null || i.swissRound !== i.currentSwissRound)
  ) {
    return 'revenge';
  }
  if (i.officialDecided) return 'revenge';
  if (i.currentMatchType === 'two_headed_giant') return 'two_headed_giant';
  return 'draft';
}

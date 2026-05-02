import { supabase } from './supabase';

export type ConcurrentPairDetails = {
  participantAInOtherMatchId: string | null;
  participantBInOtherMatchId: string | null;
};

/**
 * Para cada participant A/B del pairing, detecta si tiene un match `in_progress`
 * en otro pairing del mismo evento (excluye excludePairingId).
 * Revisa todos los matches in_progress relevantes, no solo el primero.
 */
export async function findConcurrentInProgressDetailsForPairParticipants(params: {
  eventId: string;
  excludePairingId: string;
  participantAId: string;
  participantBId: string;
}): Promise<ConcurrentPairDetails> {
  const { eventId, excludePairingId, participantAId: pa, participantBId: pb } = params;

  const { data: pairings, error: pErr } = await supabase
    .from('pairings')
    .select('id, participant_a_id, participant_b_id')
    .eq('event_id', eventId)
    .neq('id', excludePairingId)
    .or(`participant_a_id.eq.${pa},participant_a_id.eq.${pb},participant_b_id.eq.${pa},participant_b_id.eq.${pb}`);

  if (pErr || !pairings?.length) {
    return { participantAInOtherMatchId: null, participantBInOtherMatchId: null };
  }

  const pairingIds = pairings.map((p) => p.id as string);
  const { data: matches, error: mErr } = await supabase
    .from('matches')
    .select('id, pairing_id')
    .in('pairing_id', pairingIds)
    .eq('status', 'in_progress');

  if (mErr || !matches?.length) {
    return { participantAInOtherMatchId: null, participantBInOtherMatchId: null };
  }

  let participantAInOtherMatchId: string | null = null;
  let participantBInOtherMatchId: string | null = null;

  for (const m of matches) {
    const mid = m.id as string;
    const pr = pairings.find((p) => p.id === m.pairing_id);
    if (!pr) continue;
    const ids = [pr.participant_a_id as string, pr.participant_b_id as string];
    if (ids.includes(pa) && participantAInOtherMatchId == null) participantAInOtherMatchId = mid;
    if (ids.includes(pb) && participantBInOtherMatchId == null) participantBInOtherMatchId = mid;
  }

  return { participantAInOtherMatchId, participantBInOtherMatchId };
}

/** Mensaje de bloqueo por partida simultánea; `null` si no hay conflicto. */
export function formatConcurrentMatchBlockMessage(args: {
  nameA: string;
  nameB: string;
  participantAId: string;
  participantBId: string;
  userIdA: string;
  userIdB: string;
  myUserId: string | null;
  isWorkspaceOrganizer: boolean;
  aInOtherMatchId: string | null;
  bInOtherMatchId: string | null;
}): string | null {
  const {
    nameA,
    nameB,
    userIdA,
    userIdB,
    myUserId,
    isWorkspaceOrganizer,
    aInOtherMatchId,
    bInOtherMatchId,
  } = args;

  const busyA = aInOtherMatchId != null;
  const busyB = bInOtherMatchId != null;
  if (!busyA && !busyB) return null;

  const sameMatch = busyA && busyB && aInOtherMatchId === bInOtherMatchId;
  const imA = myUserId != null && myUserId === userIdA;
  const imB = myUserId != null && myUserId === userIdB;
  const imParticipant = imA || imB;
  const organizerSpectator = isWorkspaceOrganizer && !imParticipant;

  if (organizerSpectator) {
    if (busyA && !busyB) return `${nameA} ya está en una partida`;
    if (!busyA && busyB) return `${nameB} ya está en una partida`;
    if (busyA && busyB) {
      if (sameMatch) return `${nameA} y ${nameB} ya están en una partida`;
      return `${nameA} y ${nameB} ya están en partidas`;
    }
  }

  if (imParticipant) {
    if (imA) {
      if (busyA) return 'Ya estás en una partida';
      if (busyB) return `${nameB} ya está en una partida`;
    } else if (imB) {
      if (busyB) return 'Ya estás en una partida';
      if (busyA) return `${nameA} ya está en una partida`;
    }
  }

  if (busyA && !busyB) return `${nameA} ya está en una partida`;
  if (!busyA && busyB) return `${nameB} ya está en una partida`;
  if (busyA && busyB) {
    if (sameMatch) return `${nameA} y ${nameB} ya están en una partida`;
    return `${nameA} y ${nameB} ya están en partidas`;
  }
  return null;
}

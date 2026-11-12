/**
 * Recompensa del desbloqueo especial (migración 0157): event_participants.special_reward vale 'shiny' (ganador de la partida 420),
 * 'ditto' (perdedor) o null. Cuando no es nulo, la base ya asignó el Pokémon de esa inscripción (rotated_avatar_id, con is_shiny
 * si corresponde) y ese Pokémon se muestra POR ENCIMA del avatar custom del usuario, sólo en ese evento.
 */

export type SpecialReward = 'shiny' | 'ditto';

export function isSpecialReward(value: unknown): value is SpecialReward {
  return value === 'shiny' || value === 'ditto';
}

/**
 * ¿El Pokémon de la inscripción tiene que pisar al avatar custom?
 * Sólo si la inscripción cobró una recompensa Y hay un sprite para mostrar (sin sprite se queda el custom, mejor que nada).
 * El miembro B de un 2HG nunca cobra recompensa (los eventos 2HG no la consumen), así que no se pisa.
 */
export function rewardOverridesCustom(input: {
  specialReward: unknown;
  hasSprite: boolean;
  isMemberB?: boolean;
}): boolean {
  if (input.isMemberB) return false;
  return isSpecialReward(input.specialReward) && input.hasSprite;
}

/**
 * Para el espejo del Ditto: un usuario con avatar custom se ve con su custom, salvo que su inscripción haya cobrado la recompensa
 * (entonces se ve como su Pokémon y cuenta como "sin custom").
 */
export function effectiveHasCustomAvatar(hasCustomAvatar: boolean, specialReward: unknown): boolean {
  return hasCustomAvatar && !isSpecialReward(specialReward);
}

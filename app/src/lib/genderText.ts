export type Gender = 'male' | 'female' | 'other' | 'prefer_not_to_say';

/**
 * Resuelve un texto con variante de género según el género del user.
 * - female → versión femenina
 * - male, other, prefer_not_to_say → versión masculina (default)
 *
 * Uso: resolveGenderedText(user.gender, 'campeón', 'campeona')
 */
export function resolveGenderedText(
  gender: Gender | null | undefined,
  masculine: string,
  feminine: string
): string {
  if (gender === 'female') return feminine;
  return masculine;
}

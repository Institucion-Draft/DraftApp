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

/** Formas [masculino, femenino] de las palabras que cambian según el género de UN jugador (singular). */
export const GENDERED_FORMS = {
  left: ['ido', 'ida'],
  champion: ['campeón', 'campeona'],
  registered: ['inscripto', 'inscripta'],
  organizer: ['organizador', 'organizadora'],
  eliminated: ['eliminado', 'eliminada'],
} as const;

export type GenderedKey = keyof typeof GENDERED_FORMS;

/**
 * Devuelve la forma correcta de una palabra del diccionario: female → femenino; el resto (incl. null) → masculino.
 * `capitalize: true` pone la primera letra en mayúscula ('Campeona').
 *
 * Uso: genderedWord(profileGender, 'left') → 'ido' | 'ida'
 */
export function genderedWord(
  gender: Gender | null | undefined,
  key: GenderedKey,
  opts?: { capitalize?: boolean }
): string {
  const [masculine, feminine] = GENDERED_FORMS[key];
  const word = resolveGenderedText(gender, masculine, feminine);
  return opts?.capitalize ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

type SideLeft = { left: boolean; gender?: Gender | null };

/**
 * "ido/ida" para un cruce de dos lados: si se fue SOLO uno, su forma según su género; si se fueron los dos
 * (o ninguno) queda masculino.
 */
export function leftWordForPair(a: SideLeft, b: SideLeft): string {
  if (a.left && !b.left) return genderedWord(a.gender, 'left');
  if (b.left && !a.left) return genderedWord(b.gender, 'left');
  return genderedWord(null, 'left');
}

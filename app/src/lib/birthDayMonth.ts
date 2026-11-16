/**
 * Día y mes de nacimiento para el registro. Lógica pura.
 *
 * Solo importan el día y el mes; el año no se pide. Se manda a la base una fecha con un año de relleno FIJO, 2000, que es bisiesto: así el
 * 29 de febrero es una fecha válida (handle_new_user castea metadata->>'birth_date' a date y deja null si no es válida).
 */

export const BIRTH_FILL_YEAR = 2000;

export const MONTH_NAMES = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
] as const;

const DAYS_IN_MONTH_LEAP = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Días del mes (1-12) con año bisiesto (2000): febrero llega a 29. Mes inválido: 0. */
export function daysInBirthMonth(month: number | null | undefined): number {
  if (month == null || !Number.isInteger(month) || month < 1 || month > 12) return 0;
  return DAYS_IN_MONTH_LEAP[month - 1];
}

/** [1, 2, ..., N] con N = días del mes; sin mes elegido, 31 (se puede elegir el día antes que el mes). */
export function dayOptions(month: number | null | undefined): number[] {
  const n = month == null ? 31 : daysInBirthMonth(month);
  return Array.from({ length: n }, (_, i) => i + 1);
}

/** ¿El día existe en ese mes? */
export function isValidDayMonth(day: number | null | undefined, month: number | null | undefined): boolean {
  if (day == null || month == null || !Number.isInteger(day)) return false;
  return day >= 1 && day <= daysInBirthMonth(month);
}

/** Al cambiar de mes: el día elegido se conserva si existe en el nuevo mes; si no (31 en abril, 30 en febrero...) se descarta y hay que elegirlo de nuevo. */
export function dayAfterMonthChange(day: number | null, newMonth: number): number | null {
  return day != null && isValidDayMonth(day, newMonth) ? day : null;
}

export const BIRTH_MISSING_DAY = 'Falta el día';
export const BIRTH_MISSING_MONTH = 'Falta el mes';

/**
 * Estado del cumpleaños OPCIONAL del registro: 'empty' (los dos vacíos: se puede crear la cuenta sin cumpleaños), 'complete' (día y mes
 * válidos: se manda 2000-MM-DD) o 'missing_day' / 'missing_month' (solo uno de los dos: no se puede crear hasta completar o vaciar).
 */
export type BirthInputState =
  | { status: 'empty' }
  | { status: 'complete'; value: string }
  | { status: 'missing_day' }
  | { status: 'missing_month' };

export function birthDateInputState(day: number | null | undefined, month: number | null | undefined): BirthInputState {
  const hasDay = day != null;
  const hasMonth = month != null;
  if (!hasDay && !hasMonth) return { status: 'empty' };
  if (hasDay && !hasMonth) return { status: 'missing_month' };
  const value = buildBirthDateString(day, month);
  return value ? { status: 'complete', value } : { status: 'missing_day' };
}

/** ¿Se puede crear la cuenta con este cumpleaños? Sí si está vacío o completo. */
export function canSubmitBirth(state: BirthInputState): boolean {
  return state.status === 'empty' || state.status === 'complete';
}

/** El valor a mandar a la base: '2000-MM-DD' si está completo; null si está vacío (o incompleto, que no se puede enviar). */
export function birthDateValue(state: BirthInputState): string | null {
  return state.status === 'complete' ? state.value : null;
}

/** Aviso mínimo en línea para un cumpleaños a medias; null si no hay nada que avisar. */
export function birthDateWarning(state: BirthInputState): string | null {
  if (state.status === 'missing_day') return BIRTH_MISSING_DAY;
  if (state.status === 'missing_month') return BIRTH_MISSING_MONTH;
  return null;
}

/** '2000-MM-DD' o null si falta alguno de los dos o el día no existe en el mes. */
export function buildBirthDateString(day: number | null | undefined, month: number | null | undefined): string | null {
  if (!isValidDayMonth(day, month)) return null;
  return `${BIRTH_FILL_YEAR}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Cumpleaños de los jugadores (users.birthday, migración 0145): lógica pura, sin acceso a datos.
 * Mismas reglas que public.is_birthday en la base: coinciden día y mes, y un 29/2 se festeja el 28/2 en los años no bisiestos.
 */

export const BIRTHDAY_EMOJI = '🎂';

/** Argentina no tiene horario de verano (desde 2009): America/Argentina/Buenos_Aires es UTC-3 todo el año. */
const BUENOS_AIRES_OFFSET_MS = -3 * 60 * 60 * 1000;

/** Día calendario de hoy en America/Argentina/Buenos_Aires (no el del dispositivo ni el de UTC). */
export function buenosAiresToday(now: Date = new Date()): { year: number; month: number; day: number } {
  const d = new Date(now.getTime() + BUENOS_AIRES_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** ¿Hoy (en Buenos Aires) es el cumpleaños de `birthday` ('YYYY-MM-DD')? Sin fecha o con una fecha inválida, false. */
export function isBirthdayToday(birthday: string | null | undefined, now: Date = new Date()): boolean {
  if (!birthday) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthday);
  if (!m) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const today = buenosAiresToday(now);
  if (month === 2 && day === 29 && !isLeapYear(today.year)) return today.month === 2 && today.day === 28;
  return today.month === month && today.day === day;
}

/** El nombre con 🎂 al lado si hoy es el cumpleaños del jugador; si no, el nombre tal cual. */
export function nameWithCake(name: string, birthday: string | null | undefined, now: Date = new Date()): string {
  return isBirthdayToday(birthday, now) ? `${name} ${BIRTHDAY_EMOJI}` : name;
}

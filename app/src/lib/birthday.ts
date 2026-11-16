/**
 * Cumpleaños de hoy (🎂). Lógica pura, sin red ni React.
 *
 * El cliente NUNCA lee la fecha de nacimiento de nadie: la base (migración 0161) expone public.birthday_user_ids_today(), que devuelve
 * SOLO los ids de los usuarios visibles que cumplen años hoy en America/Argentina/Buenos_Aires. Acá se arma un conjunto de ids con eso, con
 * caché por día (la fecha de Buenos Aires, no la del teléfono ni UTC), y nameWithCake() consulta ese conjunto.
 */

export const BIRTHDAY_EMOJI = '🎂';

/** Los ids de los usuarios que cumplen años hoy (visibles para quien llama). */
export type BirthdayIdSet = ReadonlySet<string>;
export const EMPTY_BIRTHDAY_SET: BirthdayIdSet = new Set<string>();

/** Argentina no tiene horario de verano (desde 2009): America/Argentina/Buenos_Aires es UTC-3 todo el año. */
const BUENOS_AIRES_OFFSET_MS = -3 * 60 * 60 * 1000;

/** Día calendario de hoy en America/Argentina/Buenos_Aires (no el del dispositivo ni el de UTC). */
export function buenosAiresToday(now: Date = new Date()): { year: number; month: number; day: number } {
  const d = new Date(now.getTime() + BUENOS_AIRES_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 'YYYY-MM-DD' del día de hoy en Buenos Aires: la clave de la caché. */
export function buenosAiresDayKey(now: Date = new Date()): string {
  const t = buenosAiresToday(now);
  return `${String(t.year).padStart(4, '0')}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
}

/** ¿Hoy es el cumpleaños de este usuario? (solo si su id está en el conjunto que devolvió la base). */
export function isBirthdayUser(userId: string | null | undefined, ids: BirthdayIdSet): boolean {
  return !!userId && ids.has(userId);
}

/** El nombre con 🎂 al lado si hoy es el cumpleaños del usuario; si no, el nombre tal cual. */
export function nameWithCake(name: string, userId: string | null | undefined, ids: BirthdayIdSet): string {
  return isBirthdayUser(userId, ids) ? `${name} ${BIRTHDAY_EMOJI}` : name;
}

/**
 * Normaliza lo que devuelve supabase.rpc('birthday_user_ids_today') (un \`setof uuid\`: arreglo de strings; por las dudas también acepta
 * filas { birthday_user_ids_today: id } o { id }). Cualquier otra cosa: null (sin datos fiables).
 */
export function parseBirthdayUserIds(data: unknown): string[] | null {
  if (!Array.isArray(data)) return null;
  const out: string[] = [];
  for (const row of data) {
    if (typeof row === 'string') {
      if (row) out.push(row);
    } else if (row && typeof row === 'object') {
      const r = row as Record<string, unknown>;
      const v = r.birthday_user_ids_today ?? r.id;
      if (typeof v === 'string' && v) out.push(v);
    }
  }
  return out;
}

/**
 * Caché de los ids de cumpleaños. Una entrada vale mientras sea el MISMO día de Buenos Aires y el MISMO usuario (cada usuario ve a
 * personas distintas). Una sola llamada en vuelo a la vez. Si la llamada falla (fetchIds devuelve null o lanza) NO se cachea nada y se
 * devuelve el conjunto vacío: la app no se rompe, solo no muestra tortas (y la próxima consulta reintenta). Un conjunto de otro día nunca
 * se devuelve como si fuera de hoy.
 */
export function createBirthdayIdsLoader(fetchIds: () => Promise<string[] | null>, now: () => Date = () => new Date()) {
  let entry: { dayKey: string; userKey: string; ids: BirthdayIdSet } | null = null;
  let inflight: { dayKey: string; userKey: string; promise: Promise<BirthdayIdSet>; token: object } | null = null;

  /** Lo que ya está en caché para hoy y este usuario, sin pedir nada (vacío si no hay). */
  function peek(userKey: string | null): BirthdayIdSet {
    if (userKey && entry && entry.userKey === userKey && entry.dayKey === buenosAiresDayKey(now())) return entry.ids;
    return EMPTY_BIRTHDAY_SET;
  }

  function load(userKey: string): Promise<BirthdayIdSet> {
    const dayKey = buenosAiresDayKey(now());
    if (entry && entry.userKey === userKey && entry.dayKey === dayKey) return Promise.resolve(entry.ids);
    if (inflight && inflight.userKey === userKey && inflight.dayKey === dayKey) return inflight.promise;
    const token = {};
    const promise = (async (): Promise<BirthdayIdSet> => {
      try {
        const ids = await fetchIds();
        if (ids == null) return EMPTY_BIRTHDAY_SET;
        const set: BirthdayIdSet = new Set(ids);
        entry = { dayKey, userKey, ids: set };
        return set;
      } catch {
        return EMPTY_BIRTHDAY_SET;
      } finally {
        if (inflight && inflight.token === token) inflight = null;
      }
    })();
    inflight = { dayKey, userKey, promise, token };
    return promise;
  }

  function clear(): void {
    entry = null;
    inflight = null;
  }

  return { load, peek, clear };
}

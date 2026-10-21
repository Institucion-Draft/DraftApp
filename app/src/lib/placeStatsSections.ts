import type { CubeStats, VenueStats } from './placeStats';

export type PlaceStatsRow = {
  userId: string;
  name: string;
  /** 1-3: lleva medalla; sin posición va un trofeo (ej. "más puntos"). */
  position?: number;
  /** Texto a la derecha (ej. "12 pts"). */
  trailing?: string;
  /**
   * Con participantId se ve el Pokémon que el jugador tuvo en ESE evento (podio del primer evento). Sin él se ve el
   * Pokémon personal de la cuenta (users.default_avatar_id); la foto custom gana en ambos casos.
   */
  participantId?: string | null;
};

export type PlaceStatsSection = {
  title: string;
  /** Línea chica debajo del título. */
  subtitle?: string | null;
  rows: PlaceStatsRow[];
};

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Secciones de la tarjeta de un cubo. Sin eventos oficiales no hay secciones (la tarjeta no se muestra); una sección
 * sin filas tampoco se muestra.
 */
export function cubeSections(stats: CubeStats | null): PlaceStatsSection[] {
  if (!stats || stats.eventsCount === 0) return [];
  const out: PlaceStatsSection[] = [];
  const ev = stats.firstEvent;
  if (stats.firstPodium.length > 0) {
    out.push({
      title: 'Podio del primer evento de este cubo',
      subtitle: ev ? [ev.name, formatDate(ev.scheduled_for)].filter(Boolean).join(' · ') : null,
      rows: stats.firstPodium.map((p) => ({ userId: p.userId, name: p.name, position: p.position, participantId: p.participantId })),
    });
  }
  if (stats.topPlayer) {
    out.push({
      title: 'Más puntos con este cubo',
      rows: [{ userId: stats.topPlayer.userId, name: stats.topPlayer.name, trailing: `${stats.topPlayer.points} pts` }],
    });
  }
  return out;
}

/** Secciones de la tarjeta de una sede: el podio por puntos acumulados (Pokémon personal de la cuenta). */
export function venueSections(stats: VenueStats | null): PlaceStatsSection[] {
  if (!stats || stats.eventsCount === 0 || stats.podium.length === 0) return [];
  return [
    {
      title: 'Podio de la sede',
      subtitle: 'Más puntos acumulados en eventos de esta sede',
      rows: stats.podium.map((p, i) => ({ userId: p.userId, name: p.name, position: i + 1, trailing: `${p.points} pts` })),
    },
  ];
}

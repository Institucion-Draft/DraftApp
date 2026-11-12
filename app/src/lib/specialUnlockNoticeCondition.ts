/**
 * Aviso del desbloqueo especial por la partida 420 de la temporada: cuándo corresponde mostrarlo y en qué orden respecto de los
 * otros carteles del workspace. Lógica pura (sin acceso a datos ni a React Native).
 *
 * La base (migración 0157) decide el ganador y el perdedor; el cliente sólo muestra el cartel una vez por usuario:
 *   - get_my_special_unlock_notice() devuelve a lo sumo UNA fila { role, season_id, workspace_id, match_id } (el aviso sin ver
 *     más antiguo del usuario) o ninguna;
 *   - ack_special_unlock_notice() marca ese aviso como visto.
 * Como el de la Gen 3, es por usuario (no por workspace) y en esta sesión de la app no se repite aunque falle el "visto".
 */
import type { SpecialUnlockNoticeRow } from './database.types';

// Ganador: el título (en negrita) son dos líneas con el mismo estilo; el mensaje va aparte, en texto normal y separado por
// SPECIAL_UNLOCK_MESSAGE_GAP. Sin puntos: el único signo final es el "!" de "¡Felicitaciones!".
export const SPECIAL_UNLOCK_WINNER_TITLE = '¡Felicitaciones!\nGanaste la partida 420° de esta temporada';
export const SPECIAL_UNLOCK_WINNER_MESSAGE = 'Te espera una sorpresa el próximo draft al que te inscribas 🚬';
/** Dos renglones vacíos entre el título y el mensaje (se antepone al mensaje en el cartel). */
export const SPECIAL_UNLOCK_MESSAGE_GAP = '\n\n';
// Perdedor: mismo mecanismo (título en negrita + mensaje normal separado por SPECIAL_UNLOCK_MESSAGE_GAP). Sin puntos.
export const SPECIAL_UNLOCK_LOSER_TITLE = 'Perdiste el partido 420° de temporada';
export const SPECIAL_UNLOCK_LOSER_MESSAGE = '¡Mejor suerte la próxima!';

export type SpecialUnlockNotice = SpecialUnlockNoticeRow;

/** Partes del cartel según el rol: título (negrita) y, si hay, mensaje (normal). Rol desconocido: null (no se muestra nada). */
export function specialUnlockNoticeParts(role: string | null | undefined): { title: string; message: string | null } | null {
  if (role === 'winner') return { title: SPECIAL_UNLOCK_WINNER_TITLE, message: SPECIAL_UNLOCK_WINNER_MESSAGE };
  if (role === 'loser') return { title: SPECIAL_UNLOCK_LOSER_TITLE, message: SPECIAL_UNLOCK_LOSER_MESSAGE };
  return null;
}

/** Título del cartel según el rol (null si el rol no es válido). */
export function specialUnlockNoticeText(role: string | null | undefined): string | null {
  return specialUnlockNoticeParts(role)?.title ?? null;
}

/**
 * Normaliza lo que devuelve supabase.rpc('get_my_special_unlock_notice'): un arreglo con 0 o 1 fila (así devuelve un
 * `returns table`), o, por las dudas, una fila suelta. Sin fila o con un rol que no sea 'winner' / 'loser': null.
 */
export function parseSpecialUnlockNotice(data: unknown): SpecialUnlockNotice | null {
  const first = Array.isArray(data) ? data[0] : data;
  if (first == null || typeof first !== 'object') return null;
  const r = first as Record<string, unknown>;
  if (r.role !== 'winner' && r.role !== 'loser') return null;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    role: r.role,
    season_id: str(r.season_id),
    workspace_id: str(r.workspace_id),
    match_id: typeof r.match_id === 'string' ? r.match_id : null,
  };
}

export function shouldShowSpecialUnlockNotice(input: {
  notice: SpecialUnlockNotice | null | undefined;
  /** Ya se mostró (o se está mostrando) para este usuario en esta sesión de la app. */
  shownThisSession: boolean;
}): boolean {
  if (input.shownThisSession) return false;
  return specialUnlockNoticeText(input.notice?.role) !== null;
}

/** Carteles que puede mostrar el detalle de un workspace, en el orden en que se muestran (uno después del otro). */
export type WorkspaceNoticeKind = 'gen3' | 'special';
export const WORKSPACE_NOTICE_ORDER: readonly WorkspaceNoticeKind[] = ['gen3', 'special'];

/**
 * Corre los chequeos de carteles de a UNO y en orden (nunca dos a la vez): cada uno termina de decidir (y de encolar su
 * cartel) antes de que empiece el siguiente. Un chequeo que falla no impide los demás.
 */
export async function runNoticesInOrder(
  runners: Record<WorkspaceNoticeKind, () => Promise<unknown>>
): Promise<void> {
  for (const kind of WORKSPACE_NOTICE_ORDER) {
    try {
      await runners[kind]();
    } catch {
      // Un cartel que no se pudo chequear no bloquea al siguiente.
    }
  }
}

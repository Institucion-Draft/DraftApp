import { supabase } from './supabase';
import { showAppAlert } from './appAlert';
import { maybeShowGen3Notice } from './gen3Notice';
import {
  parseSpecialUnlockNotice,
  runNoticesInOrder,
  shouldShowSpecialUnlockNotice,
  specialUnlockNoticeParts,
  SPECIAL_UNLOCK_MESSAGE_GAP,
} from './specialUnlockNoticeCondition';

/** Usuarios para los que el aviso ya se mostró en esta sesión de la app (a nivel módulo: vale entre pantallas). */
const shownFor = new Set<string>();
/** Usuarios con un chequeo en curso (evita dos chequeos simultáneos por doble foco o carga lenta). */
const checking = new Set<string>();

/**
 * Muestra UNA VEZ por sesión el aviso del desbloqueo especial de la partida 420 (si el usuario tiene uno sin ver), con el
 * cartel de la app. Al aceptar lo marca como visto con la RPC ack_special_unlock_notice(). Si esa escritura falla no se
 * reintenta en la sesión: el usuario queda marcado como "ya mostrado" antes de abrir el cartel. Un usuario con más de un
 * aviso sin ver (p. ej. ganó en un workspace y perdió en otro) ve el siguiente en la próxima sesión.
 */
export async function maybeShowSpecialUnlockNotice(userId: string | null | undefined): Promise<void> {
  if (!userId || checking.has(userId) || shownFor.has(userId)) return;
  checking.add(userId);
  try {
    const { data, error } = await supabase.rpc('get_my_special_unlock_notice');
    if (error) return;
    const notice = parseSpecialUnlockNotice(data);
    if (!shouldShowSpecialUnlockNotice({ notice, shownThisSession: shownFor.has(userId) })) return;
    const parts = specialUnlockNoticeParts(notice?.role);
    if (!parts) return;
    shownFor.add(userId);
    showAppAlert({
      title: parts.title,
      // Mensaje en texto normal, separado del título (en negrita) por dos renglones vacíos.
      message: parts.message ? SPECIAL_UNLOCK_MESSAGE_GAP + parts.message : undefined,
      buttons: [
        {
          text: 'Aceptar',
          onPress: () => {
            void supabase.rpc('ack_special_unlock_notice').then(({ error: ackError }) => {
              if (ackError && __DEV__) console.warn('[special-unlock] no se pudo marcar el aviso como visto', ackError.message);
            });
          },
        },
      ],
    });
  } finally {
    checking.delete(userId);
  }
}

/**
 * Carteles del detalle de un workspace, en secuencia: primero el de la Gen 3 y después el del desbloqueo especial. Los dos se
 * encolan en el Modal temático (appAlert), que muestra uno por vez: el segundo aparece cuando se acepta el primero.
 */
export async function maybeShowWorkspaceNotices(userId: string | null | undefined): Promise<void> {
  await runNoticesInOrder({
    gen3: () => maybeShowGen3Notice(userId),
    special: () => maybeShowSpecialUnlockNotice(userId),
  });
}

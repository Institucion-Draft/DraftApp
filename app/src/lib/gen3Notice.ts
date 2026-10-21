import React from 'react';
import { supabase } from './supabase';
import { GEN3_NOTICE_TEXT, shouldShowGen3Notice } from './gen3NoticeCondition';
import { showAppAlert } from './appAlert';
import Gen3StartersRow from '../components/Gen3StartersRow';

/** Usuarios para los que el aviso ya se mostró en esta sesión de la app (a nivel módulo: vale entre pantallas). */
const shownFor = new Set<string>();
/** Usuarios con un chequeo en curso (evita dos chequeos simultáneos por doble foco o carga lenta). */
const checking = new Set<string>();

/**
 * Muestra UNA VEZ el aviso de Gen 3 desbloqueada, con el cartel de la app (Alert.alert, que appAlert.tsx
 * reemplaza por el Modal temático). Al aceptar marca el aviso como visto con la RPC ack_gen3_unlock(). Si esa
 * escritura falla no se reintenta en la sesión: el usuario queda marcado como "ya mostrado" antes de abrir el cartel.
 */
export async function maybeShowGen3Notice(userId: string | null | undefined): Promise<void> {
  if (!userId || checking.has(userId) || shownFor.has(userId)) return;
  checking.add(userId);
  try {
    const { data, error } = await supabase
      .from('users')
      .select('gen3_unlocked_at, gen3_unlock_seen_at')
      .eq('id', userId)
      .maybeSingle();
    if (error || !data) return;
    const row = data as { gen3_unlocked_at: string | null; gen3_unlock_seen_at: string | null };
    if (
      !shouldShowGen3Notice({
        unlockedAt: row.gen3_unlocked_at,
        seenAt: row.gen3_unlock_seen_at,
        shownThisSession: shownFor.has(userId),
      })
    ) {
      return;
    }
    shownFor.add(userId);
    // Cartel de la app (Modal temático) con los tres iniciales de Gen 3 entre el texto y el botón. Los sprites se
    // resuelven por URL pública, sin consultas: si alguno no carga el cartel igual se muestra.
    showAppAlert({
      title: GEN3_NOTICE_TEXT,
      content: React.createElement(Gen3StartersRow),
      buttons: [
        {
          text: 'Aceptar',
          onPress: () => {
            void supabase.rpc('ack_gen3_unlock').then(({ error: ackError }) => {
              if (ackError && __DEV__) console.warn('[gen3] no se pudo marcar el aviso como visto', ackError.message);
            });
          },
        },
      ],
    });
  } finally {
    checking.delete(userId);
  }
}

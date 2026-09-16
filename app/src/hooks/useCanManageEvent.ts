import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export type CanManageEventState = {
  loading: boolean;
  /** Organizador real del workspace (is_workspace_organizer). */
  isOrganizer: boolean;
  /** Tiene la "posta" de ESTE evento puntual (event_organizer_user_id), sea o no organizador real. */
  hasPosta: boolean;
  /** isOrganizer || hasPosta — facultades de organizador SOBRE ESTE EVENTO (todo excepto
   *  eliminar el evento, que queda organizer-only por diseño). */
  canManageEvent: boolean;
  refresh: () => Promise<void>;
};

/**
 * Espejo cliente de can_manage_event (RLS): organizador real del workspace, o poseedor actual
 * de la posta de este evento. Reemplaza los fetches independientes de isOrganizer en pantallas
 * cuyas facultades son sobre UN evento puntual (no sobre recursos del workspace en general).
 */
export function useCanManageEvent(
  workspaceId: string | null | undefined,
  eventId: string | null | undefined
): CanManageEventState {
  const [loading, setLoading] = useState(true);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [hasPosta, setHasPosta] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspaceId || !eventId) {
      setIsOrganizer(false);
      setHasPosta(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    const meRes = await supabase.auth.getUser();
    const myUserId = meRes.data.user?.id ?? null;
    if (!myUserId) {
      setIsOrganizer(false);
      setHasPosta(false);
      setLoading(false);
      return;
    }

    const [roleRes, eventRes] = await Promise.all([
      supabase
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', workspaceId)
        .eq('user_id', myUserId)
        .maybeSingle(),
      supabase
        .from('draft_events')
        .select('event_organizer_user_id')
        .eq('id', eventId)
        .maybeSingle(),
    ]);

    setIsOrganizer(roleRes.data?.role === 'organizer');
    setHasPosta(eventRes.data?.event_organizer_user_id === myUserId);
    setLoading(false);
  }, [workspaceId, eventId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    loading,
    isOrganizer,
    hasPosta,
    canManageEvent: isOrganizer || hasPosta,
    refresh,
  };
}

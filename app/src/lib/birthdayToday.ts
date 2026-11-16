import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { supabase } from './supabase';
import { useAuth } from '../contexts/AuthContext';
import {
  EMPTY_BIRTHDAY_SET,
  createBirthdayIdsLoader,
  parseBirthdayUserIds,
  type BirthdayIdSet,
} from './birthday';

/**
 * Una llamada rpc a public.birthday_user_ids_today() (0161) por día y por usuario, compartida por todas las pantallas: devuelve solo ids de
 * usuarios visibles que cumplen años hoy en Buenos Aires, nunca fechas. Si falla, no hay tortas y no se rompe nada.
 */
const loader = createBirthdayIdsLoader(async () => {
  const { data, error } = await supabase.rpc('birthday_user_ids_today');
  if (error) {
    if (__DEV__) console.warn('[birthday] birthday_user_ids_today falló', error.message);
    return null;
  }
  return parseBirthdayUserIds(data);
});

/**
 * Conjunto de ids que cumplen años hoy. Se pide al montar (si no hay caché del día) y de nuevo cuando la app vuelve a primer plano, pero
 * solo hace una llamada si cambió el día de Buenos Aires (o el usuario).
 */
export function useBirthdayUserIds(): BirthdayIdSet {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [ids, setIds] = useState<BirthdayIdSet>(() => loader.peek(userId));

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (!userId) {
        setIds(EMPTY_BIRTHDAY_SET);
        return;
      }
      void loader.load(userId).then((set) => {
        if (!cancelled) setIds((prev) => (prev === set ? prev : set));
      });
    };
    refresh();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [userId]);

  return ids;
}

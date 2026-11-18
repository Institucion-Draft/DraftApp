import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, FlatList, Switch, ActivityIndicator, Alert, RefreshControl } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { useTheme, useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';
import {
  canDisableCube,
  canTurnOffCubeInEvent,
  eventCubeRows,
  EVENT_LAST_ELIGIBLE_MESSAGE,
  type EventCubeOverride,
  LAST_ENABLED_CUBE_MESSAGE,
  LAST_ENABLED_CUBE_TITLE,
} from '../lib/cubeEnabled';
import { canEditCubeAvailabilityIn, type CubeAvailabilityMode } from '../lib/eventPermissions';

type Props = NativeStackScreenProps<MainStackParamList, 'CubeAvailability'>;

type Row = { id: string; name: string; is_enabled: boolean };

/**
 * Habilitar / deshabilitar cubos, en dos modos según el parámetro eventId:
 * - 'global' (sin eventId; desde la lista de cubos): public.cubes.is_enabled (0160). Solo el organizador del workspace.
 * - 'event' (con eventId; desde la ruleta): public.event_cube_overrides (0163). Quien gestiona el evento (organizador o posta). Todos los cubos,
 *   con su estado efectivo (el propio del evento si existe, si no el global en vivo) y un switch activo para cada uno: el evento puede prender
 *   o apagar cualquiera sin tocar nunca el global. Al enfocar se recarga todo.
 * Un cubo apagado no se borra ni afecta lo ya jugado. El "atrás" es el nativo del stack: la pantalla de origen recarga al enfocar.
 */
export default function CubeAvailabilityScreen({ route, navigation }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { workspaceId, eventId } = route.params;
  const mode: CubeAvailabilityMode = eventId ? 'event' : 'global';
  const [items, setItems] = useState<Row[]>([]);
  const [overrides, setOverrides] = useState<EventCubeOverride[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const firstLoadRef = useRef(true);

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Habilitar/Deshabilitar cubos' });
  }, [navigation, mode]);

  const load = useCallback(async () => {
    const meRes = await supabase.auth.getUser();
    const uid = meRes.data.user?.id ?? null;
    const [roleRes, cubesRes, eventRes, exclRes] = await Promise.all([
      uid
        ? supabase.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', uid).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase
        .from('cubes')
        .select('id, name, is_enabled')
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)
        .order('name', { ascending: true }),
      eventId
        ? supabase.from('draft_events').select('event_organizer_user_id').eq('id', eventId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      eventId
        ? supabase.from('event_cube_overrides').select('cube_id, is_enabled').eq('event_id', eventId)
        : Promise.resolve({ data: [], error: null }),
    ]);
    setCanEdit(
      canEditCubeAvailabilityIn(mode, {
        workspaceRole: roleRes.error ? null : ((roleRes.data as { role?: string } | null)?.role ?? null),
        eventOrganizerUserId: (eventRes.data as { event_organizer_user_id?: string | null } | null)?.event_organizer_user_id ?? null,
        userId: uid,
      })
    );
    if (cubesRes.error || exclRes.error) {
      Alert.alert('Error', 'No se pudieron cargar los cubos.');
      setItems([]);
      setOverrides([]);
      return;
    }
    setOverrides((exclRes.data ?? []) as EventCubeOverride[]);
    setItems(((cubesRes.data ?? []) as { id: string; name: string; is_enabled: boolean | null }[]).map((c) => ({ ...c, is_enabled: c.is_enabled !== false })));
  }, [workspaceId, eventId, mode]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        const first = firstLoadRef.current;
        if (first) {
          setLoading(true);
          firstLoadRef.current = false;
        }
        await load();
        if (!cancelled && first) setLoading(false);
      })();
      return () => {
        cancelled = true;
      };
    }, [load])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const eventRows = eventCubeRows(items, overrides);

  const toggleGlobal = async (row: Row, value: boolean) => {
    if (!canEdit || savingId) return;
    // Con 0 cubos habilitados la ruleta no puede girar: el último habilitado no se puede deshabilitar.
    if (!value && !canDisableCube(items, row.id)) {
      Alert.alert(LAST_ENABLED_CUBE_TITLE, LAST_ENABLED_CUBE_MESSAGE);
      return;
    }
    setSavingId(row.id);
    const { error } = await supabase.from('cubes').update({ is_enabled: value }).eq('id', row.id);
    setSavingId(null);
    if (error) {
      Alert.alert('Error', error.message ?? 'No se pudo guardar el cambio.');
      await load();
      return;
    }
    setItems((prev) => prev.map((r) => (r.id === row.id ? { ...r, is_enabled: value } : r)));
  };

  const toggleEvent = async (row: Row, value: boolean) => {
    if (!canEdit || savingId || !eventId) return;
    const cur = eventRows.find((r) => r.id === row.id);
    if (!cur || cur.eligible === value) return;
    // value = elegible. Apagar el último elegible no se puede: la ruleta no podría girar. Prender siempre se puede.
    if (!value && !canTurnOffCubeInEvent(eventRows, row.id)) {
      Alert.alert(LAST_ENABLED_CUBE_TITLE, EVENT_LAST_ELIGIBLE_MESSAGE);
      return;
    }
    const uid = (await supabase.auth.getUser()).data.user?.id ?? null;
    if (!uid) {
      Alert.alert('Error', 'No hay sesión activa.');
      return;
    }
    setSavingId(row.id);
    // Estado propio del evento: se inserta, o se actualiza si ya había uno (el global nunca se toca).
    let { error } = await supabase.from('event_cube_overrides').insert({ event_id: eventId, cube_id: row.id, is_enabled: value, created_by: uid });
    if (error && (error as { code?: string }).code === '23505') {
      ({ error } = await supabase.from('event_cube_overrides').update({ is_enabled: value }).eq('event_id', eventId).eq('cube_id', row.id));
    }
    setSavingId(null);
    if (error) {
      Alert.alert('Error', error.message ?? 'No se pudo guardar el cambio.');
      await load();
      return;
    }
    setOverrides((prev) => [...prev.filter((o) => o.cube_id !== row.id), { cube_id: row.id, is_enabled: value }]);
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {mode === 'global' ? (
        <Text style={styles.help}>
          Los cubos deshabilitados no salen en la ruleta. No se borran ni cambian nada de lo ya jugado.
          {!canEdit ? ' Solo el organizador puede cambiarlo.' : ''}
        </Text>
      ) : null}
      <FlatList
        data={eventRows}
        keyExtractor={(it) => it.id}
        contentContainerStyle={items.length === 0 ? styles.emptyWrap : styles.listWrap}
        ListEmptyComponent={<Text style={styles.empty}>No hay cubos todavía.</Text>}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        renderItem={({ item }) => {
          const on = mode === 'event' ? item.eligible : item.globalEnabled;
          return (
            <View style={styles.row}>
              <View style={styles.nameWrap}>
                <Text style={[styles.name, !on && styles.nameOff]} numberOfLines={2}>
                  {item.name}
                </Text>
              </View>
              <Switch
                value={on}
                onValueChange={(v) => void (mode === 'event' ? toggleEvent(item, v) : toggleGlobal(item, v))}
                disabled={!canEdit || savingId !== null}
                trackColor={{ false: colors.border, true: colors.accent }}
              />
            </View>
          );
        }}
      />
    </View>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: c.background },
    help: { color: c.textSecondary, fontSize: 13, paddingHorizontal: 16, paddingTop: 12 },
    listWrap: { padding: 16, paddingBottom: 30 },
    emptyWrap: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
    empty: { color: c.textSecondary, fontSize: 15 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: c.card,
      borderColor: c.divider,
      borderWidth: 1,
      borderRadius: 12,
      paddingVertical: 10,
      paddingHorizontal: 14,
      marginBottom: 10,
    },
    nameWrap: { flex: 1, minWidth: 0, marginRight: 12 },
    name: { fontSize: 16, fontWeight: '600', color: c.text },
    nameOff: { color: c.textSecondary },
  });

import React, { useCallback, useRef, useState } from 'react';
import { View, Text, StyleSheet, FlatList, Switch, ActivityIndicator, Alert, RefreshControl } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { useTheme, useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';
import { canDisableCube, LAST_ENABLED_CUBE_MESSAGE, LAST_ENABLED_CUBE_TITLE } from '../lib/cubeEnabled';

type Props = NativeStackScreenProps<MainStackParamList, 'CubeAvailability'>;

type Row = { id: string; name: string; is_enabled: boolean };

/**
 * Habilitar / deshabilitar cubos (public.cubes.is_enabled, 0160). Un cubo deshabilitado sale de la ruleta pero no se borra ni
 * afecta lo ya jugado. Se llega desde la lista de cubos y desde la ruleta; el "atrás" (header y botón de Android) es el nativo del
 * stack: vuelve a la pantalla desde la que se llegó. Esas pantallas recargan al enfocar, así que ven el cambio al volver.
 */
export default function CubeAvailabilityScreen({ route }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { workspaceId } = route.params;
  const [items, setItems] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const firstLoadRef = useRef(true);

  const load = useCallback(async () => {
    const meRes = await supabase.auth.getUser();
    const uid = meRes.data.user?.id ?? null;
    const [roleRes, cubesRes] = await Promise.all([
      uid
        ? supabase.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', uid).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase
        .from('cubes')
        .select('id, name, is_enabled')
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)
        .order('name', { ascending: true }),
    ]);
    setIsOrganizer(!roleRes.error && roleRes.data?.role === 'organizer');
    if (cubesRes.error) {
      Alert.alert('Error', 'No se pudieron cargar los cubos.');
      setItems([]);
      return;
    }
    setItems(((cubesRes.data ?? []) as { id: string; name: string; is_enabled: boolean | null }[]).map((c) => ({ ...c, is_enabled: c.is_enabled !== false })));
  }, [workspaceId]);

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

  const toggle = async (row: Row, value: boolean) => {
    if (!isOrganizer || savingId) return;
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

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.help}>
        Los cubos deshabilitados no salen en la ruleta. No se borran ni cambian nada de lo ya jugado.
        {!isOrganizer ? ' Solo el organizador puede cambiarlo.' : ''}
      </Text>
      <FlatList
        data={items}
        keyExtractor={(it) => it.id}
        contentContainerStyle={items.length === 0 ? styles.emptyWrap : styles.listWrap}
        ListEmptyComponent={<Text style={styles.empty}>No hay cubos todavía.</Text>}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={[styles.name, !item.is_enabled && styles.nameOff]} numberOfLines={2}>
              {item.name}
            </Text>
            <Switch
              value={item.is_enabled}
              onValueChange={(v) => void toggle(item, v)}
              disabled={!isOrganizer || savingId !== null}
              trackColor={{ false: colors.border, true: colors.accent }}
            />
          </View>
        )}
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
    name: { flex: 1, minWidth: 0, fontSize: 16, fontWeight: '600', color: c.text, marginRight: 12 },
    nameOff: { color: c.textSecondary },
  });

import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  ScrollView,
  Image,
  Alert,
  RefreshControl,
  Linking,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { avatarPublicUrl } from '../lib/avatarUrl';

type Props = NativeStackScreenProps<MainStackParamList, 'CubeDetail'>;

type CubeStatsRow = {
  id: string;
  workspace_id: string;
  name: string;
  card_count: number | null;
  cubecobra_url: string | null;
  notes: string | null;
  avatar_path: string | null;
  usage_count: number;
  first_used_at: string | null;
  last_used_at: string | null;
};

export default function CubeDetailScreen({ route, navigation }: Props) {
  const { cubeId } = route.params;
  const [row, setRow] = useState<CubeStatsRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const firstLoadRef = useRef(true);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('cubes_with_stats')
      .select(
        'id, workspace_id, name, card_count, cubecobra_url, notes, avatar_path, usage_count, first_used_at, last_used_at'
      )
      .eq('id', cubeId)
      .maybeSingle();

    if (error || !data) {
      Alert.alert('Error', 'No se pudo cargar el cubo.');
      setRow(null);
      return;
    }
    const cube = data as CubeStatsRow;
    setRow(cube);

    const { data: roleData } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', cube.workspace_id)
      .maybeSingle();
    setIsOrganizer(roleData?.role === 'organizer');
  }, [cubeId]);

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

  useLayoutEffect(() => {
    navigation.setOptions({
      title: row?.name ?? 'Cubo',
      headerRight: isOrganizer
        ? () => (
            <TouchableOpacity onPress={() => row && navigation.navigate('EditCube', { cubeId: row.id })}>
              <Text style={styles.editTop}>Editar</Text>
            </TouchableOpacity>
          )
        : undefined,
    });
  }, [isOrganizer, navigation, row]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  if (!row) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>No se encontró el cubo.</Text>
      </View>
    );
  }

  const avatar = avatarPublicUrl(row.avatar_path);
  const fmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' })
      : '—';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scroll}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {avatar ? (
        <Image source={{ uri: avatar }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatar, styles.avatarPh]}>
          <Text style={styles.avatarTxt}>{row.name.slice(0, 1).toUpperCase()}</Text>
        </View>
      )}
      <Text style={styles.title}>{row.name}</Text>
      <Text style={styles.item}>Cartas: {row.card_count ?? '—'}</Text>
      <Text style={styles.item}>Usos en eventos: {row.usage_count ?? 0}</Text>
      <Text style={styles.item}>Primera vez usado: {fmt(row.first_used_at)}</Text>
      <Text style={styles.item}>Última vez usado: {fmt(row.last_used_at)}</Text>
      <Text style={styles.section}>Notas</Text>
      <Text style={styles.notes}>{row.notes?.trim() || 'Sin notas.'}</Text>

      {row.cubecobra_url ? (
        <TouchableOpacity
          style={styles.linkBtn}
          onPress={() => {
            void Linking.openURL(row.cubecobra_url!).catch(() => {
              Alert.alert('Error', 'No se pudo abrir el link de CubeCobra.');
            });
          }}
        >
          <Text style={styles.linkBtnText}>Ver en CubeCobra</Text>
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  muted: { color: '#666', fontSize: 15 },
  scroll: { padding: 24, paddingBottom: 40, alignItems: 'center' },
  avatar: { width: 92, height: 92, borderRadius: 16, backgroundColor: '#f3f4f6', marginBottom: 14 },
  avatarPh: { justifyContent: 'center', alignItems: 'center', backgroundColor: '#E0E7FF' },
  avatarTxt: { fontSize: 36, fontWeight: '700', color: '#4338CA' },
  title: { fontSize: 24, fontWeight: '700', color: '#111', marginBottom: 14, textAlign: 'center' },
  item: { fontSize: 15, color: '#444', marginBottom: 6, alignSelf: 'stretch' },
  section: { alignSelf: 'stretch', marginTop: 18, marginBottom: 8, fontSize: 16, fontWeight: '700', color: '#111' },
  notes: {
    alignSelf: 'stretch',
    fontSize: 14,
    color: '#666',
    lineHeight: 21,
    backgroundColor: '#fafafa',
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 10,
    padding: 12,
  },
  linkBtn: {
    marginTop: 20,
    alignSelf: 'stretch',
    backgroundColor: '#3B82F6',
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: 'center',
  },
  linkBtnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  editTop: { color: '#3B82F6', fontSize: 16, fontWeight: '600' },
});

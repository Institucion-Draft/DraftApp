import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Image,
  Alert,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { avatarPublicUrl } from '../lib/avatarUrl';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';

type Props = NativeStackScreenProps<MainStackParamList, 'CubesList'>;

type CubeRow = {
  id: string;
  name: string;
  card_count: number | null;
  cubecobra_url: string | null;
  avatar_path: string | null;
  usage_count: number;
};

export default function CubesListScreen({ navigation, route }: Props) {
  const { workspaceId } = route.params;
  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'WorkspaceDetail', { workspaceId }),
    });
  }, [navigation, workspaceId]);
  const [items, setItems] = useState<CubeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const firstLoadRef = useRef(true);

  const load = useCallback(async () => {
    const [myRoleRes, cubesRes] = await Promise.all([
      supabase
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', workspaceId)
        .maybeSingle(),
      supabase
        .from('cubes_with_stats')
        .select('id, name, card_count, cubecobra_url, avatar_path, usage_count')
        .eq('workspace_id', workspaceId)
        .order('name', { ascending: true }),
    ]);

    if (myRoleRes.error) {
      Alert.alert('Error', 'No se pudo validar tu rol en este workspace.');
      setIsOrganizer(false);
    } else {
      setIsOrganizer(myRoleRes.data?.role === 'organizer');
    }

    if (cubesRes.error) {
      Alert.alert('Error', 'No se pudieron cargar los cubos.');
      setItems([]);
      return;
    }

    setItems((cubesRes.data ?? []) as CubeRow[]);
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

  const softDeleteCube = async (cubeId: string) => {
    const { error } = await supabase
      .from('cubes')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', cubeId);

    if (error) {
      Alert.alert('Error', error.message ?? 'No se pudo borrar el cubo.');
      return;
    }
    await load();
  };

  const confirmDelete = (cubeId: string, name: string) => {
    Alert.alert('Borrar cubo', `¿Seguro que querés borrar "${name}"?`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Borrar', style: 'destructive', onPress: () => void softDeleteCube(cubeId) },
    ]);
  };

  const openEdit = (cubeId: string) => navigation.navigate('EditCube', { cubeId });

  const renderItem = ({ item }: { item: CubeRow }) => {
    const avatar = avatarPublicUrl(item.avatar_path);
    return (
      <TouchableOpacity
        style={styles.card}
        onPress={() => navigation.navigate('CubeDetail', { cubeId: item.id })}
        activeOpacity={0.75}
      >
        <View style={styles.row}>
          {avatar ? (
            <Image source={{ uri: avatar }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarPh]}>
              <Text style={styles.avatarTxt}>{item.name.slice(0, 1).toUpperCase()}</Text>
            </View>
          )}
          <View style={styles.body}>
            <Text style={styles.name}>{item.name}</Text>
            <Text style={styles.meta}>Cartas: {item.card_count ?? '—'}</Text>
            <Text style={styles.meta}>Usos en eventos: {item.usage_count ?? 0}</Text>
            {item.cubecobra_url ? <Text style={styles.link}>CubeCobra disponible</Text> : null}
          </View>
          {isOrganizer ? (
            <View style={styles.actions}>
              <TouchableOpacity onPress={() => openEdit(item.id)} style={styles.iconBtn}>
                <Text style={styles.iconTxt}>✏️</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => confirmDelete(item.id, item.name)} style={styles.iconBtn}>
                <Text style={styles.iconTxt}>🗑️</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {isOrganizer ? (
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={() => navigation.navigate('CreateCube', { workspaceId })}
        >
          <Text style={styles.primaryBtnText}>+ Agregar cubo</Text>
        </TouchableOpacity>
      ) : null}

      <FlatList
        data={items}
        keyExtractor={(it) => it.id}
        renderItem={renderItem}
        contentContainerStyle={items.length === 0 ? styles.emptyWrap : styles.listWrap}
        ListEmptyComponent={<Text style={styles.empty}>No hay cubos todavía.</Text>}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  primaryBtn: {
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: '#3B82F6',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  listWrap: { padding: 16, paddingBottom: 30 },
  emptyWrap: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  empty: { color: '#666', fontSize: 15 },
  card: {
    backgroundColor: '#fafafa',
    borderColor: '#eee',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  avatar: { width: 48, height: 48, borderRadius: 10, backgroundColor: '#f3f4f6', marginRight: 12 },
  avatarPh: { justifyContent: 'center', alignItems: 'center', backgroundColor: '#E0E7FF' },
  avatarTxt: { fontSize: 18, fontWeight: '700', color: '#4338CA' },
  body: { flex: 1, minWidth: 0 },
  name: { fontSize: 16, fontWeight: '700', color: '#111', marginBottom: 4 },
  meta: { fontSize: 13, color: '#666', marginBottom: 2 },
  link: { fontSize: 13, color: '#3B82F6', marginTop: 4 },
  actions: { flexDirection: 'row', marginLeft: 8 },
  iconBtn: { paddingHorizontal: 6, paddingVertical: 2 },
  iconTxt: { fontSize: 16 },
});

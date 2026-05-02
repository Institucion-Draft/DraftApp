import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';

type Props = NativeStackScreenProps<MainStackParamList, 'VenuesList'>;

type VenueRow = {
  id: string;
  name: string;
  address: string | null;
  usage_count: number;
};

export default function VenuesListScreen({ navigation, route }: Props) {
  const { workspaceId } = route.params;
  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'WorkspaceDetail', { workspaceId }),
    });
  }, [navigation, workspaceId]);
  const [items, setItems] = useState<VenueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const firstRef = useRef(true);

  const load = useCallback(async () => {
    const meRes = await supabase.auth.getUser();
    const currentUserId = meRes.data.user?.id ?? null;

    const [roleRes, venuesRes] = await Promise.all([
      currentUserId
        ? supabase
            .from('workspace_members')
            .select('role')
            .eq('workspace_id', workspaceId)
            .eq('user_id', currentUserId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase
        .from('venues_with_stats')
        .select('id, name, address, usage_count')
        .eq('workspace_id', workspaceId)
        .order('name', { ascending: true }),
    ]);

    if (roleRes.error) {
      if (__DEV__) {
        console.error('Error cargando rol del workspace:', roleRes.error);
      }
    }
    setIsOrganizer(!roleRes.error && roleRes.data?.role === 'organizer');
    if (venuesRes.error) {
      Alert.alert('Error', 'No se pudieron cargar las sedes.');
      setItems([]);
      return;
    }
    setItems((venuesRes.data ?? []) as VenueRow[]);
  }, [workspaceId]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        const first = firstRef.current;
        if (first) {
          setLoading(true);
          firstRef.current = false;
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
        <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.navigate('CreateVenue', { workspaceId })}>
          <Text style={styles.primaryBtnText}>+ Agregar sede</Text>
        </TouchableOpacity>
      ) : null}
      <FlatList
        data={items}
        keyExtractor={(it) => it.id}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.card} onPress={() => navigation.navigate('EditVenue', { venueId: item.id })}>
            <Text style={styles.name}>{item.name}</Text>
            <Text style={styles.meta}>{item.address?.trim() || 'Sin dirección'}</Text>
            <Text style={styles.meta}>Usos en eventos: {item.usage_count ?? 0}</Text>
          </TouchableOpacity>
        )}
        contentContainerStyle={items.length === 0 ? styles.emptyWrap : styles.listWrap}
        ListEmptyComponent={<Text style={styles.empty}>No hay sedes todavía.</Text>}
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
  listWrap: { padding: 16, paddingBottom: 32 },
  emptyWrap: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  empty: { color: '#666', fontSize: 15 },
  card: {
    backgroundColor: '#fafafa',
    borderColor: '#eee',
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  name: { fontSize: 16, fontWeight: '700', color: '#111', marginBottom: 6 },
  meta: { fontSize: 13, color: '#666' },
});

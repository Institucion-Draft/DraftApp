import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Animated,
  Image,
  Alert,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import type { EventType, EventStatus } from '../lib/database.types';
import { avatarPublicUrl } from '../lib/avatarUrl';
import { getEventStatusLabel, getEventTypeLabel } from '../lib/labels';

type Props = NativeStackScreenProps<MainStackParamList, 'EventsList'>;

type EventRow = {
  id: string;
  name: string;
  avatar_path: string | null;
  scheduled_for: string;
  status: EventStatus;
  event_type: EventType;
  cube_id: string | null;
  venue_id: string | null;
  champion_user_id: string | null;
};

export default function EventsListScreen({ navigation, route }: Props) {
  const { workspaceId } = route.params;
  const [items, setItems] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [cubeMap, setCubeMap] = useState<Record<string, string>>({});
  const [venueMap, setVenueMap] = useState<Record<string, string>>({});
  const [participantCounts, setParticipantCounts] = useState<Record<string, number>>({});
  const [championAvatars, setChampionAvatars] = useState<Record<string, string | null>>({});
  const firstLoadRef = useRef(true);
  const pulse = useRef(new Animated.Value(1)).current;

  const startPulse = useCallback(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    ).start();
  }, [pulse]);

  const load = useCallback(async () => {
    const [roleRes, eventsRes, cubesRes, venuesRes] = await Promise.all([
      supabase.from('workspace_members').select('role').eq('workspace_id', workspaceId).maybeSingle(),
      supabase
        .from('draft_events')
        .select('id, name, avatar_path, scheduled_for, status, event_type, cube_id, venue_id, champion_user_id')
        .eq('workspace_id', workspaceId)
        .order('scheduled_for', { ascending: false }),
      supabase.from('cubes').select('id, name').eq('workspace_id', workspaceId),
      supabase.from('venues').select('id, name').eq('workspace_id', workspaceId),
    ]);

    if (!roleRes.error) setIsOrganizer(roleRes.data?.role === 'organizer');
    if (eventsRes.error) {
      Alert.alert('Error', 'No se pudieron cargar los eventos.');
      setItems([]);
      return;
    }

    const events = (eventsRes.data ?? []) as EventRow[];
    setItems(events);
    setCubeMap(
      Object.fromEntries(((cubesRes.data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]))
    );
    setVenueMap(
      Object.fromEntries(((venuesRes.data ?? []) as { id: string; name: string }[]).map((v) => [v.id, v.name]))
    );

    const countEntries = await Promise.all(
      events.map(async (e) => {
        const { count } = await supabase
          .from('event_participants')
          .select('id', { count: 'exact', head: true })
          .eq('event_id', e.id)
          .eq('role', 'player');
        return [e.id, count ?? 0] as const;
      })
    );
    setParticipantCounts(Object.fromEntries(countEntries));

    const champIds = Array.from(new Set(events.map((e) => e.champion_user_id).filter(Boolean) as string[]));
    if (champIds.length > 0) {
      const { data } = await supabase
        .from('users')
        .select('id, custom_avatar_path, default_avatars(storage_path)')
        .in('id', champIds);
      const map: Record<string, string | null> = {};
      for (const row of (data ?? []) as any[]) {
        const da = Array.isArray(row.default_avatars) ? row.default_avatars[0] : row.default_avatars;
        map[row.id] = avatarPublicUrl(row.custom_avatar_path) ?? avatarPublicUrl(da?.storage_path ?? null);
      }
      setChampionAvatars(map);
    } else {
      setChampionAvatars({});
    }
  }, [workspaceId]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      startPulse();
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
    }, [load, startPulse])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const isToday = (iso: string) => {
    const d = new Date(iso);
    const n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  };

  const countdown = (iso: string) => {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return null;
    const mins = Math.floor(ms / 60000);
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const minutes = mins % 60;
    return `${days}d ${hours}h ${minutes}m`;
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
        <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.navigate('CreateEvent', { workspaceId })}>
          <Text style={styles.primaryBtnText}>+ Crear evento</Text>
        </TouchableOpacity>
      ) : null}
      <FlatList
        data={items}
        keyExtractor={(it) => it.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerStyle={items.length === 0 ? styles.emptyWrap : styles.listWrap}
        ListEmptyComponent={<Text style={styles.empty}>No hay eventos todavía.</Text>}
        renderItem={({ item }) => {
          const avatar = avatarPublicUrl(item.avatar_path);
          const when = new Date(item.scheduled_for);
          const cdown = countdown(item.scheduled_for);
          const champUri = item.champion_user_id ? championAvatars[item.champion_user_id] : null;
          return (
            <TouchableOpacity style={styles.card} onPress={() => navigation.navigate('EventDetail', { eventId: item.id })}>
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
                  <Text style={styles.meta}>
                    {when.toLocaleString('es-AR', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </Text>
                  <Text style={styles.meta}>Estado: {getEventStatusLabel(item.status)}</Text>
                  <Text style={styles.meta}>Tipo: {getEventTypeLabel(item.event_type)}</Text>
                  <Text style={styles.meta}>Cubo: {item.cube_id ? cubeMap[item.cube_id] ?? '—' : 'Sin definir'}</Text>
                  <Text style={styles.meta}>Sede: {item.venue_id ? venueMap[item.venue_id] ?? '—' : 'Sin definir'}</Text>
                  <Text style={styles.meta}>Participantes: {participantCounts[item.id] ?? 0}</Text>
                  {isToday(item.scheduled_for) ? (
                    <Animated.View style={[styles.todayBadge, { opacity: pulse }]}>
                      <Text style={styles.todayBadgeTxt}>ES HOY!</Text>
                    </Animated.View>
                  ) : cdown ? (
                    <Text style={styles.countdown}>Faltan {cdown}</Text>
                  ) : null}
                </View>
                {champUri ? <Image source={{ uri: champUri }} style={styles.champAvatar} /> : null}
              </View>
            </TouchableOpacity>
          );
        }}
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
    padding: 12,
    marginBottom: 10,
  },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  avatar: { width: 46, height: 46, borderRadius: 10, backgroundColor: '#f3f4f6', marginRight: 10 },
  avatarPh: { justifyContent: 'center', alignItems: 'center', backgroundColor: '#E0E7FF' },
  avatarTxt: { fontSize: 18, fontWeight: '700', color: '#4338CA' },
  body: { flex: 1, minWidth: 0 },
  name: { fontSize: 16, fontWeight: '700', color: '#111', marginBottom: 4 },
  meta: { fontSize: 12, color: '#666', marginBottom: 2 },
  todayBadge: {
    alignSelf: 'flex-start',
    marginTop: 8,
    backgroundColor: '#F59E0B',
    borderRadius: 6,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  todayBadgeTxt: { color: '#fff', fontWeight: '700', fontSize: 11 },
  countdown: { marginTop: 8, fontSize: 12, fontWeight: '600', color: '#3B82F6' },
  champAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 2,
    borderColor: '#3B82F6',
    marginLeft: 8,
  },
});

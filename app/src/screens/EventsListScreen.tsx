import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
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
import { avatarPublicUrl, defaultAvatarPublicUrl } from '../lib/avatarUrl';
import { getEventStatusLabel, getEventTypeLabel } from '../lib/labels';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';

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
  has_shiny_participant: boolean;
};

function relationOne<T>(rel: T | T[] | null | undefined): T | null {
  if (rel == null) return null;
  return Array.isArray(rel) ? rel[0] ?? null : rel;
}

export default function EventsListScreen({ navigation, route }: Props) {
  const { workspaceId } = route.params;
  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'WorkspaceDetail', { workspaceId }),
    });
  }, [navigation, workspaceId]);
  const [items, setItems] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [cubeMap, setCubeMap] = useState<Record<string, string>>({});
  const [venueMap, setVenueMap] = useState<Record<string, string>>({});
  const [participantCounts, setParticipantCounts] = useState<Record<string, number>>({});
  const [championAvatars, setChampionAvatars] = useState<Record<string, string | null>>({});
  const [championNames, setChampionNames] = useState<Record<string, string>>({});
  const [championMemberBAvatars, setChampionMemberBAvatars] = useState<Record<string, string | null>>({});
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
    const meRes = await supabase.auth.getUser();
    const currentUserId = meRes.data.user?.id ?? null;

    const [roleRes, eventsRes, cubesRes, venuesRes] = await Promise.all([
      currentUserId
        ? supabase
            .from('workspace_members')
            .select('role')
            .eq('workspace_id', workspaceId)
            .eq('user_id', currentUserId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase
        .from('draft_events')
        .select('id, name, avatar_path, scheduled_for, status, event_type, cube_id, venue_id, champion_user_id, has_shiny_participant')
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)
        .order('scheduled_for', { ascending: false }),
      supabase.from('cubes').select('id, name').eq('workspace_id', workspaceId),
      supabase.from('venues').select('id, name').eq('workspace_id', workspaceId),
    ]);

    if (roleRes.error) {
      if (__DEV__) {
        console.error('Error cargando rol del workspace:', roleRes.error);
      }
    }
    setIsOrganizer(!roleRes.error && roleRes.data?.role === 'organizer');
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

    const championEvents = events.filter((e) => e.champion_user_id);
    if (championEvents.length > 0) {
      const eventIds = championEvents.map((e) => e.id);
      const userIds = Array.from(new Set(championEvents.map((e) => e.champion_user_id!)));

      const [partsRes, usersRes] = await Promise.all([
        supabase
          .from('event_participants')
          .select('event_id, user_id, is_shiny, rotated_avatar_id, member_b_user_id, member_b_rotated_avatar_id, member_b_is_shiny, giant_name, default_avatars!event_participants_rotated_avatar_id_fkey (storage_path, storage_path_shiny)')
          .in('event_id', eventIds)
          .in('user_id', userIds)
          .eq('role', 'player'),
        supabase
          .from('users')
          .select('id, display_name, username, custom_avatar_path, default_avatars(storage_path)')
          .in('id', userIds),
      ]);

      type PartRow = {
        event_id: string;
        user_id: string;
        is_shiny?: boolean;
        member_b_user_id?: string | null;
        member_b_rotated_avatar_id?: string | null;
        member_b_is_shiny?: boolean | null;
        giant_name?: string | null;
        default_avatars?: {
          storage_path: string;
          storage_path_shiny?: string | null;
        } | {
          storage_path: string;
          storage_path_shiny?: string | null;
        }[] | null;
      };
      const partByEventUser = new Map<string, PartRow>();
      for (const row of (partsRes.data ?? []) as PartRow[]) {
        partByEventUser.set(`${row.event_id}:${row.user_id}`, row);
      }

      const userById: Record<
        string,
        {
          display_name?: string | null;
          username?: string | null;
          custom_avatar_path?: string | null;
          default_avatars?: { storage_path: string } | { storage_path: string }[] | null;
        }
      > = {};
      for (const row of (usersRes.data ?? []) as Array<{
        id: string;
        display_name?: string | null;
        username?: string | null;
        custom_avatar_path?: string | null;
        default_avatars?: { storage_path: string } | { storage_path: string }[] | null;
      }>) {
        userById[row.id] = row;
      }

      const avatarMap: Record<string, string | null> = {};
      const nameMap: Record<string, string> = {};
      for (const e of championEvents) {
        const uid = e.champion_user_id!;
        const part = partByEventUser.get(`${e.id}:${uid}`);
        const user = userById[uid];
        nameMap[e.id] =
          (e.event_type === 'two_headed_giant' && part?.giant_name?.trim())
            ? part.giant_name.trim()
            : (user?.display_name?.trim() || user?.username?.trim() || 'Campeón');

        const rotDa = relationOne(part?.default_avatars);
        let uri: string | null = null;
        if (part?.is_shiny && rotDa?.storage_path_shiny) {
          uri = defaultAvatarPublicUrl(rotDa.storage_path_shiny);
        } else if (rotDa?.storage_path) {
          uri = defaultAvatarPublicUrl(rotDa.storage_path);
        } else if (user) {
          const userDa = relationOne(user.default_avatars);
          uri =
            avatarPublicUrl(user.custom_avatar_path ?? null) ??
            avatarPublicUrl(userDa?.storage_path ?? null);
        }
        avatarMap[e.id] = uri;
      }
      setChampionAvatars(avatarMap);
      setChampionNames(nameMap);

      type MbDefaultAvatarRow = { id: string; storage_path: string; storage_path_shiny?: string | null };
      const memberBUidByEventId: Record<string, string> = {};
      const allMemberBUids: string[] = [];
      const mbRotatedAvatarIds: string[] = [];
      for (const e of championEvents) {
        if (e.event_type === 'two_headed_giant') {
          const part = partByEventUser.get(`${e.id}:${e.champion_user_id!}`);
          const mbUid = part?.member_b_user_id;
          const mbRavId = part?.member_b_rotated_avatar_id;
          if (mbUid) {
            memberBUidByEventId[e.id] = mbUid;
            allMemberBUids.push(mbUid);
          }
          if (mbRavId) mbRotatedAvatarIds.push(mbRavId);
        }
      }
      const memberBAvatarMap: Record<string, string | null> = {};
      if (allMemberBUids.length > 0) {
        const mbDefaultAvatarsById: Record<string, MbDefaultAvatarRow> = {};
        if (mbRotatedAvatarIds.length > 0) {
          const mbDaRes = await supabase
            .from('default_avatars')
            .select('id, storage_path, storage_path_shiny')
            .in('id', mbRotatedAvatarIds);
          for (const row of (mbDaRes.data ?? []) as MbDefaultAvatarRow[]) {
            mbDefaultAvatarsById[row.id] = row;
          }
        }
        const mbUsersRes = await supabase
          .from('users')
          .select('id, custom_avatar_path, default_avatars(storage_path)')
          .in('id', allMemberBUids);
        const mbUserById: Record<string, { custom_avatar_path?: string | null; default_avatars?: { storage_path: string } | { storage_path: string }[] | null }> = {};
        for (const row of (mbUsersRes.data ?? []) as Array<{ id: string; custom_avatar_path?: string | null; default_avatars?: { storage_path: string } | { storage_path: string }[] | null }>) {
          mbUserById[row.id] = row;
        }
        for (const [eid, mbUid] of Object.entries(memberBUidByEventId)) {
          const champUid = championEvents.find((e) => e.id === eid)?.champion_user_id;
          const part = champUid ? partByEventUser.get(`${eid}:${champUid}`) : undefined;
          const mbRavId = part?.member_b_rotated_avatar_id;
          const mbIsShiny = part?.member_b_is_shiny;
          const mbDa = mbRavId ? mbDefaultAvatarsById[mbRavId] : null;
          const mbUser = mbUserById[mbUid];
          let mbUri: string | null = null;
          if (mbIsShiny && mbDa?.storage_path_shiny) {
            mbUri = defaultAvatarPublicUrl(mbDa.storage_path_shiny);
          } else if (mbDa?.storage_path) {
            mbUri = defaultAvatarPublicUrl(mbDa.storage_path);
          } else if (mbUser) {
            const mbUserDa = relationOne(mbUser.default_avatars);
            mbUri =
              avatarPublicUrl(mbUser.custom_avatar_path ?? null) ??
              avatarPublicUrl(mbUserDa?.storage_path ?? null) ??
              null;
          }
          if (__DEV__) {
            console.log('DEBUG champB', {
              eid,
              mbUid,
              mbRavId,
              mbIsShiny,
              mbDaFound: !!mbDa,
              mbUserFound: !!mbUser,
              mbUri,
            });
          }
          memberBAvatarMap[eid] = mbUri;
        }
      }
      setChampionMemberBAvatars(memberBAvatarMap);
    } else {
      setChampionAvatars({});
      setChampionNames({});
      setChampionMemberBAvatars({});
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
          const champUri = item.champion_user_id ? championAvatars[item.id] : null;
          const champName = item.champion_user_id ? championNames[item.id] : null;
          const champMemberBUri = item.event_type === 'two_headed_giant' ? (championMemberBAvatars[item.id] ?? null) : null;
          const showShinyCup =
            item.status === 'completed' && item.has_shiny_participant && !!champUri;
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
                  <Text style={styles.meta}>Participantes: {(participantCounts[item.id] ?? 0) * (item.event_type === 'two_headed_giant' ? 2 : 1)}</Text>
                  {isToday(item.scheduled_for) ? (
                    <Animated.View style={[styles.todayBadge, { opacity: pulse }]}>
                      <Text style={styles.todayBadgeTxt}>ES HOY!</Text>
                    </Animated.View>
                  ) : cdown ? (
                    <Text style={styles.countdown}>Faltan {cdown}</Text>
                  ) : null}
                </View>
                {item.champion_user_id ? (
                  <View style={styles.champCol}>
                    {champUri ? (
                      champMemberBUri ? (
                        <View style={styles.champAvatarWrap2HG}>
                          {showShinyCup ? (
                            <View style={styles.shinyCupMark} accessibilityLabel="Copa Shiny">
                              <Text style={styles.shinyCupMarkTxt}>✨</Text>
                            </View>
                          ) : null}
                          <View>
                            <Image
                              source={{ uri: champUri }}
                              style={[styles.champAvatarSmall, showShinyCup && styles.champAvatarShinyRing]}
                            />
                            <View style={styles.champBadgeSmall}>
                              <Text style={styles.champBadgeSmallText}>C</Text>
                            </View>
                          </View>
                          <View style={{ marginLeft: 2 }}>
                            <Image source={{ uri: champMemberBUri }} style={styles.champAvatarSmall} />
                            <View style={styles.champBadgeSmall}>
                              <Text style={styles.champBadgeSmallText}>C</Text>
                            </View>
                          </View>
                        </View>
                      ) : (
                        <View style={styles.champAvatarWrap}>
                          <Image
                            source={{ uri: champUri }}
                            style={[styles.champAvatar, showShinyCup && styles.champAvatarShinyRing]}
                          />
                          {showShinyCup ? (
                            <View style={styles.shinyCupMark} accessibilityLabel="Copa Shiny">
                              <Text style={styles.shinyCupMarkTxt}>✨</Text>
                            </View>
                          ) : null}
                          <View style={styles.champBadge}>
                            <Text style={styles.champBadgeText}>C</Text>
                          </View>
                        </View>
                      )
                    ) : null}
                    {champName ? (
                      <Text style={styles.champName} numberOfLines={1}>
                        {champName}
                      </Text>
                    ) : null}
                  </View>
                ) : null}
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
  champCol: {
    marginLeft: 8,
    alignItems: 'center',
    maxWidth: 76,
  },
  champAvatarWrap: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  champAvatarWrap2HG: {
    width: 64,
    height: 38,
    flexDirection: 'row',
    alignItems: 'center',
  },
  champAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 2,
    borderColor: '#3B82F6',
  },
  champAvatarSmall: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    borderColor: '#3B82F6',
  },
  champAvatarShinyRing: {
    borderColor: '#FBBF24',
    borderWidth: 2.5,
  },
  shinyCupMark: {
    position: 'absolute',
    top: -10,
    alignSelf: 'center',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  shinyCupMarkTxt: {
    fontSize: 14,
    lineHeight: 16,
    textShadowColor: 'rgba(251, 191, 36, 0.8)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 4,
  },
  champBadge: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#FBBF24',
    borderWidth: 1,
    borderColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  champBadgeSmall: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 15,
    height: 15,
    borderRadius: 7,
    backgroundColor: '#FBBF24',
    borderWidth: 1,
    borderColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  champBadgeSmallText: {
    color: '#fff',
    fontSize: 8,
    fontWeight: '800',
    lineHeight: 10,
  },
  champBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
    lineHeight: 12,
  },
  champName: {
    fontSize: 11,
    color: '#6B7280',
    marginTop: 2,
    textAlign: 'center',
    maxWidth: 76,
  },
});

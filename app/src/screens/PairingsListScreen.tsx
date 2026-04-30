import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  RefreshControl,
  Alert,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { avatarPublicUrl } from '../lib/avatarUrl';
import { getPairingStatusLabel } from '../lib/labels';
import type { MtgColor } from '../lib/database.types';

type Props = NativeStackScreenProps<MainStackParamList, 'PairingsList'>;

type PairingRow = {
  id: string;
  participant_a_id: string;
  participant_b_id: string;
  official_winner_participant_id: string | null;
};

type ParticipantRow = {
  id: string;
  user_id: string;
  users:
    | {
        username: string;
        display_name: string;
        custom_avatar_path: string | null;
        default_avatars: { storage_path: string } | { storage_path: string }[] | null;
      }
    | {
        username: string;
        display_name: string;
        custom_avatar_path: string | null;
        default_avatars: { storage_path: string } | { storage_path: string }[] | null;
      }[]
    | null;
};

type ItemView = PairingRow & {
  status: 'in_progress' | 'scheduled' | 'completed';
  aName: string;
  bName: string;
  aAvatar: string | null;
  bAvatar: string | null;
  aColors: MtgColor[];
  bColors: MtgColor[];
  winnerName: string | null;
  winnerAvatar: string | null;
  mine: boolean;
};

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

export default function PairingsListScreen({ route, navigation }: Props) {
  const { eventId } = route.params;
  const [items, setItems] = useState<ItemView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const firstLoadRef = useRef(true);

  const load = useCallback(async () => {
    const meRes = await supabase.auth.getUser();
    const myUserId = meRes.data.user?.id ?? null;

    const [pairingsRes, participantsRes] = await Promise.all([
      supabase
        .from('pairings')
        .select('id, participant_a_id, participant_b_id, official_winner_participant_id')
        .eq('event_id', eventId),
      supabase
        .from('event_participants')
        .select(
          `
          id,
          user_id,
          users!event_participants_user_id_fkey (
            username,
            display_name,
            custom_avatar_path,
            default_avatars (storage_path)
          )
        `
        )
        .eq('event_id', eventId)
        .eq('role', 'player'),
    ]);

    if (pairingsRes.error || participantsRes.error) {
      Alert.alert('Error', 'No se pudieron cargar los enfrentamientos.');
      setItems([]);
      return;
    }

    const pairings = (pairingsRes.data ?? []) as PairingRow[];
    const participants = (participantsRes.data ?? []) as ParticipantRow[];
    const pMap = new Map<string, ParticipantRow>(participants.map((p) => [p.id, p]));

    const pairingIds = pairings.map((p) => p.id);
    const [matchesRes, colorsRes] = await Promise.all([
      pairingIds.length > 0
        ? supabase
            .from('matches')
            .select('pairing_id, status')
            .in('pairing_id', pairingIds)
        : Promise.resolve({ data: [], error: null } as any),
      participants.length > 0
        ? supabase
            .from('participant_colors')
            .select('participant_id, color')
            .in('participant_id', participants.map((p) => p.id))
        : Promise.resolve({ data: [], error: null } as any),
    ]);

    if (matchesRes.error || colorsRes.error) {
      Alert.alert('Error', 'No se pudieron cargar detalles de enfrentamientos.');
      setItems([]);
      return;
    }

    const inProgressByPairing = new Map<string, number>();
    const safeMatches = (matchesRes.data ?? []).filter(
      (x: { pairing_id: string; status: string | null } | null): x is { pairing_id: string; status: string | null } => x != null
    );
    for (const m of safeMatches) {
      const pid = m.pairing_id as string;
      if ((m?.status as string) === 'in_progress') {
        inProgressByPairing.set(pid, (inProgressByPairing.get(pid) ?? 0) + 1);
      }
    }

    const colorsByParticipant: Record<string, MtgColor[]> = {};
    for (const row of colorsRes.data ?? []) {
      const pid = row.participant_id as string;
      if (!colorsByParticipant[pid]) colorsByParticipant[pid] = [];
      colorsByParticipant[pid].push(row.color as MtgColor);
    }

    const mapped: ItemView[] = pairings.map((pairing) => {
      const pa = pMap.get(pairing.participant_a_id);
      const pb = pMap.get(pairing.participant_b_id);
      const ua = relationOne(pa?.users);
      const ub = relationOne(pb?.users);
      const daA = relationOne(ua?.default_avatars);
      const daB = relationOne(ub?.default_avatars);
      const aName = ua?.display_name || ua?.username || 'Jugador A';
      const bName = ub?.display_name || ub?.username || 'Jugador B';
      const aAvatar = ua
        ? avatarPublicUrl(ua.custom_avatar_path) ??
          avatarPublicUrl(daA?.storage_path ?? null)
        : null;
      const bAvatar = ub
        ? avatarPublicUrl(ub.custom_avatar_path) ??
          avatarPublicUrl(daB?.storage_path ?? null)
        : null;
      const inProg = (inProgressByPairing.get(pairing.id) ?? 0) > 0;
      const completed = !!pairing.official_winner_participant_id;
      const status: ItemView['status'] = inProg
        ? 'in_progress'
        : completed
        ? 'completed'
        : 'scheduled';

      const winnerParticipant = pairing.official_winner_participant_id
        ? pMap.get(pairing.official_winner_participant_id)
        : null;
      const winnerUser = relationOne(winnerParticipant?.users);
      const winnerDA = relationOne(winnerUser?.default_avatars);
      const winnerName =
        winnerUser?.display_name || winnerUser?.username || null;
      const winnerAvatar = winnerUser
        ? avatarPublicUrl(winnerUser.custom_avatar_path) ??
          avatarPublicUrl(winnerDA?.storage_path ?? null)
        : null;

      const mine =
        !!myUserId &&
        (pa?.user_id === myUserId || pb?.user_id === myUserId);

      return {
        ...pairing,
        status,
        aName,
        bName,
        aAvatar,
        bAvatar,
        aColors: colorsByParticipant[pairing.participant_a_id] ?? [],
        bColors: colorsByParticipant[pairing.participant_b_id] ?? [],
        winnerName,
        winnerAvatar,
        mine,
      };
    });

    const rankStatus = (s: ItemView['status']) =>
      s === 'in_progress' ? 0 : s === 'scheduled' ? 1 : 2;

    mapped.sort((x, y) => {
      const s = rankStatus(x.status) - rankStatus(y.status);
      if (s !== 0) return s;
      if (x.mine !== y.mine) return x.mine ? -1 : 1;
      const n = `${x.aName} ${x.bName}`.localeCompare(`${y.aName} ${y.bName}`, 'es', {
        sensitivity: 'base',
      });
      return n;
    });

    setItems(mapped);
  }, [eventId]);

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

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  return (
    <FlatList
      data={items}
      keyExtractor={(it) => it.id}
      contentContainerStyle={items.length === 0 ? styles.emptyWrap : styles.listWrap}
      ListEmptyComponent={<Text style={styles.empty}>Todavía no hay enfrentamientos.</Text>}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      renderItem={({ item }) => (
        <TouchableOpacity
          style={styles.card}
          onPress={() => navigation.navigate('PairingDetail', { pairingId: item.id })}
        >
          <View style={styles.row}>
            <View style={styles.playerCol}>
              {item.aAvatar ? <Image source={{ uri: item.aAvatar }} style={styles.avatar} /> : <View style={[styles.avatar, styles.avatarPh]} />}
              <Text style={styles.name}>{item.aName}</Text>
              <Text style={styles.colors}>{item.aColors.join(' ') || '—'}</Text>
            </View>
            <Text style={styles.vs}>vs</Text>
            <View style={styles.playerCol}>
              {item.bAvatar ? <Image source={{ uri: item.bAvatar }} style={styles.avatar} /> : <View style={[styles.avatar, styles.avatarPh]} />}
              <Text style={styles.name}>{item.bName}</Text>
              <Text style={styles.colors}>{item.bColors.join(' ') || '—'}</Text>
            </View>
          </View>
          <View style={styles.footer}>
            <Text style={styles.status}>{getPairingStatusLabel(item.status)}</Text>
            {item.winnerName ? (
              <View style={styles.winnerWrap}>
                {item.winnerAvatar ? <Image source={{ uri: item.winnerAvatar }} style={styles.winnerAvatar} /> : null}
                <Text style={styles.winnerTxt}>Ganó: {item.winnerName}</Text>
              </View>
            ) : null}
          </View>
        </TouchableOpacity>
      )}
    />
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  listWrap: { padding: 16, paddingBottom: 30 },
  emptyWrap: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  empty: { color: '#666', fontSize: 15 },
  card: {
    backgroundColor: '#fafafa',
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  playerCol: { flex: 1, alignItems: 'center' },
  avatar: { width: 44, height: 44, borderRadius: 10, backgroundColor: '#f3f4f6', marginBottom: 6 },
  avatarPh: { backgroundColor: '#E5E7EB' },
  name: { fontSize: 13, color: '#111', fontWeight: '600', textAlign: 'center' },
  colors: { fontSize: 12, color: '#666', marginTop: 2 },
  vs: { width: 34, textAlign: 'center', fontSize: 14, color: '#666', fontWeight: '700' },
  footer: { marginTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#e8e8e8', paddingTop: 8 },
  status: { color: '#3B82F6', fontWeight: '700', fontSize: 12 },
  winnerWrap: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  winnerAvatar: { width: 20, height: 20, borderRadius: 10, marginRight: 6 },
  winnerTxt: { color: '#166534', fontWeight: '600', fontSize: 12 },
});

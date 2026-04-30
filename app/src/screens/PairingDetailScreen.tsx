import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Image,
  TouchableOpacity,
  Alert,
  RefreshControl,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import type { MtgColor } from '../lib/database.types';
import { avatarPublicUrl } from '../lib/avatarUrl';

type Props = NativeStackScreenProps<MainStackParamList, 'PairingDetail'>;

type PairingInfo = {
  id: string;
  event_id: string;
  participant_a_id: string;
  participant_b_id: string;
  official_winner_participant_id: string | null;
};

type ParticipantRow = {
  id: string;
  user_id: string;
  self_evaluation: number | null;
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

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

export default function PairingDetailScreen({ route }: Props) {
  const { pairingId } = route.params;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [a, setA] = useState<ParticipantRow | null>(null);
  const [b, setB] = useState<ParticipantRow | null>(null);
  const [aColors, setAColors] = useState<MtgColor[]>([]);
  const [bColors, setBColors] = useState<MtgColor[]>([]);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [status, setStatus] = useState<'scheduled' | 'in_progress' | 'completed'>('scheduled');
  const firstRef = useRef(true);

  const load = useCallback(async () => {
    const { data: pData, error: pErr } = await supabase
      .from('pairings')
      .select('id, event_id, participant_a_id, participant_b_id, official_winner_participant_id')
      .eq('id', pairingId)
      .maybeSingle();
    if (pErr || !pData) {
      Alert.alert('Error', 'No se pudo cargar el enfrentamiento.');
      setPairing(null);
      return;
    }
    const p = pData as PairingInfo;
    setPairing(p);

    const [meRes, eventRes, partRes, matchesRes] = await Promise.all([
      supabase.auth.getUser(),
      supabase.from('draft_events').select('workspace_id').eq('id', p.event_id).maybeSingle(),
      supabase
        .from('event_participants')
        .select(
          `
          id,
          user_id,
          self_evaluation,
          users!event_participants_user_id_fkey (
            username,
            display_name,
            custom_avatar_path,
            default_avatars (storage_path)
          )
        `
        )
        .in('id', [p.participant_a_id, p.participant_b_id]),
      supabase.from('matches').select('status').eq('pairing_id', p.id),
    ]);

    setMyUserId(meRes.data.user?.id ?? null);
    if (eventRes.data?.workspace_id) {
      const roleRes = await supabase
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', eventRes.data.workspace_id as string)
        .maybeSingle();
      setIsOrganizer(roleRes.data?.role === 'organizer');
    } else {
      setIsOrganizer(false);
    }

    const participants = (partRes.data ?? []) as ParticipantRow[];
    const map = new Map(participants.map((x) => [x.id, x]));
    const pa = map.get(p.participant_a_id) ?? null;
    const pb = map.get(p.participant_b_id) ?? null;
    setA(pa);
    setB(pb);

    const inProg = (matchesRes.data ?? [])
      .filter(
        (x: { status: string | null } | null): x is { status: string | null } => x != null
      )
      .some((m) => m.status === 'in_progress');
    if (inProg) setStatus('in_progress');
    else if (p.official_winner_participant_id) setStatus('completed');
    else setStatus('scheduled');

    const colorsRes = await supabase
      .from('participant_colors')
      .select('participant_id, color')
      .in('participant_id', [p.participant_a_id, p.participant_b_id]);
    const byP: Record<string, MtgColor[]> = {};
    for (const c of colorsRes.data ?? []) {
      const pid = c.participant_id as string;
      if (!byP[pid]) byP[pid] = [];
      byP[pid].push(c.color as MtgColor);
    }
    setAColors(byP[p.participant_a_id] ?? []);
    setBColors(byP[p.participant_b_id] ?? []);
  }, [pairingId]);

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
  if (!pairing) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>No se encontró el enfrentamiento.</Text>
      </View>
    );
  }

  const au = relationOne(a?.users);
  const bu = relationOne(b?.users);
  const ada = relationOne(au?.default_avatars);
  const bda = relationOne(bu?.default_avatars);
  const aAvatar = au ? avatarPublicUrl(au.custom_avatar_path) ?? avatarPublicUrl(ada?.storage_path ?? null) : null;
  const bAvatar = bu ? avatarPublicUrl(bu.custom_avatar_path) ?? avatarPublicUrl(bda?.storage_path ?? null) : null;
  const aName = au?.display_name || au?.username || 'Jugador A';
  const bName = bu?.display_name || bu?.username || 'Jugador B';
  const isParticipant = !!myUserId && (a?.user_id === myUserId || b?.user_id === myUserId);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
      <View style={styles.hero}>
        <View style={styles.heroRow}>
          {aAvatar ? <Image source={{ uri: aAvatar }} style={styles.heroAvatar} /> : <View style={[styles.heroAvatar, styles.ph]} />}
          <Text style={styles.vs}>vs</Text>
          {bAvatar ? <Image source={{ uri: bAvatar }} style={styles.heroAvatar} /> : <View style={[styles.heroAvatar, styles.ph]} />}
        </View>
        <Text style={styles.heroTitle}>{aName} vs {bName}</Text>
      </View>

      <View style={styles.block}>
        <Text style={styles.blockTitle}>Jugadores</Text>
        <Text style={styles.meta}>{aName} · Colores: {aColors.join(' ') || '—'} · Valoración: {a?.self_evaluation ?? '—'}</Text>
        <Text style={styles.meta}>{bName} · Colores: {bColors.join(' ') || '—'} · Valoración: {b?.self_evaluation ?? '—'}</Text>
      </View>

      <View style={styles.block}>
        <Text style={styles.blockTitle}>Matches</Text>
        <Text style={styles.muted}>Próximamente: listado de matches y Life Tracker.</Text>
      </View>

      {(isParticipant && status === 'scheduled') || isOrganizer ? (
        <View style={styles.block}>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => Alert.alert('Próximamente', 'Próximamente: Life Tracker')}
          >
            <Text style={styles.primaryBtnTxt}>Iniciar partida</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  muted: { color: '#666', fontSize: 14 },
  scroll: { paddingBottom: 30 },
  hero: { padding: 24, alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#eee' },
  heroRow: { flexDirection: 'row', alignItems: 'center' },
  heroAvatar: { width: 72, height: 72, borderRadius: 14, backgroundColor: '#f3f4f6' },
  ph: { backgroundColor: '#E5E7EB' },
  vs: { marginHorizontal: 14, fontWeight: '700', color: '#666', fontSize: 16 },
  heroTitle: { marginTop: 10, fontSize: 18, color: '#111', fontWeight: '700', textAlign: 'center' },
  block: { paddingHorizontal: 24, paddingTop: 18 },
  blockTitle: { fontSize: 16, fontWeight: '700', color: '#111', marginBottom: 8 },
  meta: { fontSize: 14, color: '#666', marginBottom: 4 },
  primaryBtn: { backgroundColor: '#3B82F6', borderRadius: 8, alignItems: 'center', paddingVertical: 12 },
  primaryBtnTxt: { color: '#fff', fontSize: 15, fontWeight: '600' },
});

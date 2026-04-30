import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import { avatarPublicUrl } from '../lib/avatarUrl';

type Props = NativeStackScreenProps<MainStackParamList, 'Standings'>;

type RowView = {
  participantId: string;
  name: string;
  avatar: string | null;
  pg: number;
  pj: number;
  eg: number;
  vm: number;
  tm: number;
  inProgress: boolean;
};

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

export default function StandingsScreen({ route, navigation }: Props) {
  const { eventId } = route.params;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rows, setRows] = useState<RowView[]>([]);
  const firstRef = useRef(true);
  const standingsChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'EventDetail', { eventId }),
    });
  }, [navigation, eventId]);

  const load = useCallback(async () => {
    const [partsRes, pairingsRes] = await Promise.all([
      supabase
        .from('event_participants')
        .select(
          `
          id,
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
      supabase
        .from('pairings')
        .select('id, participant_a_id, participant_b_id, official_winner_participant_id')
        .eq('event_id', eventId),
    ]);
    if (partsRes.error || pairingsRes.error) {
      setRows([]);
      return;
    }

    const participants = partsRes.data ?? [];
    const participantIds = participants.map((p) => p.id as string);
    const pairings = pairingsRes.data ?? [];
    const pairingIds = pairings.map((p) => p.id as string);

    const [matchesRes, lifeRes] = await Promise.all([
      pairingIds.length
        ? supabase
            .from('matches')
            .select('id, pairing_id, winner_participant_id, status, started_at, ended_at')
            .in('pairing_id', pairingIds)
        : Promise.resolve({ data: [], error: null } as any),
      participantIds.length
        ? supabase
            .from('life_events')
            .select('match_id, participant_id, resulting_life, occurred_at')
            .in('participant_id', participantIds)
        : Promise.resolve({ data: [], error: null } as any),
    ]);

    if (matchesRes.error || lifeRes.error) {
      setRows([]);
      return;
    }

    const matches = matchesRes.data ?? [];
    const lifeEvents = lifeRes.data ?? [];
    const rowsBuilt: RowView[] = participants.map((p: any) => {
      const pid = p.id as string;
      const u = relationOne(p.users);
      const da = relationOne(u?.default_avatars);
      const avatar = u ? avatarPublicUrl(u.custom_avatar_path) ?? avatarPublicUrl(da?.storage_path ?? null) : null;
      const name = u?.display_name || u?.username || 'Jugador';

      const playerPairings = pairings.filter((pr: any) => pr.participant_a_id === pid || pr.participant_b_id === pid);
      const pairingSet = new Set(playerPairings.map((x: any) => x.id));
      const playerMatches = matches.filter((m: any) => pairingSet.has(m.pairing_id));
      const completedMatches = playerMatches.filter((m: any) => !!m.winner_participant_id);
      const pg = completedMatches.filter((m: any) => m.winner_participant_id === pid).length;
      const pj = playerMatches.length;
      const eg = playerPairings.filter((pr: any) => pr.official_winner_participant_id === pid).length;
      const inProgress = playerMatches.some((m: any) => m.status === 'in_progress');

      const lifeByMatch: Record<string, { life: number; at: string }> = {};
      for (const ev of lifeEvents) {
        if (ev.participant_id !== pid) continue;
        const mid = String(ev.match_id);
        const at = String(ev.occurred_at);
        if (!lifeByMatch[mid] || lifeByMatch[mid].at < at) {
          lifeByMatch[mid] = { life: Number(ev.resulting_life), at };
        }
      }
      const lifeVals = Object.values(lifeByMatch).map((x) => x.life);
      const vm = lifeVals.length ? lifeVals.reduce((a, b) => a + b, 0) / lifeVals.length : 0;

      const durations = completedMatches
        .filter((m: any) => m.ended_at)
        .map((m: any) => (new Date(m.ended_at as string).getTime() - new Date(m.started_at as string).getTime()) / 1000);
      const tm = durations.length ? durations.reduce((a: number, b: number) => a + b, 0) / durations.length : 0;

      return { participantId: pid, name, avatar, pg, pj, eg, vm, tm, inProgress };
    });

    rowsBuilt.sort((a, b) => {
      if (b.eg !== a.eg) return b.eg - a.eg;
      if (b.pg !== a.pg) return b.pg - a.pg;
      return b.vm - a.vm;
    });
    setRows(rowsBuilt);
  }, [eventId]);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      void (async () => {
        if (firstRef.current) setLoading(true);
        await load();
        if (mounted && firstRef.current) {
          setLoading(false);
          firstRef.current = false;
        }
      })();
      return () => {
        mounted = false;
      };
    }, [load])
  );

  useEffect(() => {
    if (standingsChannelRef.current) return;
    const channel = supabase
      .channel(`standings-live:${eventId}:${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, () => {
        void load();
      })
      .subscribe();
    standingsChannelRef.current = channel;
    return () => {
      void channel.unsubscribe();
      void supabase.removeChannel(channel);
      standingsChannelRef.current = null;
    };
  }, [eventId, load]);

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
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
      <View style={styles.header}>
        <Text style={[styles.cell, styles.playerCol]}>Jugador</Text>
        <Text style={styles.cell}>PG</Text>
        <Text style={styles.cell}>PJ</Text>
        <Text style={styles.cell}>EG</Text>
        <Text style={styles.cell}>VM</Text>
        <Text style={styles.cell}>TM</Text>
      </View>
      {rows.map((r) => (
        <View key={r.participantId} style={styles.row}>
          <View style={[styles.playerCell, styles.playerCol]}>
            {r.avatar ? <Image source={{ uri: r.avatar }} style={styles.avatar} /> : <View style={[styles.avatar, styles.ph]} />}
            <Text style={styles.playerName}>
              {r.inProgress ? <Text style={styles.liveDot}>● </Text> : null}
              {r.name}
            </Text>
          </View>
          <Text style={styles.cell}>{r.pg}</Text>
          <Text style={styles.cell}>{r.pj}</Text>
          <Text style={styles.cell}>{r.eg}</Text>
          <Text style={styles.cell}>{r.vm.toFixed(1)}</Text>
          <Text style={styles.cell}>{Math.round(r.tm)}s</Text>
        </View>
      ))}
      <Text style={styles.legend}>PG: Partidos Ganados · PJ: Partidos Jugados · EG: Enfrentamientos Ganados · VM: Vida Media Final · TM: Tiempo Medio</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  scroll: { padding: 16, paddingBottom: 28 },
  header: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e5e7eb', paddingBottom: 8, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#eee' },
  cell: { width: 42, textAlign: 'center', color: '#111', fontWeight: '700', fontSize: 12 },
  playerCol: { flex: 1, width: 'auto', minWidth: 120, textAlign: 'left' },
  playerCell: { flexDirection: 'row', alignItems: 'center' },
  avatar: { width: 24, height: 24, borderRadius: 12, marginRight: 6 },
  ph: { backgroundColor: '#E5E7EB' },
  playerName: { color: '#111', fontSize: 12, fontWeight: '600' },
  liveDot: { color: '#3B82F6', fontWeight: '700' },
  legend: { marginTop: 12, color: '#666', fontSize: 12 },
});

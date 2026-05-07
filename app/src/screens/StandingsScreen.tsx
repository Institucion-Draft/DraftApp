import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import type { MtgColor } from '../lib/database.types';
import PlayerAvatar from '../components/PlayerAvatar';
import ColorFlag from '../components/ColorFlag';
import { resolveGenderedText, type Gender } from '../lib/genderText';

type Props = NativeStackScreenProps<MainStackParamList, 'Standings'>;

type RowView = {
  participantId: string;
  userId: string;
  name: string;
  colors: MtgColor[];
  pg: number;
  pj: number;
  eg: number;
  /** Enfrentamientos con BO3 cerrado (ganados o perdidos). */
  ec: number;
  /** Diferencial medio de vida; null si no hay ≥2 life_events con duración efectiva > 0. */
  dmv: number | null;
  /** Tiempo medio por partida (s); null si no hay partidas completadas con duración. */
  tmp: number | null;
  inProgress: boolean;
  leftEventAt: string | null;
  gender: Gender | null;
};

type RevengeRowView = {
  participantId: string;
  userId: string;
  name: string;
  colors: MtgColor[];
  vg: number;
  vj: number;
  cv: number;
  sc: number;
  /** Match de venganza en curso en alguno de sus pairings. */
  inProgress: boolean;
  leftEventAt: string | null;
  gender: Gender | null;
};

type LifeEvRow = { match_id: string; participant_id: string; resulting_life: number; occurred_at: string };

const DMV_POS = '#10B981';
const DMV_NEG = '#EF4444';
const DMV_GRAY = '#6B7280';

function parseEventMs(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * DMV del match: promedio temporal de (vida_propia − vida_oponente) entre el primer y último
 * life_event. Solo estados después de cada evento i y antes de i+1 (el post-último evento no cuenta).
 * Peso dur_i / (lastEventTime − firstEventTime); se incluyen todos los diffs, también 0.
 */
function computeMatchDmv(events: LifeEvRow[], myPid: string, oppPid: string): number | null {
  const filtered = events.filter((e) => {
    const pid = String(e.participant_id);
    return pid === myPid || pid === oppPid;
  });
  if (filtered.length < 2) return null;

  const sorted = [...filtered].sort((a, b) => {
    const dt = parseEventMs(String(a.occurred_at)) - parseEventMs(String(b.occurred_at));
    if (dt !== 0) return dt;
    return String(a.participant_id).localeCompare(String(b.participant_id));
  });

  const tFirst = parseEventMs(String(sorted[0]!.occurred_at));
  const tLast = parseEventMs(String(sorted[sorted.length - 1]!.occurred_at));
  const duracionEfectiva = tLast - tFirst;
  if (!Number.isFinite(tFirst) || !Number.isFinite(tLast) || duracionEfectiva <= 0) return null;

  const apply = (ev: LifeEvRow, life: { my: number; opp: number }) => {
    const pid = String(ev.participant_id);
    if (pid === myPid) life.my = Number(ev.resulting_life);
    else life.opp = Number(ev.resulting_life);
  };

  const life = { my: 20, opp: 20 };
  apply(sorted[0]!, life);

  let weightedSum = 0;
  const n = sorted.length;
  for (let i = 0; i < n - 1; i++) {
    const durI = parseEventMs(String(sorted[i + 1]!.occurred_at)) - parseEventMs(String(sorted[i]!.occurred_at));
    const diffI = life.my - life.opp;
    weightedSum += diffI * (durI / duracionEfectiva);
    if (i < n - 2) {
      apply(sorted[i + 1]!, life);
    }
  }

  return weightedSum;
}

function formatDmvCell(dmv: number | null): string {
  if (dmv == null) return '—';
  const rounded = Math.round(dmv * 10) / 10;
  if (rounded > 0) return `+${rounded.toFixed(1)}`;
  if (rounded === 0) return '0.0';
  return rounded.toFixed(1);
}

function dmvCellColor(dmv: number | null): string {
  if (dmv == null) return DMV_GRAY;
  if (dmv > 1e-9) return DMV_POS;
  if (dmv < -1e-9) return DMV_NEG;
  return DMV_GRAY;
}

/** TMP en minutos para la tabla; cálculo interno sigue en segundos. */
function formatTmpDisplay(tmpSeconds: number | null): string {
  if (tmpSeconds == null || !Number.isFinite(tmpSeconds)) return '—';
  const minutes = tmpSeconds / 60;
  if (minutes < 10) {
    return `${minutes.toFixed(1).replace('.', ',')} min`;
  }
  return `${Math.round(minutes)} min`;
}

/** Porcentaje con un decimal y coma (0–100 como fracción del total). */
function formatPctOneDecimal(fraction: number): string {
  if (!Number.isFinite(fraction)) return '0,0%';
  const pct = fraction * 100;
  return `${pct.toFixed(1).replace('.', ',')}%`;
}

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

/** Ciclo ~1.2s; opacidad 1 ↔ 0.3. Usa `View` (no anidar en `Text`) para que `useNativeDriver` componga bien. */
const PULSE_HALF_MS = 600;

function PulsingLiveDot() {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.3, duration: PULSE_HALF_MS, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: PULSE_HALF_MS, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [opacity]);
  return (
    <Animated.View style={[styles.liveDotWrap, { opacity }]} accessibilityLabel="En juego">
      <Text style={styles.liveDot}>●</Text>
    </Animated.View>
  );
}

type Bo3Footer = {
  pct20: string;
  pct21: string;
  bold20: boolean;
  bold21: boolean;
};

type EventFooterStats = { torneo: string | null; bo3: Bo3Footer | null };

export default function StandingsScreen({ route, navigation }: Props) {
  const { eventId } = route.params;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rows, setRows] = useState<RowView[]>([]);
  const [revengeRows, setRevengeRows] = useState<RevengeRowView[]>([]);
  const [tab, setTab] = useState<'official' | 'revenge'>('official');
  const [eventFooter, setEventFooter] = useState<EventFooterStats>({ torneo: null, bo3: null });
  const firstRef = useRef(true);
  const standingsChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'EventDetail', { eventId }),
    });
  }, [navigation, eventId]);

  const load = useCallback(async () => {
    const [partsRes, pairingsRes, eventRes] = await Promise.all([
      supabase
        .from('event_participants')
        .select(
          `
          id,
          user_id,
          left_event_at,
          users!event_participants_user_id_fkey (
            username,
            display_name,
            gender,
            custom_avatar_path,
            default_avatars (storage_path)
          )
        `
        )
        .eq('event_id', eventId)
        .eq('role', 'player'),
      supabase
        .from('pairings')
        .select(
          'id, participant_a_id, participant_b_id, official_winner_participant_id, super_cup_winner_participant_id, revenge_cup_winner_participant_id'
        )
        .eq('event_id', eventId),
      supabase.from('draft_events').select('status').eq('id', eventId).maybeSingle(),
    ]);
    if (partsRes.error || pairingsRes.error) {
      setRows([]);
      setRevengeRows([]);
      setEventFooter({ torneo: null, bo3: null });
      return;
    }

    const participants = partsRes.data ?? [];
    const participantIds = participants.map((p) => p.id as string);
    const colorsRes =
      participantIds.length > 0
        ? await supabase
            .from('participant_colors')
            .select('participant_id, color')
            .in('participant_id', participantIds)
        : { data: [], error: null };
    if (colorsRes.error) {
      setRows([]);
      setRevengeRows([]);
      setEventFooter({ torneo: null, bo3: null });
      return;
    }
    const colorMap: Record<string, MtgColor[]> = {};
    for (const row of colorsRes.data ?? []) {
      const pid = row.participant_id as string;
      if (!colorMap[pid]) colorMap[pid] = [];
      colorMap[pid].push(row.color as MtgColor);
    }
    const pairings = pairingsRes.data ?? [];
    const pairingIds = pairings.map((p) => p.id as string);

    const matchesRes =
      pairingIds.length > 0
        ? await supabase
            .from('matches')
            .select('id, pairing_id, winner_participant_id, status, started_at, ended_at, match_type')
            .in('pairing_id', pairingIds)
        : { data: [], error: null };

    const matches = (matchesRes.data ?? []) as any[];
    const matchIds = matches.map((m) => String(m.id));

    const lifeRes =
      matchIds.length > 0
        ? await supabase
            .from('life_events')
            .select('match_id, participant_id, resulting_life, occurred_at')
            .in('match_id', matchIds)
        : { data: [], error: null };

    if (matchesRes.error || lifeRes.error) {
      setRows([]);
      setRevengeRows([]);
      setEventFooter({ torneo: null, bo3: null });
      return;
    }

    const eventStatus = eventRes.data?.status as string | undefined;
    const totalPairings = pairings.length;
    const resolvedPairings = pairings.filter(
      (pr: any) => pr.official_winner_participant_id != null
    ).length;
    let torneoLine: string | null = null;
    if (eventStatus === 'playing' || eventStatus === 'completed') {
      const frac = totalPairings > 0 ? resolvedPairings / totalPairings : 0;
      torneoLine = `Completitud: ${formatPctOneDecimal(frac)} (${resolvedPairings}/${totalPairings})`;
    }

    let bo3TwoZero = 0;
    let bo3TwoOne = 0;
    for (const pr of pairings as { id: string; official_winner_participant_id: string | null }[]) {
      if (pr.official_winner_participant_id == null) continue;
      const officialCompleted = matches.filter(
        (m: any) =>
          m.pairing_id === pr.id &&
          m.status === 'completed' &&
          (m.match_type === 'draft' || m.match_type === 'final')
      ).length;
      if (officialCompleted === 2) bo3TwoZero += 1;
      else if (officialCompleted === 3) bo3TwoOne += 1;
    }
    const bo3ClosedTotal = bo3TwoZero + bo3TwoOne;
    let bo3Footer: Bo3Footer | null = null;
    if (bo3ClosedTotal > 0) {
      const pct20 = formatPctOneDecimal(bo3TwoZero / bo3ClosedTotal);
      const pct21 = formatPctOneDecimal(bo3TwoOne / bo3ClosedTotal);
      let bold20 = false;
      let bold21 = false;
      if (bo3TwoZero === bo3TwoOne) {
        bold20 = true;
        bold21 = true;
      } else if (bo3TwoZero > bo3TwoOne) {
        bold20 = true;
      } else {
        bold21 = true;
      }
      bo3Footer = { pct20, pct21, bold20, bold21 };
    }
    setEventFooter({ torneo: torneoLine, bo3: bo3Footer });

    const lifeEvents = (lifeRes.data ?? []) as LifeEvRow[];
    const lifeByMatchId = new Map<string, LifeEvRow[]>();
    for (const e of lifeEvents) {
      const mid = String(e.match_id);
      if (!lifeByMatchId.has(mid)) lifeByMatchId.set(mid, []);
      lifeByMatchId.get(mid)!.push(e);
    }

    const rowsBuilt: RowView[] = participants.map((p: any) => {
      const pid = p.id as string;
      const u = relationOne(p.users);
      const name = u?.display_name || u?.username || 'Jugador';
      const userId = p.user_id as string;
      const colors = colorMap[pid] ?? [];
      const gender = (u?.gender as Gender | null | undefined) ?? null;

      const playerPairings = pairings.filter((pr: any) => pr.participant_a_id === pid || pr.participant_b_id === pid);
      const pairingSet = new Set(playerPairings.map((x: any) => x.id));
      const playerMatches = matches.filter((m: any) => pairingSet.has(m.pairing_id));
      const completedMatches = playerMatches.filter((m: any) => !!m.winner_participant_id);
      const pg = completedMatches.filter((m: any) => m.winner_participant_id === pid).length;
      const pj = completedMatches.length;
      const eg = playerPairings.filter((pr: any) => pr.official_winner_participant_id === pid).length;
      const ec = playerPairings.filter((pr: any) => pr.official_winner_participant_id != null).length;
      const inProgress = playerMatches.some(
        (m: any) =>
          m.status === 'in_progress' && (m.match_type === 'draft' || m.match_type === 'final')
      );
      const leftEventAt = (p.left_event_at as string | null) ?? null;

      const matchDmvs: number[] = [];
      for (const m of playerMatches) {
        if (m.status !== 'completed') continue;
        const mid = String(m.id);
        const evs = lifeByMatchId.get(mid) ?? [];
        if (evs.length === 0) continue;
        const pr = pairings.find((x: any) => x.id === m.pairing_id);
        if (!pr) continue;
        const pa = pr.participant_a_id as string;
        const pb = pr.participant_b_id as string;
        if (pid !== pa && pid !== pb) continue;
        const opp = pid === pa ? pb : pa;
        const mdv = computeMatchDmv(evs, pid, opp);
        if (mdv != null) matchDmvs.push(mdv);
      }
      const dmv = matchDmvs.length > 0 ? matchDmvs.reduce((a, b) => a + b, 0) / matchDmvs.length : null;

      const durations = completedMatches
        .filter((m: any) => m.ended_at)
        .map((m: any) => (new Date(m.ended_at as string).getTime() - new Date(m.started_at as string).getTime()) / 1000);
      const tmp =
        durations.length > 0 ? durations.reduce((a: number, b: number) => a + b, 0) / durations.length : null;

      return { participantId: pid, userId, name, colors, pg, pj, eg, ec, dmv, tmp, inProgress, leftEventAt, gender };
    });

    rowsBuilt.sort((a, b) => {
      if (b.eg !== a.eg) return b.eg - a.eg;
      if (b.pg !== a.pg) return b.pg - a.pg;
      const av = a.dmv ?? -Infinity;
      const bv = b.dmv ?? -Infinity;
      return bv - av;
    });
    setRows(rowsBuilt);

    const revengeRowsBuilt: RevengeRowView[] = participants.map((p: any) => {
      const pid = p.id as string;
      const u = relationOne(p.users);
      const name = u?.display_name || u?.username || 'Jugador';
      const userId = p.user_id as string;
      const colors = colorMap[pid] ?? [];
      const gender = (u?.gender as Gender | null | undefined) ?? null;

      const playerPairings = pairings.filter((pr: any) => pr.participant_a_id === pid || pr.participant_b_id === pid);
      const pairingSet = new Set(playerPairings.map((x: any) => x.id));
      const playerMatches = matches.filter((m: any) => pairingSet.has(m.pairing_id));

      const revengeCompleted = playerMatches.filter(
        (m: any) => m.match_type === 'revenge' && m.status === 'completed'
      );
      const vj = revengeCompleted.length;
      const vg = revengeCompleted.filter((m: any) => m.winner_participant_id === pid).length;

      const cv = playerPairings.filter((pr: any) => pr.revenge_cup_winner_participant_id === pid).length;
      const sc = playerPairings.filter((pr: any) => pr.super_cup_winner_participant_id === pid).length;

      const inProgress = playerMatches.some(
        (m: any) => m.status === 'in_progress' && m.match_type === 'revenge'
      );
      const leftEventAt = (p.left_event_at as string | null) ?? null;

      return { participantId: pid, userId, name, colors, vg, vj, cv, sc, inProgress, leftEventAt, gender };
    });

    const revengeFiltered = revengeRowsBuilt.filter((r) => r.vj > 0);
    revengeFiltered.sort((a, b) => {
      const ra = a.vj > 0 ? a.vg / a.vj : 0;
      const rb = b.vj > 0 ? b.vg / b.vj : 0;
      if (rb !== ra) return rb - ra;
      return b.vg - a.vg;
    });
    setRevengeRows(revengeFiltered);
    if (revengeFiltered.length === 0) {
      setTab('official');
    }
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
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pairings', filter: `event_id=eq.${eventId}` },
        () => {
          void load();
        }
      )
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
      {revengeRows.length > 0 ? (
        <View style={styles.tabsRow}>
          <TouchableOpacity style={styles.tabBtn} onPress={() => setTab('official')} activeOpacity={0.7}>
            <Text style={[styles.tabLabel, tab === 'official' && styles.tabLabelActive]}>Oficial</Text>
            <View style={[styles.tabUnderline, tab !== 'official' && styles.tabUnderlineHidden]} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.tabBtn} onPress={() => setTab('revenge')} activeOpacity={0.7}>
            <Text style={[styles.tabLabel, tab === 'revenge' && styles.tabLabelActive]}>Venganzas</Text>
            <View style={[styles.tabUnderline, tab !== 'revenge' && styles.tabUnderlineHidden]} />
          </TouchableOpacity>
        </View>
      ) : null}

      {tab === 'official' ? (
        <>
          <View style={styles.header}>
            <Text style={[styles.cell, styles.playerCol]}>Jugador</Text>
            <Text style={[styles.cell, styles.statCol]}>PG</Text>
            <Text style={[styles.cell, styles.statCol]}>PJ</Text>
            <Text style={[styles.cell, styles.statCol]}>EG</Text>
            <Text style={[styles.cell, styles.statCol]}>EC</Text>
            <Text style={[styles.cell, styles.dmvCol]}>DMV</Text>
            <Text style={[styles.cell, styles.tmpCol]}>TMP</Text>
          </View>
          {rows.map((r) => (
            <TouchableOpacity
              key={r.participantId}
              style={[styles.row, r.leftEventAt ? styles.rowLeftEvent : null]}
              activeOpacity={0.7}
              onPress={() =>
                navigation.navigate('PlayerProfileInEvent', {
                  eventId,
                  participantId: r.participantId,
                  from: 'Standings',
                })
              }
            >
              <View style={[styles.playerCell, styles.playerCol]}>
                <PlayerAvatar
                  userId={r.userId}
                  participantId={r.participantId}
                  size="tiny"
                  withColorBorder={false}
                  style={styles.standingsAvatar}
                />
                <View style={styles.playerNameRow}>
                  <View style={styles.playerNameInner}>
                    {r.inProgress ? <PulsingLiveDot /> : null}
                    <Text style={styles.playerName} numberOfLines={2}>
                      {r.name}{r.leftEventAt ? ' *' : ''}
                    </Text>
                  </View>
                  <ColorFlag colors={r.colors} />
                </View>
              </View>
              <Text style={[styles.cell, styles.statCol]}>{r.pg}</Text>
              <Text style={[styles.cell, styles.statCol]}>{r.pj}</Text>
              <Text style={[styles.cell, styles.statCol]}>{r.eg}</Text>
              <Text style={[styles.cell, styles.statCol]}>{r.ec}</Text>
              <Text style={[styles.cell, styles.dmvCol, { color: dmvCellColor(r.dmv) }]}>{formatDmvCell(r.dmv)}</Text>
              <Text style={[styles.cell, styles.tmpCol]} numberOfLines={1}>
                {formatTmpDisplay(r.tmp)}
              </Text>
            </TouchableOpacity>
          ))}
        </>
      ) : (
        <>
          <View style={styles.header}>
            <Text style={[styles.cell, styles.playerCol]}>Jugador</Text>
            <Text style={[styles.cell, styles.statCol]}>VG</Text>
            <Text style={[styles.cell, styles.statCol]}>VJ</Text>
            <Text style={[styles.cell, styles.statCol]}>CV</Text>
            <Text style={[styles.cell, styles.statCol]}>SC</Text>
          </View>
          {revengeRows.map((r) => (
            <TouchableOpacity
              key={r.participantId}
              style={styles.row}
              activeOpacity={0.7}
              onPress={() =>
                navigation.navigate('PlayerProfileInEvent', {
                  eventId,
                  participantId: r.participantId,
                  from: 'Standings',
                })
              }
            >
              <View style={[styles.playerCell, styles.playerCol]}>
                <PlayerAvatar
                  userId={r.userId}
                  participantId={r.participantId}
                  size="tiny"
                  withColorBorder={false}
                  style={styles.standingsAvatar}
                />
                <View style={styles.playerNameRow}>
                  <View style={styles.playerNameInner}>
                    {r.inProgress ? <PulsingLiveDot /> : null}
                    <Text style={styles.playerName} numberOfLines={2}>
                      {r.name}
                    </Text>
                  </View>
                  <ColorFlag colors={r.colors} />
                </View>
              </View>
              <Text style={[styles.cell, styles.statCol]}>{r.vg}</Text>
              <Text style={[styles.cell, styles.statCol]}>{r.vj}</Text>
              <Text style={[styles.cell, styles.statCol]}>{r.cv}</Text>
              <Text style={[styles.cell, styles.statCol]}>{r.sc}</Text>
            </TouchableOpacity>
          ))}
        </>
      )}

      <View style={styles.legendLiveRow}>
        <Text style={styles.legendStaticDot}>●</Text>
        <Text style={styles.legendLiveCaption}> En juego</Text>
      </View>
      {tab === 'official' && (eventFooter.torneo || eventFooter.bo3) ? (
        <View style={styles.tourneyMeta}>
          <View style={styles.tourneyMetaRow}>
            {eventFooter.torneo ? (
              <Text style={[styles.tourneyMetaLine, styles.tourneyMetaLeft]}>{eventFooter.torneo}</Text>
            ) : (
              <View style={styles.tourneyMetaLeftSpacer} />
            )}
            {eventFooter.bo3 ? (
              <Text style={styles.tourneyMetaRight}>
                <Text style={eventFooter.bo3.bold20 ? styles.tourneyMetaBo3Bold : styles.tourneyMetaBo3Norm}>
                  E_2-0: {eventFooter.bo3.pct20}
                </Text>
                <Text style={styles.tourneyMetaBo3Sep}>{'  '}</Text>
                <Text style={eventFooter.bo3.bold21 ? styles.tourneyMetaBo3Bold : styles.tourneyMetaBo3Norm}>
                  E_2-1: {eventFooter.bo3.pct21}
                </Text>
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
      <Text style={styles.legend}>
        {tab === 'official'
          ? [
              'PG: Partidas Ganadas · PJ: Partidas Jugadas Completadas · EG: Enfrentamientos Ganados (BO3) · EC: Enfrentamientos Completados · DMV: Diferencial Medio de Vida · TMP: Tiempo Medio por Partida',
              'E_2-0: Porcentaje de Enfrentamientos definidos en 2 partidas',
              'E_2-1: Porcentaje de Enfrentamientos definidos en 3 partidas',
              '* Se fue antes de completar sus enfrentamientos',
            ].join('\n')
          : 'VG: Venganzas Ganadas · VJ: Venganzas Jugadas Completadas · CV: Copas Venganza ganadas · SC: Súper Copas ganadas'}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  scroll: { padding: 16, paddingBottom: 28 },
  tabsRow: {
    flexDirection: 'row',
    marginBottom: 12,
    marginTop: -4,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  tabBtn: { marginRight: 22, paddingBottom: 4 },
  tabLabel: { fontSize: 15, fontWeight: '600', color: '#6B7280' },
  tabLabelActive: { color: '#111827', fontWeight: '800' },
  tabUnderline: { height: 2, backgroundColor: '#3B82F6', borderRadius: 1, marginTop: 6 },
  tabUnderlineHidden: { backgroundColor: 'transparent' },
  header: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e5e7eb', paddingBottom: 8, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#eee' },
  rowLeftEvent: { opacity: 0.5 },
  cell: { textAlign: 'center', color: '#111', fontWeight: '700', fontSize: 12 },
  tmpCol: { width: 50, minWidth: 50, fontSize: 10 },
  playerCol: { flex: 1, width: 'auto', minWidth: 108, textAlign: 'left' },
  statCol: { width: 34, minWidth: 34, fontSize: 11 },
  dmvCol: { width: 40, minWidth: 40, fontSize: 11 },
  playerCell: { flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0 },
  standingsAvatar: { marginRight: 6 },
  playerNameRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  playerNameInner: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 4 },
  playerName: { flex: 1, flexShrink: 1, color: '#111', fontSize: 12, fontWeight: '600' },
  liveDotWrap: { justifyContent: 'center' },
  liveDot: { color: '#3B82F6', fontWeight: '700', fontSize: 12 },
  tourneyMeta: {
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E5E7EB',
  },
  tourneyMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  tourneyMetaLine: { color: '#111827', fontSize: 11, fontWeight: '700' },
  tourneyMetaLeft: { flex: 1, flexGrow: 1, minWidth: 120, paddingRight: 6 },
  tourneyMetaLeftSpacer: { flex: 1, minWidth: 0 },
  tourneyMetaRight: { flexShrink: 1, textAlign: 'right', color: '#374151', fontSize: 11 },
  tourneyMetaBo3Norm: { color: '#374151', fontWeight: '400' },
  tourneyMetaBo3Bold: { color: '#374151', fontWeight: '700' },
  tourneyMetaBo3Sep: { color: '#374151', fontWeight: '400' },
  legendLiveRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  legendStaticDot: { color: '#3B82F6', fontWeight: '700', fontSize: 11 },
  legendLiveCaption: { color: '#6B7280', fontSize: 11 },
  legend: { marginTop: 10, color: '#666', fontSize: 12 },
});

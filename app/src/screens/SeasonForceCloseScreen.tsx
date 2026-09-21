import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { fetchPointTiers, pointsForPosition, type PointTier } from '../lib/pointConfig';
import { fetchEventPodium, podiumToPositions, type SecuredPosition } from '../lib/eventPodium';
import {
  SEASON_COLUMNS,
  closeSeasonIfReady,
  fetchIsWorkspaceOrganizer,
  fetchUnfinishedEvents,
  forceCloseSeason,
  type SeasonRow,
  type UnfinishedEvent,
} from '../lib/seasons';
import { getEventStatusLabel } from '../lib/labels';
import type { EventStatus } from '../lib/database.types';

type Props = NativeStackScreenProps<MainStackParamList, 'SeasonForceClose'>;

type PreviewStep = { rank: number; players: { userId: string; name: string; points: number }[] };

type EventPreview = {
  event: UnfinishedEvent;
  /** false si no se pudo calcular el podio del evento (no se envía nada de ese evento hasta reintentar). */
  computed: boolean;
  steps: PreviewStep[];
  positions: SecuredPosition[];
};

type ScreenState =
  | { kind: 'loading'; progress: string }
  | { kind: 'blocked'; message: string }
  | { kind: 'ready'; season: SeasonRow; previews: EventPreview[] };

const MEDAL: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

export default function SeasonForceCloseScreen({ navigation, route }: Props) {
  const { workspaceId, seasonId } = route.params;
  const { user } = useAuth();
  const [state, setState] = useState<ScreenState>({ kind: 'loading', progress: 'Cargando temporada…' });
  const [submitting, setSubmitting] = useState(false);
  const runIdRef = useRef(0);

  const load = useCallback(async () => {
    const runId = ++runIdRef.current;
    const stale = () => runId !== runIdRef.current;
    setState({ kind: 'loading', progress: 'Cargando temporada…' });

    const seasonRes = await supabase.from('v_seasons').select(SEASON_COLUMNS).eq('season_id', seasonId).maybeSingle();
    const season = (seasonRes.data ?? null) as SeasonRow | null;
    if (stale()) return;
    if (!season) {
      setState({ kind: 'blocked', message: 'No se encontró la temporada.' });
      return;
    }
    if (season.phase === 'closed') {
      setState({ kind: 'blocked', message: 'Esta temporada ya está cerrada.' });
      return;
    }
    if (season.phase !== 'finishing') {
      setState({ kind: 'blocked', message: 'Solo se puede cerrar una temporada que ya terminó y sigue pendiente.' });
      return;
    }

    const organizer = user?.id ? await fetchIsWorkspaceOrganizer(workspaceId, user.id) : false;
    if (stale()) return;
    if (!organizer) {
      setState({ kind: 'blocked', message: 'Solo un organizador del grupo puede cerrar la temporada.' });
      return;
    }

    const events = await fetchUnfinishedEvents(seasonId);
    if (stale()) return;
    if (events == null) {
      setState({ kind: 'blocked', message: 'No se pudieron cargar los eventos inconclusos. Probá de nuevo.' });
      return;
    }
    if (events.length === 0) {
      // Se resolvió todo mientras tanto: la temporada se cierra sola, sin forzar nada.
      await closeSeasonIfReady(seasonId);
      if (stale()) return;
      setState({ kind: 'blocked', message: 'Ya no quedan eventos inconclusos: la temporada se cierra sola.' });
      return;
    }

    const tiers: PointTier[] = await fetchPointTiers(season.point_config_id);
    const previews: EventPreview[] = [];
    for (let i = 0; i < events.length; i += 1) {
      if (stale()) return;
      setState({ kind: 'loading', progress: `Calculando podios asegurados (${i + 1}/${events.length})…` });
      const ev = events[i];
      const result = await fetchEventPodium(ev.event_id);
      if (result == null) {
        previews.push({ event: ev, computed: false, steps: [], positions: [] });
        continue;
      }
      const steps: PreviewStep[] = result.podium.steps
        .filter((s) => s.players.length > 0)
        .map((s) => ({
          rank: s.rank,
          players: s.players.map((p) => ({
            userId: p.userId,
            name: p.name,
            points: pointsForPosition(tiers, result.playerCount, s.rank),
          })),
        }));
      previews.push({ event: ev, computed: true, steps, positions: podiumToPositions(ev.event_id, result.podium) });
    }
    if (stale()) return;
    setState({ kind: 'ready', season, previews });
  }, [seasonId, workspaceId, user?.id]);

  useEffect(() => {
    void load();
    return () => {
      runIdRef.current += 1;
    };
  }, [load]);

  const submit = async (previews: EventPreview[]) => {
    setSubmitting(true);
    const positions = previews.flatMap((p) => p.positions);
    const result = await forceCloseSeason(seasonId, positions);
    setSubmitting(false);

    if (result.ok) {
      Alert.alert(
        result.alreadyClosed ? 'Temporada ya cerrada' : 'Temporada cerrada',
        result.alreadyClosed
          ? 'La temporada se cerró mientras revisabas (se resolvieron los eventos pendientes).'
          : 'Los podios asegurados quedaron congelados en el resultado de la temporada.'
      );
      navigation.goBack();
      return;
    }
    Alert.alert('No se pudo cerrar', result.message);
    if (result.code === 'event_not_unfinished' || result.code === 'not_a_player' || result.code === 'invalid_positions') {
      void load();
    }
  };

  const confirm = (previews: EventPreview[]) => {
    Alert.alert(
      'Cerrar temporada de todos modos',
      'Se congelan los podios asegurados de los eventos inconclusos y la temporada queda cerrada. No se puede deshacer, y si esos eventos terminan después, el resultado de esta temporada no cambia.',
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Cerrar y congelar', style: 'destructive', onPress: () => void submit(previews) },
      ]
    );
  };

  if (state.kind === 'loading') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#3B82F6" />
        <Text style={styles.progress}>{state.progress}</Text>
      </View>
    );
  }

  if (state.kind === 'blocked') {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>{state.message}</Text>
        <TouchableOpacity style={styles.secondaryBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.secondaryBtnText}>Volver</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const { season, previews } = state;
  const allComputed = previews.every((p) => p.computed);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      <Text style={styles.title}>Cerrar {season.name}</Text>
      <Text style={styles.lead}>
        Estos eventos siguen inconclusos. Al cerrar, cada uno aporta a la temporada solo las posiciones que su
        podio ya tiene aseguradas hoy; lo que no está asegurado no suma.
      </Text>

      {previews.map((p) => (
        <View key={p.event.event_id} style={styles.card}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {p.event.event_name}
          </Text>
          <Text style={styles.cardStatus}>{getEventStatusLabel(p.event.status as EventStatus)}</Text>
          {!p.computed ? (
            <Text style={styles.errorTxt}>No se pudo calcular el podio de este evento.</Text>
          ) : p.steps.length === 0 ? (
            <Text style={styles.emptyTxt}>Sin posiciones aseguradas: este evento no suma puntos.</Text>
          ) : (
            p.steps.map((s) => (
              <View key={s.rank}>
                {s.players.map((pl) => (
                  <View key={pl.userId} style={styles.playerRow}>
                    <Text style={styles.medal}>{MEDAL[s.rank] ?? `${s.rank}°`}</Text>
                    <Text style={styles.playerName} numberOfLines={1}>
                      {pl.name}
                    </Text>
                    <Text style={styles.playerPts}>+{pl.points}</Text>
                  </View>
                ))}
              </View>
            ))
          )}
        </View>
      ))}

      <View style={styles.warning}>
        <Text style={styles.warningTxt}>
          Irreversible. Si esos eventos se resuelven después, el resultado de esta temporada no cambia (el
          Ranking Global sí ve el resultado real).
        </Text>
      </View>

      {!allComputed ? (
        <Text style={styles.errorTxt}>
          Falló el cálculo de algún evento: no se puede cerrar hasta que se calculen todos.
        </Text>
      ) : null}

      <TouchableOpacity
        style={[styles.confirmBtn, (!allComputed || submitting) && styles.confirmBtnDisabled]}
        disabled={!allComputed || submitting}
        onPress={() => confirm(previews)}
        accessibilityRole="button"
      >
        {submitting ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.confirmBtnText}>Cerrar temporada de todos modos</Text>
        )}
      </TouchableOpacity>
      <TouchableOpacity style={styles.secondaryBtn} onPress={() => void load()} disabled={submitting}>
        <Text style={styles.secondaryBtnText}>Recalcular podios</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  scroll: { padding: 16, paddingBottom: 40 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  progress: { marginTop: 12, fontSize: 13, color: '#6B7280', textAlign: 'center' },
  muted: { fontSize: 15, color: '#666', textAlign: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: '800', color: '#111' },
  lead: { fontSize: 13, color: '#4B5563', lineHeight: 19, marginTop: 6, marginBottom: 14 },
  card: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    backgroundColor: '#FAFAFA',
  },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#111' },
  cardStatus: { fontSize: 12, color: '#6B7280', marginBottom: 6 },
  emptyTxt: { fontSize: 13, color: '#9CA3AF', fontStyle: 'italic' },
  errorTxt: { fontSize: 13, color: '#B91C1C', marginTop: 4, marginBottom: 6 },
  playerRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 3, gap: 8 },
  medal: { fontSize: 18, width: 26, textAlign: 'center' },
  playerName: { flex: 1, fontSize: 14, color: '#111' },
  playerPts: { fontSize: 14, fontWeight: '700', color: '#3B82F6' },
  warning: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 10,
    padding: 12,
    marginTop: 4,
    marginBottom: 12,
  },
  warningTxt: { fontSize: 13, color: '#991B1B', lineHeight: 18 },
  confirmBtn: { backgroundColor: '#DC2626', borderRadius: 8, paddingVertical: 13, alignItems: 'center' },
  confirmBtnDisabled: { opacity: 0.45 },
  confirmBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  secondaryBtn: {
    marginTop: 10,
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#F3F4F6',
  },
  secondaryBtnText: { color: '#374151', fontSize: 14, fontWeight: '600' },
});

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
  Animated,
  Switch,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import { useTheme, useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';
import {
  DEFAULT_CUBE_WEIGHT_PARAMS,
  cubeRouletteProbabilities,
  formatPercent1,
  pickWeighted,
  sanitizeCubeWeightParams,
  type CubeWeightParams,
} from '../lib/cubeRouletteWeights';
import { cubeGridColumns, cubeJumpPath } from '../lib/cubeRouletteGrid';

type Props = NativeStackScreenProps<MainStackParamList, 'CubeRoulette'>;
type RouletteType = 'cubes' | 'players';

type CubeRow = { id: string; name: string };
type PlayerRow = { user_id: string; users: { display_name: string; username: string } | null | { display_name: string; username: string }[] };

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

export default function CubeRouletteScreen({ route, navigation }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { eventId } = route.params;
  const [loading, setLoading] = useState(true);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [cubes, setCubes] = useState<CubeRow[]>([]);
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [rouletteType, setRouletteType] = useState<RouletteType>('cubes');
  const [highlightIndex, setHighlightIndex] = useState<number | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [resultCubeName, setResultCubeName] = useState<string | null>(null);
  const [manualCubePickerForUserId, setManualCubePickerForUserId] = useState<string | null>(null);
  const [selectedCubeId, setSelectedCubeId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  // Probabilidades pesadas (sólo ruleta de cubos). Estado local: no se persiste. La ruleta de jugadores nunca las usa.
  const [weighted, setWeighted] = useState(true);
  const [weightParams, setWeightParams] = useState<CubeWeightParams>(DEFAULT_CUBE_WEIGHT_PARAMS);
  const [cubeHistory, setCubeHistory] = useState<string[]>([]);
  const [gridWidth, setGridWidth] = useState(0);
  const pulse = useRef(new Animated.Value(1)).current;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'EventDetail', {
        eventId,
        workspaceId: workspaceId ?? undefined,
      }),
    });
  }, [navigation, eventId, workspaceId]);

  const load = useCallback(async () => {
    const [eventRes, meRes] = await Promise.all([
      supabase.from('draft_events').select('workspace_id, scheduled_for').eq('id', eventId).maybeSingle(),
      supabase.auth.getUser(),
    ]);
    if (eventRes.error || !eventRes.data) {
      Alert.alert('Error', 'No se pudo cargar el evento.');
      return;
    }
    const wsId = eventRes.data.workspace_id as string;
    setWorkspaceId(wsId);
    const currentUserId = meRes.data.user?.id ?? null;
    const eventScheduledFor = (eventRes.data as { scheduled_for?: string | null }).scheduled_for ?? null;

    const [roleRes, cubesRes, playersRes, configRes, historyRes] = await Promise.all([
      currentUserId
        ? supabase
            .from('workspace_members')
            .select('role')
            .eq('workspace_id', wsId)
            .eq('user_id', currentUserId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase.from('cubes').select('id, name').eq('workspace_id', wsId).is('deleted_at', null).order('name', { ascending: true }),
      supabase
        .from('event_participants')
        .select('user_id, users!event_participants_user_id_fkey (display_name, username)')
        .eq('event_id', eventId)
        .eq('role', 'player'),
      supabase
        .from('workspace_cube_roulette_config')
        .select('m, k, tau_min, accumulation_mode')
        .eq('workspace_id', wsId)
        .maybeSingle(),
      // Historial para el peso: eventos oficiales, no borrados ni cancelados, del workspace, que ya arrancaron el draft
      // (draft_started_at o estado distinto de 'scheduled', como isDraftStarted) con cubo registrado, anteriores a éste.
      // Cuenta el cubo registrado en el evento (cube_id), no lo que salió en la ruleta. Del más reciente al más antiguo.
      (() => {
        let q = supabase
          .from('draft_events')
          .select('cube_id')
          .eq('workspace_id', wsId)
          .neq('id', eventId)
          .eq('is_official', true)
          .is('deleted_at', null)
          .neq('status', 'cancelled')
          .not('cube_id', 'is', null)
          .or('draft_started_at.not.is.null,status.neq.scheduled');
        if (eventScheduledFor) q = q.lte('scheduled_for', eventScheduledFor);
        return q.order('scheduled_for', { ascending: false }).order('created_at', { ascending: false }).limit(200);
      })(),
    ]);

    if (roleRes.error) {
      if (__DEV__) {
        console.error('Error cargando rol del workspace:', roleRes.error);
      }
    }

    if (cubesRes.error || playersRes.error) {
      Alert.alert('Error', 'No se pudo cargar la ruleta.');
      return;
    }
    setCubes((cubesRes.data ?? []) as CubeRow[]);
    setPlayers((playersRes.data ?? []) as PlayerRow[]);
    // Sin fila, o error al leer el historial/la config: se usan los defaults y/o un historial vacío (todo uniforme).
    setWeightParams(sanitizeCubeWeightParams(configRes.error ? null : configRes.data));
    setCubeHistory(
      historyRes.error ? [] : ((historyRes.data ?? []) as { cube_id: string | null }[]).flatMap((r) => (r.cube_id ? [r.cube_id] : []))
    );
    setIsOrganizer(!roleRes.error && roleRes.data?.role === 'organizer');
  }, [eventId]);

  useFocusEffect(
    useCallback(() => {
      void (async () => {
        setLoading(true);
        await load();
        setLoading(false);
      })();
    }, [load])
  );

  const cubeOptions = useMemo(
    () => [
      ...cubes.map((c) => ({ key: c.id, label: c.name, kind: 'cube' as const })),
      { key: 'player_chooses', label: 'Jugador elige', kind: 'player_chooses' as const },
      { key: 'everyone_smokes', label: 'Todos fuman', kind: 'everyone_smokes' as const },
    ],
    [cubes]
  );

  // Probabilidades de la ruleta de cubos (cubos + "Jugador elige" + "Todos fuman"). Se recalculan sólo si cambia el
  // toggle, los cubos, el historial o los parámetros: volver a tirar tras "Todos fuman" usa las mismas.
  const cubeProbs = useMemo(
    () =>
      cubeRouletteProbabilities(
        cubes.map((c) => c.id),
        cubeHistory,
        weightParams,
        weighted
      ),
    [cubes, cubeHistory, weightParams, weighted]
  );
  const cubeOptionProbs = useMemo(
    () => cubeOptions.map((o) => (o.kind === 'cube' ? cubeProbs.cubes[o.key] ?? 0 : cubeProbs.fixed)),
    [cubeOptions, cubeProbs]
  );

  const playerOptions = useMemo(
    () => [
      ...players.map((p) => {
        const u = relationOne(p.users);
        return {
          key: p.user_id,
          label: u?.display_name || u?.username || 'Jugador',
          kind: 'player' as const,
        };
      }),
      { key: 'roulette_chooses', label: 'Ruleta elige', kind: 'roulette_chooses' as const },
      { key: 'everyone_smokes', label: 'Todos fuman', kind: 'everyone_smokes' as const },
    ],
    [players]
  );

  const options = rouletteType === 'cubes' ? cubeOptions : playerOptions;

  const saveSpin = async (params: {
    roulette_type: RouletteType;
    result_type: 'cube' | 'player_chooses' | 'everyone_smokes' | 'roulette_chooses' | 'player_selected';
    selected_cube_id?: string | null;
    selected_player_user_id?: string | null;
  }) => {
    const meRes = await supabase.auth.getUser();
    const uid = meRes.data.user?.id;
    if (!uid) {
      Alert.alert('Error', 'No hay sesión activa.');
      return false;
    }
    const { error } = await supabase.from('cube_roulette_spins').insert({
      event_id: eventId,
      spun_by: uid,
      roulette_type: params.roulette_type,
      result_type: params.result_type,
      selected_cube_id: params.selected_cube_id ?? null,
      selected_player_user_id: params.selected_player_user_id ?? null,
    });
    if (error) {
      Alert.alert('Error', error.message ?? 'No se pudo registrar la tirada.');
      return false;
    }
    return true;
  };

  const updateEventCube = async (cubeId: string) => {
    const { error } = await supabase.from('draft_events').update({ cube_id: cubeId }).eq('id', eventId);
    if (error) {
      Alert.alert('Error', error.message ?? 'No se pudo actualizar el cubo del evento.');
      return false;
    }
    return true;
  };

  const animatePulse = () => {
    Animated.sequence([
      Animated.timing(pulse, { toValue: 1.06, duration: 120, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 120, useNativeDriver: true }),
    ]).start();
  };

  const spin = async () => {
    if (spinning || options.length === 0) return;
    setSpinning(true);
    setManualCubePickerForUserId(null);
    setSelectedCubeId(null);

    let ticks = 14 + Math.floor(Math.random() * 12);
    let target = -1;
    if (rouletteType === 'cubes') {
      // El resultado se sortea primero (uniforme si el toggle está apagado, ponderado si no) y la animación aterriza ahí.
      target = weighted
        ? pickWeighted(cubeOptionProbs, Math.random())
        : Math.floor(Math.random() * options.length);
      ticks += (((target - ticks) % options.length) + options.length) % options.length;
    }
    // Ruleta de cubos: saltos pseudoaleatorios entre tarjetas que terminan en el resultado ya sorteado (sólo estético).
    // Ruleta de jugadores: recorrido ordenado de siempre.
    const path = rouletteType === 'cubes' ? cubeJumpPath(options.length, ticks, target, highlightIndex) : null;
    let idx = 0;
    for (let i = 0; i < ticks; i += 1) {
      idx = path ? path[i] : (idx + 1) % options.length;
      setHighlightIndex(idx);
      animatePulse();
      await new Promise((r) => setTimeout(r, 45 + i * 8));
    }
    const result = options[idx];
    if (!result) {
      setSpinning(false);
      return;
    }

    if (rouletteType === 'cubes') {
      if (result.kind === 'cube') {
        const okSpin = await saveSpin({
          roulette_type: 'cubes',
          result_type: 'cube',
          selected_cube_id: result.key,
        });
        if (!okSpin) {
          setSpinning(false);
          return;
        }
        const okUpdate = await updateEventCube(result.key);
        if (!okUpdate) {
          setSpinning(false);
          return;
        }
        setResultCubeName(result.label);
      } else if (result.kind === 'player_chooses') {
        await saveSpin({ roulette_type: 'cubes', result_type: 'player_chooses' });
        setRouletteType('players');
      } else {
        await saveSpin({ roulette_type: 'cubes', result_type: 'everyone_smokes' });
      }
    } else {
      if (result.kind === 'player') {
        await saveSpin({
          roulette_type: 'players',
          result_type: 'player_selected',
          selected_player_user_id: result.key,
        });
        setManualCubePickerForUserId(result.key);
      } else if (result.kind === 'roulette_chooses') {
        await saveSpin({ roulette_type: 'players', result_type: 'roulette_chooses' });
        setRouletteType('cubes');
      } else {
        await saveSpin({ roulette_type: 'players', result_type: 'everyone_smokes' });
      }
    }

    setSpinning(false);
  };

  const confirmManualCube = async () => {
    if (!selectedCubeId || !manualCubePickerForUserId) return;
    const chosen = cubes.find((c) => c.id === selectedCubeId);
    const okSpin = await saveSpin({
      roulette_type: 'players',
      result_type: 'cube',
      selected_cube_id: selectedCubeId,
      selected_player_user_id: manualCubePickerForUserId,
    });
    if (!okSpin) return;
    const okUpdate = await updateEventCube(selectedCubeId);
    if (!okUpdate) return;
    setManualCubePickerForUserId(null);
    setSelectedCubeId(null);
    setResultCubeName(chosen?.name ?? 'Sin nombre');
  };

  const resetToInitial = () => {
    setRouletteType('cubes');
    setHighlightIndex(null);
    setSpinning(false);
    setResultCubeName(null);
    setManualCubePickerForUserId(null);
    setSelectedCubeId(null);
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (!isOrganizer) {
    return (
      <View style={styles.centered}>
        <Text style={styles.denied}>
          Solo el organizador puede tirar la ruleta. El resultado se compartirá cuando termine.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      <Text style={styles.title}>
        {rouletteType === 'cubes' ? 'Ruleta de cubos' : 'Ruleta de jugadores'}
      </Text>
      {rouletteType === 'cubes' && !resultCubeName ? (
        <View style={styles.weightRow}>
          <Text style={styles.weightLabel}>Probabilidades pesadas</Text>
          <Switch
            value={weighted}
            onValueChange={setWeighted}
            disabled={spinning}
            trackColor={{ false: colors.border, true: colors.accent }}
          />
        </View>
      ) : null}
      {resultCubeName ? (
        <View style={styles.resultBlock}>
          <Text style={styles.result}>Cubo seleccionado: {resultCubeName}</Text>
          <TouchableOpacity
            style={styles.spinBtn}
            onPress={() => navigation.navigate('EventDetail', { eventId, workspaceId: workspaceId ?? undefined })}
          >
            <Text style={styles.spinTxt}>Volver al evento</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.repeatBtn} onPress={resetToInitial}>
            <Text style={styles.repeatTxt}>Repetir ruleteada</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {rouletteType === 'cubes' ? (
            <View style={styles.grid} onLayout={(e) => setGridWidth(e.nativeEvent.layout.width)}>
              {options.map((o, idx) => {
                const cols = cubeGridColumns(options.length);
                const dense = cols === 4;
                const cardW = gridWidth > 0 ? (gridWidth - GRID_GAP * (cols - 1)) / cols : 0;
                return (
                  <Animated.View
                    key={o.key}
                    style={[
                      styles.card,
                      dense && styles.cardDense,
                      o.kind !== 'cube' && styles.cardSpecial,
                      { width: cardW },
                      highlightIndex === idx && styles.optionActive,
                      highlightIndex === idx ? { transform: [{ scale: pulse }] } : null,
                    ]}
                  >
                    <Text style={[styles.cardTxt, dense && styles.cardTxtDense]} numberOfLines={2} ellipsizeMode="tail">
                      {o.label}
                    </Text>
                    {weighted ? (
                      <Text style={[styles.cardPct, dense && styles.cardPctDense]}>{formatPercent1(cubeOptionProbs[idx] ?? 0)}</Text>
                    ) : null}
                  </Animated.View>
                );
              })}
            </View>
          ) : (
            options.map((o, idx) => (
            <Animated.View
              key={o.key}
              style={[
                styles.option,
                highlightIndex === idx && styles.optionActive,
                highlightIndex === idx ? { transform: [{ scale: pulse }] } : null,
              ]}
            >
              <Text style={styles.optionTxt}>{o.label}</Text>
            </Animated.View>
            ))
          )}

          <TouchableOpacity
            style={[styles.spinBtn, spinning && styles.spinDisabled]}
            onPress={() => void spin()}
            disabled={spinning}
          >
            <Text style={styles.spinTxt}>{spinning ? 'Girando...' : 'Tirar ruleta'}</Text>
          </TouchableOpacity>
        </>
      )}

      {manualCubePickerForUserId && !resultCubeName ? (
        <View style={styles.manualBlock}>
          <Text style={styles.manualTitle}>Seleccionar cubo manualmente</Text>
          {cubes.map((c) => (
            <TouchableOpacity
              key={c.id}
              style={[styles.manualOption, selectedCubeId === c.id && styles.manualOptionActive]}
              onPress={() => setSelectedCubeId(c.id)}
            >
              <Text style={styles.manualTxt}>{c.name}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={[styles.confirmBtn, !selectedCubeId && styles.spinDisabled]}
            disabled={!selectedCubeId}
            onPress={() => void confirmManualCube()}
          >
            <Text style={styles.confirmTxt}>Confirmar cubo elegido</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {!resultCubeName ? (
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.navigate('EventDetail', { eventId, workspaceId: workspaceId ?? undefined })}>
          <Text style={styles.backTxt}>Volver</Text>
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
}

const GRID_GAP = 8;

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    scroll: { padding: 24, paddingBottom: 34 },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: c.background, padding: 24 },
    denied: { color: c.textSecondary, fontSize: 15, textAlign: 'center' },
    title: { fontSize: 22, fontWeight: '700', color: c.text, marginBottom: 14 },
    option: { borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 12, marginBottom: 8, backgroundColor: c.card, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    weightRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
    weightLabel: { color: c.text, fontWeight: '600', fontSize: 15 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP },
    card: { height: 76, borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 6, paddingVertical: 6, backgroundColor: c.card, alignItems: 'center', justifyContent: 'center' },
    cardDense: { height: 66, borderRadius: 10 },
    cardSpecial: { borderStyle: 'dashed', borderColor: c.textSecondary },
    cardTxt: { color: c.text, fontWeight: '600', fontSize: 13, textAlign: 'center' },
    cardTxtDense: { fontSize: 11 },
    cardPct: { color: c.textSecondary, fontWeight: '600', fontSize: 12, marginTop: 2 },
    cardPctDense: { fontSize: 10 },
    optionActive: { borderColor: c.accent, backgroundColor: c.status.info.subtle },
    optionTxt: { color: c.text, fontWeight: '600' },
    spinBtn: { backgroundColor: c.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 10 },
    spinDisabled: { opacity: 0.5 },
    spinTxt: { color: c.onAccent, fontWeight: '700', fontSize: 16 },
    repeatBtn: { marginTop: 10, borderWidth: 1, borderColor: c.status.info.border, backgroundColor: c.status.info.subtle, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
    repeatTxt: { color: c.accent, fontWeight: '700' },
    resultBlock: { marginTop: 6 },
    result: { marginTop: 12, color: c.status.success.text, fontWeight: '600' },
    manualBlock: { marginTop: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.divider, paddingTop: 12 },
    manualTitle: { fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 8 },
    manualOption: { borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 10, marginBottom: 8 },
    manualOptionActive: { borderColor: c.accent, backgroundColor: c.status.info.subtle },
    manualTxt: { color: c.text },
    confirmBtn: { backgroundColor: c.accent, borderRadius: 8, alignItems: 'center', paddingVertical: 11, marginTop: 6 },
    confirmTxt: { color: c.onAccent, fontWeight: '700' },
    backBtn: { marginTop: 18, alignItems: 'center' },
    backTxt: { color: c.textSecondary, fontWeight: '600' },
  });

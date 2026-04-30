import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
  Animated,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';

type Props = NativeStackScreenProps<MainStackParamList, 'CubeRoulette'>;
type RouletteType = 'cubes' | 'players';

type CubeRow = { id: string; name: string };
type PlayerRow = { user_id: string; users: { display_name: string; username: string } | null | { display_name: string; username: string }[] };

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

export default function CubeRouletteScreen({ route, navigation }: Props) {
  const { eventId } = route.params;
  const [loading, setLoading] = useState(true);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [cubes, setCubes] = useState<CubeRow[]>([]);
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [rouletteType, setRouletteType] = useState<RouletteType>('cubes');
  const [highlightIndex, setHighlightIndex] = useState<number | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [showRepeat, setShowRepeat] = useState(false);
  const [manualCubePickerForUserId, setManualCubePickerForUserId] = useState<string | null>(null);
  const [selectedCubeId, setSelectedCubeId] = useState<string | null>(null);
  const pulse = useRef(new Animated.Value(1)).current;

  const load = useCallback(async () => {
    const [eventRes, meRes] = await Promise.all([
      supabase.from('draft_events').select('workspace_id').eq('id', eventId).maybeSingle(),
      supabase.auth.getUser(),
    ]);
    if (eventRes.error || !eventRes.data) {
      Alert.alert('Error', 'No se pudo cargar el evento.');
      return;
    }
    const wsId = eventRes.data.workspace_id as string;

    const [roleRes, cubesRes, playersRes] = await Promise.all([
      supabase.from('workspace_members').select('role').eq('workspace_id', wsId).maybeSingle(),
      supabase.from('cubes').select('id, name').eq('workspace_id', wsId).is('deleted_at', null).order('name', { ascending: true }),
      supabase
        .from('event_participants')
        .select('user_id, users!event_participants_user_id_fkey (display_name, username)')
        .eq('event_id', eventId)
        .eq('role', 'player'),
    ]);

    if (cubesRes.error || playersRes.error) {
      Alert.alert('Error', 'No se pudo cargar la ruleta.');
      return;
    }
    setCubes((cubesRes.data ?? []) as CubeRow[]);
    setPlayers((playersRes.data ?? []) as PlayerRow[]);
    setIsOrganizer(roleRes.data?.role === 'organizer' && !!meRes.data.user?.id);
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
    setShowRepeat(false);
    setLastMessage(null);
    setManualCubePickerForUserId(null);
    setSelectedCubeId(null);

    const ticks = 14 + Math.floor(Math.random() * 12);
    let idx = 0;
    for (let i = 0; i < ticks; i += 1) {
      idx = (idx + 1) % options.length;
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
        setLastMessage(`Cubo seleccionado: ${result.label}`);
      } else if (result.kind === 'player_chooses') {
        await saveSpin({ roulette_type: 'cubes', result_type: 'player_chooses' });
        setRouletteType('players');
        setLastMessage('Jugador elige: ahora tirá la ruleta de jugadores.');
      } else {
        await saveSpin({ roulette_type: 'cubes', result_type: 'everyone_smokes' });
        setLastMessage('Todos fuman, repetir tirada.');
      }
    } else {
      if (result.kind === 'player') {
        await saveSpin({
          roulette_type: 'players',
          result_type: 'player_selected',
          selected_player_user_id: result.key,
        });
        setManualCubePickerForUserId(result.key);
        setLastMessage(`${result.label} elige el cubo. Seleccionalo abajo.`);
      } else if (result.kind === 'roulette_chooses') {
        await saveSpin({ roulette_type: 'players', result_type: 'roulette_chooses' });
        setRouletteType('cubes');
        setLastMessage('Ruleta elige: volvés a la ruleta de cubos.');
      } else {
        await saveSpin({ roulette_type: 'players', result_type: 'everyone_smokes' });
        setLastMessage('Todos fuman, repetir tirada.');
      }
    }

    setShowRepeat(true);
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
    setLastMessage(`Cubo seleccionado: ${chosen?.name ?? 'Sin nombre'}`);
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
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
      <Text style={styles.subtitle}>
        {rouletteType === 'cubes'
          ? 'Opciones: cubos del workspace + Jugador elige + Todos fuman.'
          : 'Opciones: jugadores + Ruleta elige + Todos fuman.'}
      </Text>

      {options.map((o, idx) => (
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
      ))}

      <TouchableOpacity style={[styles.spinBtn, spinning && styles.spinDisabled]} onPress={() => void spin()} disabled={spinning}>
        <Text style={styles.spinTxt}>{spinning ? 'Girando...' : 'Tirar ruleta'}</Text>
      </TouchableOpacity>

      {showRepeat ? (
        <TouchableOpacity style={styles.repeatBtn} onPress={() => void spin()}>
          <Text style={styles.repeatTxt}>Repetir ruleteada</Text>
        </TouchableOpacity>
      ) : null}

      {lastMessage ? <Text style={styles.result}>{lastMessage}</Text> : null}

      {manualCubePickerForUserId ? (
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

      <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
        <Text style={styles.backTxt}>Volver</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  scroll: { padding: 24, paddingBottom: 34 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff', padding: 24 },
  denied: { color: '#666', fontSize: 15, textAlign: 'center' },
  title: { fontSize: 22, fontWeight: '700', color: '#111', marginBottom: 8 },
  subtitle: { color: '#666', marginBottom: 14 },
  option: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, padding: 12, marginBottom: 8, backgroundColor: '#fafafa' },
  optionActive: { borderColor: '#3B82F6', backgroundColor: '#EFF6FF' },
  optionTxt: { color: '#111', fontWeight: '600' },
  spinBtn: { backgroundColor: '#3B82F6', borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 10 },
  spinDisabled: { opacity: 0.5 },
  spinTxt: { color: '#fff', fontWeight: '700', fontSize: 16 },
  repeatBtn: { marginTop: 10, borderWidth: 1, borderColor: '#BFDBFE', backgroundColor: '#EFF6FF', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  repeatTxt: { color: '#3B82F6', fontWeight: '700' },
  result: { marginTop: 12, color: '#166534', fontWeight: '600' },
  manualBlock: { marginTop: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#eee', paddingTop: 12 },
  manualTitle: { fontSize: 15, fontWeight: '700', color: '#111', marginBottom: 8 },
  manualOption: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 8, padding: 10, marginBottom: 8 },
  manualOptionActive: { borderColor: '#3B82F6', backgroundColor: '#EFF6FF' },
  manualTxt: { color: '#111' },
  confirmBtn: { backgroundColor: '#3B82F6', borderRadius: 8, alignItems: 'center', paddingVertical: 11, marginTop: 6 },
  confirmTxt: { color: '#fff', fontWeight: '700' },
  backBtn: { marginTop: 18, alignItems: 'center' },
  backTxt: { color: '#666', fontWeight: '600' },
});

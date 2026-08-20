import React, { useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ActivityIndicator,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { supabase } from '../lib/supabase';
import { type TimerParams, DEFAULT_TIMER_PARAMS } from '../lib/draftTimer';
import { setPendingTimerParams } from '../lib/draftTimerStore';

type Props = NativeStackScreenProps<MainStackParamList, 'DraftTimerConfig'>;

type ParamDef = {
  key: keyof TimerParams;
  label: string;
  symbol: string;
  min: number;
  max: number;
  step: number;
  decimals: number;
};

const PARAMS: ParamDef[] = [
  { key: 'alpha', label: 'Lectura individual', symbol: 'α', min: 0, max: 2, step: 0.1, decimals: 1 },
  { key: 'beta',  label: 'Combinatoria',       symbol: 'β', min: 0, max: 2, step: 0.1, decimals: 1 },
  { key: 'gamma', label: 'Costo de oportunidad', symbol: 'γ', min: 0, max: 2, step: 0.1, decimals: 1 },
  { key: 'delta', label: 'Incertidumbre de identidad', symbol: 'δ', min: 0, max: 2, step: 0.1, decimals: 1 },
  { key: 'rho',   label: 'Reducción por relectura',    symbol: 'ρ', min: 0, max: 0.9, step: 0.1, decimals: 1 },
  { key: 'tMin',  label: 'Tiempo mínimo por pick',     symbol: 'T_min', min: 2, max: 45, step: 1, decimals: 0 },
  { key: 'tMax',  label: 'Tiempo máximo por pick',     symbol: 'T_max', min: 30, max: 300, step: 5, decimals: 0 },
];

function round(v: number, step: number): number {
  return Math.round(v / step) * step;
}

export default function DraftTimerConfigScreen({ route, navigation }: Props) {
  const { timerPacks, numPlayers: initPlayers, mode, eventId } = route.params;

  const [alpha, setAlpha] = useState(route.params.alpha);
  const [beta, setBeta]   = useState(route.params.beta);
  const [gamma, setGamma] = useState(route.params.gamma);
  const [delta, setDelta] = useState(route.params.delta);
  const [rho, setRho]     = useState(route.params.rho);
  const [tMin, setTMin]   = useState(route.params.tMin);
  const [tMax, setTMax]   = useState(route.params.tMax);
  const [numPlayers, setNumPlayers] = useState(initPlayers);
  const [saving, setSaving] = useState(false);

  const getters: Record<keyof TimerParams, number> = { alpha, beta, gamma, delta, rho, tMin, tMax };
  const setters: Record<keyof TimerParams, (v: number) => void> = {
    alpha: setAlpha, beta: setBeta, gamma: setGamma, delta: setDelta,
    rho: setRho, tMin: setTMin, tMax: setTMax,
  };

  const currentParams: TimerParams = { alpha, beta, gamma, delta, rho, tMin, tMax };

  const onReset = () => {
    const d = DEFAULT_TIMER_PARAMS;
    setAlpha(d.alpha); setBeta(d.beta); setGamma(d.gamma);
    setDelta(d.delta); setRho(d.rho); setTMin(d.tMin); setTMax(d.tMax);
  };

  const onSave = async () => {
    if (mode === 'create') {
      setPendingTimerParams(currentParams);
      navigation.goBack();
      return;
    }
    if (!eventId) return;
    setSaving(true);
    const { error } = await supabase.from('draft_events').update({
      timer_alpha: alpha, timer_beta: beta, timer_gamma: gamma,
      timer_delta: delta, timer_rho: rho, timer_tmin: tMin, timer_tmax: tMax,
    }).eq('id', eventId);
    setSaving(false);
    if (error) {
      Alert.alert('Error', error.message ?? 'No se pudieron guardar los parámetros.');
      return;
    }
    navigation.goBack();
  };

  const onSimulate = () => {
    navigation.navigate('DraftTimerSim', {
      timerPacks,
      numPlayers,
      alpha, beta, gamma, delta, rho, tMin, tMax,
    });
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Parámetros del cronómetro</Text>

      {PARAMS.map((pd) => {
        const val = getters[pd.key];
        const setter = setters[pd.key];
        return (
          <View key={pd.key} style={styles.paramRow}>
            <View style={styles.paramLabels}>
              <Text style={styles.paramSymbol}>{pd.symbol}</Text>
              <Text style={styles.paramName}>{pd.label}</Text>
            </View>
            <View style={styles.stepper}>
              <TouchableOpacity
                style={styles.stepBtn}
                onPress={() => setter(Math.max(pd.min, round(val - pd.step, pd.step)))}
              >
                <Text style={styles.stepBtnTxt}>−</Text>
              </TouchableOpacity>
              <Text style={styles.stepVal}>{val.toFixed(pd.decimals)}</Text>
              <TouchableOpacity
                style={styles.stepBtn}
                onPress={() => setter(Math.min(pd.max, round(val + pd.step, pd.step)))}
              >
                <Text style={styles.stepBtnTxt}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      })}

      <Text style={[styles.sectionTitle, { marginTop: 20 }]}>Jugadores (para simulación)</Text>
      <View style={styles.paramRow}>
        <View style={styles.paramLabels}>
          <Text style={styles.paramSymbol}>J</Text>
          <Text style={styles.paramName}>Número de jugadores</Text>
        </View>
        <View style={styles.stepper}>
          <TouchableOpacity style={styles.stepBtn} onPress={() => setNumPlayers((v) => Math.max(2, v - 1))}>
            <Text style={styles.stepBtnTxt}>−</Text>
          </TouchableOpacity>
          <Text style={styles.stepVal}>{numPlayers}</Text>
          <TouchableOpacity style={styles.stepBtn} onPress={() => setNumPlayers((v) => Math.min(16, v + 1))}>
            <Text style={styles.stepBtnTxt}>+</Text>
          </TouchableOpacity>
        </View>
      </View>

      <TouchableOpacity style={styles.resetBtn} onPress={onReset}>
        <Text style={styles.resetBtnTxt}>Restablecer valores por defecto</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.simBtn} onPress={onSimulate}>
        <Text style={styles.simBtnTxt}>Simular tiempos</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
        onPress={() => void onSave()}
        disabled={saving}
      >
        {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnTxt}>Guardar</Text>}
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 24, paddingBottom: 40 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#111', marginBottom: 12 },
  paramRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
    gap: 8,
  },
  paramLabels: { flex: 1 },
  paramSymbol: { fontSize: 15, fontWeight: '700', color: '#1D4ED8' },
  paramName: { fontSize: 13, color: '#6B7280', marginTop: 1 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#DBEAFE',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnTxt: { fontSize: 20, fontWeight: '700', color: '#1E40AF' },
  stepVal: { fontSize: 16, fontWeight: '700', color: '#111', minWidth: 48, textAlign: 'center' },
  resetBtn: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 10,
  },
  resetBtnTxt: { color: '#6B7280', fontSize: 14, fontWeight: '600' },
  simBtn: {
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  simBtnTxt: { color: '#1D4ED8', fontSize: 15, fontWeight: '600' },
  saveBtn: {
    backgroundColor: '#3B82F6',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  saveBtnDisabled: { backgroundColor: '#9CA3AF' },
  saveBtnTxt: { color: '#fff', fontSize: 16, fontWeight: '600' },
});

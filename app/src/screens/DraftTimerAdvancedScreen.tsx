import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { supabase } from '../lib/supabase';
import { DEFAULT_TIMER_PARAMS, type TimerParams } from '../lib/draftTimer';

type Props = NativeStackScreenProps<MainStackParamList, 'DraftTimerAdvanced'>;

const TIMER_COLORS: { key: string; hex: string; label: string }[] = [
  { key: 'blue',   hex: '#3B82F6', label: 'Azul' },
  { key: 'green',  hex: '#10B981', label: 'Verde' },
  { key: 'orange', hex: '#F97316', label: 'Naranja' },
  { key: 'red',    hex: '#EF4444', label: 'Rojo' },
  { key: 'purple', hex: '#8B5CF6', label: 'Violeta' },
  { key: 'black',  hex: '#1F2937', label: 'Negro' },
];

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
  { key: 'alpha', label: 'Lectura individual',           symbol: 'α',     min: 0, max: 2,   step: 0.1, decimals: 1 },
  { key: 'beta',  label: 'Combinatoria',                 symbol: 'β',     min: 0, max: 2,   step: 0.1, decimals: 1 },
  { key: 'gamma', label: 'Costo de oportunidad',         symbol: 'γ',     min: 0, max: 2,   step: 0.1, decimals: 1 },
  { key: 'delta', label: 'Incertidumbre de identidad',   symbol: 'δ',     min: 0, max: 2,   step: 0.1, decimals: 1 },
  { key: 'rho',   label: 'Reducción por relectura',      symbol: 'ρ',     min: 0, max: 0.9, step: 0.1, decimals: 1 },
  { key: 'tMin',  label: 'Tiempo mínimo por pick',       symbol: 'T_min', min: 2, max: 45,  step: 1,   decimals: 0 },
  { key: 'tMax',  label: 'Tiempo máximo por pick',       symbol: 'T_max', min: 30, max: 300, step: 5,  decimals: 0 },
];

function roundStep(v: number, step: number): number {
  return Math.round(v / step) * step;
}

type Snapshot = {
  alpha: number; beta: number; gamma: number; delta: number;
  rho: number; tMin: number; tMax: number; timerColor: string;
};

function sameFloat(a: number, b: number): boolean {
  return a.toFixed(1) === b.toFixed(1);
}

export default function DraftTimerAdvancedScreen({ route, navigation }: Props) {
  const { eventId, numPlayers, timerPacks, readOnly } = route.params;

  const [loading, setLoading] = useState(true);
  const [alpha, setAlpha] = useState(DEFAULT_TIMER_PARAMS.alpha);
  const [beta,  setBeta]  = useState(DEFAULT_TIMER_PARAMS.beta);
  const [gamma, setGamma] = useState(DEFAULT_TIMER_PARAMS.gamma);
  const [delta, setDelta] = useState(DEFAULT_TIMER_PARAMS.delta);
  const [rho,   setRho]   = useState(DEFAULT_TIMER_PARAMS.rho);
  const [tMin,  setTMin]  = useState(DEFAULT_TIMER_PARAMS.tMin);
  const [tMax,  setTMax]  = useState(DEFAULT_TIMER_PARAMS.tMax);
  const [timerColor, setTimerColor] = useState('blue');
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const firstLoadRef = useRef(true);
  const savedRef = useRef<Snapshot>({
    alpha: DEFAULT_TIMER_PARAMS.alpha, beta: DEFAULT_TIMER_PARAMS.beta,
    gamma: DEFAULT_TIMER_PARAMS.gamma, delta: DEFAULT_TIMER_PARAMS.delta,
    rho: DEFAULT_TIMER_PARAMS.rho, tMin: DEFAULT_TIMER_PARAMS.tMin,
    tMax: DEFAULT_TIMER_PARAMS.tMax, timerColor: 'blue',
  });

  const loadFromDb = useCallback(async () => {
    const { data } = await supabase
      .from('draft_events')
      .select('timer_alpha, timer_beta, timer_gamma, timer_delta, timer_rho, timer_tmin, timer_tmax, timer_color')
      .eq('id', eventId)
      .maybeSingle();
    if (data) {
      const row = data as any;
      const a  = row.timer_alpha ?? DEFAULT_TIMER_PARAMS.alpha;
      const b  = row.timer_beta  ?? DEFAULT_TIMER_PARAMS.beta;
      const g  = row.timer_gamma ?? DEFAULT_TIMER_PARAMS.gamma;
      const d  = row.timer_delta ?? DEFAULT_TIMER_PARAMS.delta;
      const r  = row.timer_rho   ?? DEFAULT_TIMER_PARAMS.rho;
      const tm = row.timer_tmin  ?? DEFAULT_TIMER_PARAMS.tMin;
      const tx = row.timer_tmax  ?? DEFAULT_TIMER_PARAMS.tMax;
      const tc = row.timer_color ?? 'blue';
      setAlpha(a); setBeta(b); setGamma(g); setDelta(d);
      setRho(r); setTMin(tm); setTMax(tx); setTimerColor(tc);
      savedRef.current = { alpha: a, beta: b, gamma: g, delta: d, rho: r, tMin: tm, tMax: tx, timerColor: tc };
    }
  }, [eventId]);

  // First load.
  useFocusEffect(
    useCallback(() => {
      if (!firstLoadRef.current) return;
      setLoading(true);
      void loadFromDb().then(() => {
        setLoading(false);
        firstLoadRef.current = false;
      });
    }, [loadFromDb])
  );

  // Reload from DB when returning from Sim after a successful save.
  useEffect(() => {
    if (!route.params?.savedInSim) return;
    void loadFromDb();
    navigation.setParams({ savedInSim: false });
  }, [route.params?.savedInSim]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fixed back destination: always Config, never Sim (which may be below in the stack).
  useEffect(() => {
    navigation.setOptions({
      gestureEnabled: false,
      headerLeft: () => (
        <TouchableOpacity
          hitSlop={12}
          onPress={() =>
            navigation.navigate('DraftTimerConfig', {
              mode: 'event',
              eventId,
              readOnly,
            })
          }
        >
          <Text style={advStyles.backBtn}>Atrás</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, eventId, readOnly]);

  const s = savedRef.current;
  const isDirty =
    !sameFloat(alpha, s.alpha) || !sameFloat(beta, s.beta) ||
    !sameFloat(gamma, s.gamma) || !sameFloat(delta, s.delta) ||
    !sameFloat(rho, s.rho) || tMin !== s.tMin || tMax !== s.tMax ||
    timerColor !== s.timerColor;

  const getters: Record<keyof TimerParams, number> = { alpha, beta, gamma, delta, rho, tMin, tMax };
  const setters: Record<keyof TimerParams, (v: number) => void> = {
    alpha: setAlpha, beta: setBeta, gamma: setGamma, delta: setDelta,
    rho: setRho, tMin: setTMin, tMax: setTMax,
  };

  const onReset = () => {
    const d = DEFAULT_TIMER_PARAMS;
    setAlpha(d.alpha); setBeta(d.beta); setGamma(d.gamma);
    setDelta(d.delta); setRho(d.rho); setTMin(d.tMin); setTMax(d.tMax);
  };

  const onSimulate = () => {
    navigation.navigate('DraftTimerSim', {
      timerPacks,
      numPlayers,
      alpha, beta, gamma, delta, rho, tMin, tMax,
      eventId,
      readOnly,
    });
  };

  const onSave = async () => {
    setSaving(true);
    const { error } = await supabase
      .from('draft_events')
      .update({
        timer_alpha: alpha, timer_beta: beta, timer_gamma: gamma,
        timer_delta: delta, timer_rho: rho, timer_tmin: tMin, timer_tmax: tMax,
        timer_color: timerColor,
      })
      .eq('id', eventId);
    setSaving(false);
    if (error) {
      Alert.alert('Error', error.message ?? 'No se pudieron guardar los parámetros.');
      return;
    }
    savedRef.current = { alpha, beta, gamma, delta, rho, tMin, tMax, timerColor };
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 1500);
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Parámetros del cronómetro</Text>

      {readOnly ? (
        <Text style={styles.readOnlyBanner}>Solo lectura — el draft ya inició</Text>
      ) : null}

      {PARAMS.map((pd) => {
        const val = getters[pd.key];
        const setter = setters[pd.key];
        return (
          <View key={pd.key} style={styles.paramRow}>
            <View style={styles.paramLabels}>
              <Text style={styles.paramSymbol}>{pd.symbol}</Text>
              <Text style={styles.paramName}>{pd.label}</Text>
            </View>
            <View style={[styles.stepper, readOnly && styles.disabledGroup]}>
              <TouchableOpacity
                style={styles.stepBtn}
                disabled={readOnly}
                onPress={() => setter(Math.max(pd.min, roundStep(val - pd.step, pd.step)))}
              >
                <Text style={styles.stepBtnTxt}>−</Text>
              </TouchableOpacity>
              <Text style={styles.stepVal}>{val.toFixed(pd.decimals)}</Text>
              <TouchableOpacity
                style={styles.stepBtn}
                disabled={readOnly}
                onPress={() => setter(Math.min(pd.max, roundStep(val + pd.step, pd.step)))}
              >
                <Text style={styles.stepBtnTxt}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      })}

      {!readOnly ? (
        <TouchableOpacity style={styles.resetBtn} onPress={onReset}>
          <Text style={styles.resetBtnTxt}>Restablecer valores por defecto</Text>
        </TouchableOpacity>
      ) : null}

      <Text style={[styles.sectionTitle, { marginTop: 20 }]}>Color del cronómetro</Text>
      <View style={[styles.colorRow, readOnly && styles.disabledGroup]}>
        {TIMER_COLORS.map((c) => (
          <TouchableOpacity
            key={c.key}
            disabled={readOnly}
            onPress={() => setTimerColor(c.key)}
            style={[
              styles.colorSwatch,
              { backgroundColor: c.hex },
              timerColor === c.key && styles.colorSwatchSelected,
            ]}
          >
            {timerColor === c.key ? <Text style={styles.colorCheck}>✓</Text> : null}
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.colorLabel}>
        {TIMER_COLORS.find((c) => c.key === timerColor)?.label ?? 'Azul'}
      </Text>

      <TouchableOpacity style={styles.simBtn} onPress={onSimulate}>
        <Text style={styles.simBtnTxt}>Simular tiempos</Text>
      </TouchableOpacity>

      {!readOnly ? (
        <TouchableOpacity
          style={[styles.saveBtn, (!isDirty || saving) && styles.saveBtnDisabled]}
          onPress={() => void onSave()}
          disabled={!isDirty || saving}
        >
          {saving
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.saveBtnTxt}>{justSaved ? '✓ Guardado' : 'Guardar'}</Text>}
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 24, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
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
    marginBottom: 10,
  },
  resetBtnTxt: { color: '#6B7280', fontSize: 14, fontWeight: '600' },
  colorRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 6,
  },
  colorSwatch: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  colorSwatchSelected: {
    borderColor: '#111',
  },
  colorCheck: { color: '#fff', fontWeight: '800', fontSize: 16 },
  colorLabel: { fontSize: 13, color: '#6B7280', marginBottom: 16 },
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
  readOnlyBanner: { fontSize: 12, color: '#92400E', backgroundColor: '#FEF3C7', borderRadius: 6, padding: 8, marginBottom: 12, textAlign: 'center', fontWeight: '600' },
  disabledGroup: { opacity: 0.5 },
});

const advStyles = StyleSheet.create({
  backBtn: { color: '#3B82F6', fontSize: 17, fontWeight: '400' },
});

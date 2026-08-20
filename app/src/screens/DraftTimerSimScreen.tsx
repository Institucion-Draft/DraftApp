import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Svg, { Line, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { computePickTimeline, formatSeconds } from '../lib/draftTimer';
import { supabase } from '../lib/supabase';

type Props = NativeStackScreenProps<MainStackParamList, 'DraftTimerSim'>;

const CHART_W = 680;
const CHART_H = 200;
const PAD = { top: 14, right: 16, bottom: 32, left: 44 };
const INNER_W = CHART_W - PAD.left - PAD.right;
const INNER_H = CHART_H - PAD.top - PAD.bottom;

function linePoints(xs: number[], ys: number[], minY: number, maxY: number): string {
  const rangeY = maxY - minY || 1;
  return xs
    .map((x, i) => {
      const px = PAD.left + (x / (xs.length - 1 || 1)) * INNER_W;
      const py = PAD.top + INNER_H - ((ys[i]! - minY) / rangeY) * INNER_H;
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(' ');
}

function roundStep(v: number, step: number): number {
  return Math.round(v / step) * step;
}

function sameFloat(a: number, b: number): boolean {
  return a.toFixed(1) === b.toFixed(1);
}

type SimSnapshot = {
  alpha: number; beta: number; gamma: number; delta: number;
  rho: number; tMin: number; tMax: number;
};

interface CompactStepperProps {
  label: string;
  value: string;
  onDec: () => void;
  onInc: () => void;
}
function CompactStepper({ label, value, onDec, onInc }: CompactStepperProps) {
  return (
    <View style={cStyles.box}>
      <Text style={cStyles.label}>{label}</Text>
      <View style={cStyles.row}>
        <TouchableOpacity style={cStyles.btn} onPress={onDec}>
          <Text style={cStyles.btnTxt}>−</Text>
        </TouchableOpacity>
        <Text style={cStyles.val}>{value}</Text>
        <TouchableOpacity style={cStyles.btn} onPress={onInc}>
          <Text style={cStyles.btnTxt}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

interface ParamBoxProps {
  symbol: string;
  name: string;
  value: string;
  onDec: () => void;
  onInc: () => void;
}
function ParamBox({ symbol, name, value, onDec, onInc }: ParamBoxProps) {
  return (
    <View style={cStyles.box}>
      <Text style={cStyles.paramSymbol}>{symbol}</Text>
      <Text style={cStyles.paramName}>{name}</Text>
      <View style={cStyles.row}>
        <TouchableOpacity style={cStyles.btn} onPress={onDec}>
          <Text style={cStyles.btnTxt}>−</Text>
        </TouchableOpacity>
        <Text style={cStyles.val}>{value}</Text>
        <TouchableOpacity style={cStyles.btn} onPress={onInc}>
          <Text style={cStyles.btnTxt}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const cStyles = StyleSheet.create({
  box: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingVertical: 10,
    paddingHorizontal: 4,
    gap: 4,
    minWidth: 0,
  },
  label: { fontSize: 11, fontWeight: '700', color: '#64748B', textAlign: 'center' },
  paramSymbol: { fontSize: 18, fontWeight: '800', color: '#1D4ED8', lineHeight: 20 },
  paramName: { fontSize: 9, color: '#6B7280', textAlign: 'center', lineHeight: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  btn: {
    width: 28,
    height: 28,
    borderRadius: 7,
    backgroundColor: '#DBEAFE',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnTxt: { fontSize: 16, fontWeight: '700', color: '#1E40AF', lineHeight: 18 },
  val: { fontSize: 14, fontWeight: '700', color: '#111', minWidth: 30, textAlign: 'center' },
});

export default function DraftTimerSimScreen({ route, navigation }: Props) {
  const {
    timerPacks,
    numPlayers: initPlayers,
    alpha: ia, beta: ib, gamma: ig, delta: id, rho: ir, tMin: itMin, tMax: itMax,
    eventId,
    readOnly,
  } = route.params;

  const [numPlayers, setNumPlayers] = useState(initPlayers);
  const [alpha, setAlpha] = useState(ia);
  const [beta,  setBeta]  = useState(ib);
  const [gamma, setGamma] = useState(ig);
  const [delta, setDelta] = useState(id);
  const [rho,   setRho]   = useState(ir);
  const [tMin,  setTMin]  = useState(itMin);
  const [tMax,  setTMax]  = useState(itMax);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const savedRef  = useRef<SimSnapshot>({ alpha: ia, beta: ib, gamma: ig, delta: id, rho: ir, tMin: itMin, tMax: itMax });
  const hasSavedRef = useRef(false);

  const ss = savedRef.current;
  const isDirty =
    !sameFloat(alpha, ss.alpha) || !sameFloat(beta, ss.beta) ||
    !sameFloat(gamma, ss.gamma) || !sameFloat(delta, ss.delta) ||
    !sameFloat(rho, ss.rho) || tMin !== ss.tMin || tMax !== ss.tMax;

  // Custom back button: passes savedInSim flag when navigating back to Advanced.
  useEffect(() => {
    navigation.setOptions({
      gestureEnabled: false,
      headerLeft: () => (
        <TouchableOpacity
          hitSlop={12}
          onPress={() => {
            if (hasSavedRef.current && eventId) {
              navigation.navigate('DraftTimerAdvanced', {
                eventId,
                numPlayers: initPlayers,
                timerPacks,
                savedInSim: true,
              });
            } else {
              navigation.goBack();
            }
          }}
        >
          <Text style={styles.backBtn}>Atrás</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, eventId, initPlayers, timerPacks]);

  const onRestore = () => {
    setAlpha(0.30);
    setBeta(0.70);
    setGamma(0.80);
    setDelta(0.60);
    setRho(0.35);
    setTMin(7);
    setTMax(130);
  };

  const onSaveParams = async () => {
    if (!eventId) return;
    setSaving(true);
    const { error } = await supabase
      .from('draft_events')
      .update({
        timer_alpha: alpha,
        timer_beta:  beta,
        timer_gamma: gamma,
        timer_delta: delta,
        timer_rho:   rho,
        timer_tmin:  tMin,
        timer_tmax:  tMax,
      })
      .eq('id', eventId);
    setSaving(false);
    if (error) {
      Alert.alert('Error', error.message ?? 'No se pudieron guardar los parámetros.');
      return;
    }
    savedRef.current = { alpha, beta, gamma, delta, rho, tMin, tMax };
    hasSavedRef.current = true;
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 1500);
  };

  const timeline = useMemo(
    () => computePickTimeline(timerPacks, numPlayers, { alpha, beta, gamma, delta, rho, tMin, tMax }),
    [timerPacks, numPlayers, alpha, beta, gamma, delta, rho, tMin, tMax]
  );

  const xs = timeline.map((p) => p.globalIndex);
  const tValues = timeline.map((p) => p.timeSeconds);
  const totalSec = tValues.reduce((a, b) => a + b, 0);
  const avgSec = timeline.length > 0 ? Math.round(totalSec / timeline.length) : 0;

  const packStartIndexes = useMemo(() => {
    const result: number[] = [];
    let prevPack = -1;
    for (const pick of timeline) {
      if (pick.packIndex !== prevPack) {
        if (pick.packIndex > 0) result.push(pick.globalIndex);
        prevPack = pick.packIndex;
      }
    }
    return result;
  }, [timeline]);

  const minY = tValues.length > 0 ? Math.min(...tValues) : 0;
  const maxY = tValues.length > 0 ? Math.max(...tValues) : 1;
  const pts = tValues.length > 0 ? linePoints(xs, tValues, minY, maxY) : '';
  const ticks = 4;

  const xForGlobalIdx = (idx: number) =>
    PAD.left + (idx / (xs.length - 1 || 1)) * INNER_W;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>

      {/* ── 1. Stats ── */}
      <View style={styles.statsRow}>
        <View style={styles.statChip}>
          <Text style={styles.statVal}>{timeline.length}</Text>
          <Text style={styles.statLbl}>Rondas totales</Text>
        </View>
        <View style={styles.statChip}>
          <Text style={styles.statVal}>{formatSeconds(totalSec)}</Text>
          <Text style={styles.statLbl}>Tiempo total</Text>
        </View>
        <View style={styles.statChip}>
          <Text style={styles.statVal}>{avgSec}s</Text>
          <Text style={styles.statLbl}>Promedio por ronda</Text>
        </View>
      </View>

      {/* ── 2. Gráfico ── */}
      <Text style={styles.chartTitle}>Tiempo estimado por ronda</Text>
      {timeline.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator style={styles.chartScroll}>
          <Svg width={CHART_W} height={CHART_H}>
            <Rect x={PAD.left} y={PAD.top} width={INNER_W} height={INNER_H} fill="#F8FAFC" stroke="#E2E8F0" />

            {Array.from({ length: ticks + 1 }, (_, i) => {
              const val = minY + (maxY - minY) * (i / ticks);
              const py = PAD.top + INNER_H - (i / ticks) * INNER_H;
              return (
                <React.Fragment key={i}>
                  <Line x1={PAD.left} y1={py} x2={PAD.left + INNER_W} y2={py} stroke="#E2E8F0" strokeWidth={1} />
                  <SvgText x={PAD.left - 4} y={py + 4} fontSize={9} fill="#94A3B8" textAnchor="end">
                    {Math.round(val)}
                  </SvgText>
                </React.Fragment>
              );
            })}

            <SvgText
              x={PAD.left - 36}
              y={PAD.top + INNER_H / 2}
              fontSize={9}
              fill="#64748B"
              textAnchor="middle"
              rotation={-90}
              originX={PAD.left - 36}
              originY={PAD.top + INNER_H / 2}
            >
              seg
            </SvgText>

            {packStartIndexes.map((gIdx) => {
              const px = xForGlobalIdx(gIdx);
              return (
                <Line
                  key={gIdx}
                  x1={px} y1={PAD.top}
                  x2={px} y2={PAD.top + INNER_H}
                  stroke="#94A3B8" strokeWidth={1} strokeDasharray="4 3"
                />
              );
            })}

            <Polyline points={pts} fill="none" stroke="#10B981" strokeWidth={1.5} />

            {[0, Math.floor(xs.length / 2), xs.length - 1].map((idx) => {
              const px = PAD.left + (idx / (xs.length - 1 || 1)) * INNER_W;
              return (
                <SvgText key={idx} x={px} y={CHART_H - 6} fontSize={9} fill="#94A3B8" textAnchor="middle">
                  {xs[idx]! + 1}
                </SvgText>
              );
            })}

            <SvgText x={PAD.left + INNER_W / 2} y={CHART_H - 2} fontSize={9} fill="#64748B" textAnchor="middle">
              #Ronda
            </SvgText>
          </Svg>
        </ScrollView>
      ) : (
        <Text style={styles.empty}>Sin datos</Text>
      )}

      {/* ── 3. #Jugadores | T_min | T_max ── */}
      <View style={styles.gridRow}>
        <CompactStepper
          label="#Jugadores"
          value={String(numPlayers)}
          onDec={() => setNumPlayers((v) => Math.max(2, v - 1))}
          onInc={() => setNumPlayers((v) => Math.min(15, v + 1))}
        />
        <CompactStepper
          label="T_min"
          value={`${tMin}s`}
          onDec={() => setTMin((v) => Math.max(2, roundStep(v - 1, 1)))}
          onInc={() => setTMin((v) => Math.min(45, roundStep(v + 1, 1)))}
        />
        <CompactStepper
          label="T_max"
          value={`${tMax}s`}
          onDec={() => setTMax((v) => Math.max(30, roundStep(v - 5, 5)))}
          onInc={() => setTMax((v) => Math.min(300, roundStep(v + 5, 5)))}
        />
      </View>

      {/* ── 4. Parámetros α/β/γ/δ/ρ ── */}
      <View style={styles.gridRow}>
        <ParamBox symbol="α" name="Lectura individual" value={alpha.toFixed(1)}
          onDec={() => setAlpha((v) => Math.max(0, roundStep(v - 0.1, 0.1)))}
          onInc={() => setAlpha((v) => Math.min(2, roundStep(v + 0.1, 0.1)))}
        />
        <ParamBox symbol="β" name="Combinatoria" value={beta.toFixed(1)}
          onDec={() => setBeta((v) => Math.max(0, roundStep(v - 0.1, 0.1)))}
          onInc={() => setBeta((v) => Math.min(2, roundStep(v + 0.1, 0.1)))}
        />
        <ParamBox symbol="γ" name="Costo de oportunidad" value={gamma.toFixed(1)}
          onDec={() => setGamma((v) => Math.max(0, roundStep(v - 0.1, 0.1)))}
          onInc={() => setGamma((v) => Math.min(2, roundStep(v + 0.1, 0.1)))}
        />
      </View>
      <View style={[styles.gridRow, styles.gridRowParams]}>
        <View style={styles.halfSpacer} />
        <ParamBox symbol="δ" name="Incertid. de ident." value={delta.toFixed(1)}
          onDec={() => setDelta((v) => Math.max(0, roundStep(v - 0.1, 0.1)))}
          onInc={() => setDelta((v) => Math.min(2, roundStep(v + 0.1, 0.1)))}
        />
        <ParamBox symbol="ρ" name="Reducción por relectura" value={rho.toFixed(1)}
          onDec={() => setRho((v) => Math.max(0, roundStep(v - 0.1, 0.1)))}
          onInc={() => setRho((v) => Math.min(0.9, roundStep(v + 0.1, 0.1)))}
        />
        <View style={styles.halfSpacer} />
      </View>

      {/* ── 5. Botones Restaurar / Guardar ── */}
      <View style={styles.actionRow}>
        <TouchableOpacity style={styles.restoreBtn} onPress={onRestore}>
          <Text style={styles.restoreBtnTxt}>Restaurar por defecto</Text>
        </TouchableOpacity>
        {eventId ? (
          <TouchableOpacity
            style={[styles.saveBtn, (!isDirty || saving || !!readOnly) && styles.saveBtnDisabled]}
            onPress={() => void onSaveParams()}
            disabled={!isDirty || saving || !!readOnly}
          >
            {saving
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={styles.saveBtnTxt}>{justSaved ? '✓ Guardado' : 'Guardar parámetros'}</Text>}
          </TouchableOpacity>
        ) : null}
      </View>

      {/* ── 6. Tiempo por sobre ── */}
      <Text style={styles.sectionTitle}>Tiempo por sobre</Text>
      {timerPacks.map((packSize, s) => {
        const packPicks = timeline.filter((p) => p.packIndex === s);
        const packTotal = packPicks.reduce((a, p) => a + p.timeSeconds, 0);
        return (
          <View key={s} style={styles.packRow}>
            <Text style={styles.packLabel}>Sobre {s + 1} — {packSize} cartas</Text>
            <Text style={styles.packTime}>{formatSeconds(packTotal)}</Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingBottom: 48 },

  statsRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  statChip: {
    flex: 1,
    backgroundColor: '#F1F5F9',
    borderRadius: 10,
    padding: 12,
    alignItems: 'center',
  },
  statVal: { fontSize: 15, fontWeight: '700', color: '#111' },
  statLbl: { fontSize: 9, color: '#6B7280', marginTop: 3, textAlign: 'center' },

  chartTitle: { fontSize: 14, fontWeight: '700', color: '#111', marginBottom: 8 },
  chartScroll: { marginBottom: 16 },
  empty: { color: '#9CA3AF', marginBottom: 16 },

  gridRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  gridRowParams: { marginBottom: 12 },
  halfSpacer: { flex: 0.5 },

  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 20,
    alignItems: 'center',
  },
  restoreBtn: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 12,
    backgroundColor: '#F9FAFB',
  },
  restoreBtnTxt: { fontSize: 12, fontWeight: '600', color: '#6B7280' },
  saveBtn: {
    flex: 1,
    backgroundColor: '#3B82F6',
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: 'center',
  },
  saveBtnDisabled: { backgroundColor: '#9CA3AF' },
  saveBtnTxt: { color: '#fff', fontSize: 14, fontWeight: '600' },

  sectionTitle: { fontSize: 14, fontWeight: '700', color: '#111', marginBottom: 8 },
  packRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  packLabel: { fontSize: 14, color: '#374151' },
  packTime: { fontSize: 15, fontWeight: '600', color: '#111' },
  backBtn: { color: '#3B82F6', fontSize: 17, fontWeight: '400' as const },
});

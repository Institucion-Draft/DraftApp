import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { computePickTimeline, formatSeconds } from '../lib/draftTimer';

type Props = NativeStackScreenProps<MainStackParamList, 'DraftTimerSim'>;

const CHART_W = 680;
const CHART_H = 180;
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

function LineChart({
  picks,
  values,
  color,
  yLabel,
  formatY,
}: {
  picks: number[];
  values: number[];
  color: string;
  yLabel: string;
  formatY: (v: number) => string;
}) {
  const minY = Math.min(...values);
  const maxY = Math.max(...values);
  const pts = linePoints(picks, values, minY, maxY);
  const ticks = 4;

  return (
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
                {formatY(val)}
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
          {yLabel}
        </SvgText>
        <Polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
        {/* X axis label for first, middle, last */}
        {[0, Math.floor(picks.length / 2), picks.length - 1].map((idx) => {
          const px = PAD.left + (idx / (picks.length - 1 || 1)) * INNER_W;
          return (
            <SvgText key={idx} x={px} y={CHART_H - 6} fontSize={9} fill="#94A3B8" textAnchor="middle">
              {picks[idx]! + 1}
            </SvgText>
          );
        })}
        <SvgText x={PAD.left + INNER_W / 2} y={CHART_H - 2} fontSize={9} fill="#64748B" textAnchor="middle">
          pick global
        </SvgText>
      </Svg>
    </ScrollView>
  );
}

export default function DraftTimerSimScreen({ route }: Props) {
  const { timerPacks, numPlayers, alpha, beta, gamma, delta, rho, tMin, tMax } = route.params;

  const timeline = useMemo(
    () =>
      computePickTimeline(timerPacks, numPlayers, {
        alpha, beta, gamma, delta, rho, tMin, tMax,
      }),
    [timerPacks, numPlayers, alpha, beta, gamma, delta, rho, tMin, tMax]
  );

  const xs = timeline.map((p) => p.globalIndex);
  const iiValues = timeline.map((p) => p.ii);
  const tValues = timeline.map((p) => p.timeSeconds);

  const totalSec = tValues.reduce((a, b) => a + b, 0);
  const avgSec = timeline.length > 0 ? Math.round(totalSec / timeline.length) : 0;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <View style={styles.statsRow}>
        <View style={styles.statChip}>
          <Text style={styles.statVal}>{timeline.length}</Text>
          <Text style={styles.statLbl}>picks totales</Text>
        </View>
        <View style={styles.statChip}>
          <Text style={styles.statVal}>{formatSeconds(totalSec)}</Text>
          <Text style={styles.statLbl}>duración total</Text>
        </View>
        <View style={styles.statChip}>
          <Text style={styles.statVal}>{avgSec}s</Text>
          <Text style={styles.statLbl}>promedio/pick</Text>
        </View>
      </View>

      <Text style={styles.chartTitle}>Intensidad de indecisión (II) por pick</Text>
      {timeline.length > 0 ? (
        <LineChart
          picks={xs}
          values={iiValues}
          color="#3B82F6"
          yLabel="II"
          formatY={(v) => v.toFixed(1)}
        />
      ) : (
        <Text style={styles.empty}>Sin datos</Text>
      )}

      <Text style={styles.chartTitle}>Tiempo estimado por pick (segundos)</Text>
      {timeline.length > 0 ? (
        <LineChart
          picks={xs}
          values={tValues}
          color="#10B981"
          yLabel="seg"
          formatY={(v) => `${Math.round(v)}`}
        />
      ) : (
        <Text style={styles.empty}>Sin datos</Text>
      )}

      <Text style={styles.packSummaryTitle}>Resumen por sobre</Text>
      {timerPacks.map((packSize, s) => {
        const packPicks = timeline.filter((p) => p.packIndex === s);
        const packTotal = packPicks.reduce((a, p) => a + p.timeSeconds, 0);
        return (
          <View key={s} style={styles.packRow}>
            <Text style={styles.packLabel}>Sobre {s + 1} ({packSize} cartas)</Text>
            <Text style={styles.packTime}>{formatSeconds(packTotal)}</Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 20, paddingBottom: 40 },
  statsRow: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  statChip: {
    flex: 1,
    backgroundColor: '#F1F5F9',
    borderRadius: 10,
    padding: 12,
    alignItems: 'center',
  },
  statVal: { fontSize: 17, fontWeight: '700', color: '#111' },
  statLbl: { fontSize: 11, color: '#6B7280', marginTop: 2 },
  chartTitle: { fontSize: 14, fontWeight: '700', color: '#111', marginBottom: 8 },
  chartScroll: { marginBottom: 20 },
  empty: { color: '#9CA3AF', marginBottom: 20 },
  packSummaryTitle: { fontSize: 14, fontWeight: '700', color: '#111', marginBottom: 8 },
  packRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  packLabel: { fontSize: 14, color: '#374151' },
  packTime: { fontSize: 14, fontWeight: '600', color: '#111' },
});

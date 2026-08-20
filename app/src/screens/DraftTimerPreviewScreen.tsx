import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { computePickTimeline, formatSeconds } from '../lib/draftTimer';

type Props = NativeStackScreenProps<MainStackParamList, 'DraftTimerPreview'>;

const CHART_W = 680;
const CHART_H = 200;
const PAD = { top: 14, right: 16, bottom: 32, left: 44 };
const INNER_W = CHART_W - PAD.left - PAD.right;
const INNER_H = CHART_H - PAD.top - PAD.bottom;
const TICKS = 4;

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

export default function DraftTimerPreviewScreen({ route }: Props) {
  const { timerPacks, numPlayers, alpha, beta, gamma, delta, rho, tMin, tMax } = route.params;

  const timeline = useMemo(
    () => computePickTimeline(timerPacks, numPlayers, { alpha, beta, gamma, delta, rho, tMin, tMax }),
    [timerPacks, numPlayers, alpha, beta, gamma, delta, rho, tMin, tMax]
  );

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

  const xs = timeline.map((p) => p.globalIndex);
  const tValues = timeline.map((p) => p.timeSeconds);
  const minY = tValues.length > 0 ? Math.min(...tValues) : 0;
  const maxY = tValues.length > 0 ? Math.max(...tValues) : 1;
  const pts = tValues.length > 0 ? linePoints(xs, tValues, minY, maxY) : '';

  const xForIdx = (idx: number) =>
    PAD.left + (idx / (xs.length - 1 || 1)) * INNER_W;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.chartTitle}>Tiempo estimado por ronda</Text>

      {timeline.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator style={styles.chartScroll}>
          <Svg width={CHART_W} height={CHART_H}>
            <Rect x={PAD.left} y={PAD.top} width={INNER_W} height={INNER_H} fill="#F8FAFC" stroke="#E2E8F0" />

            {Array.from({ length: TICKS + 1 }, (_, i) => {
              const val = minY + (maxY - minY) * (i / TICKS);
              const py = PAD.top + INNER_H - (i / TICKS) * INNER_H;
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

            {packStartIndexes.map((gIdx) => (
              <Line
                key={gIdx}
                x1={xForIdx(gIdx)} y1={PAD.top}
                x2={xForIdx(gIdx)} y2={PAD.top + INNER_H}
                stroke="#94A3B8" strokeWidth={1} strokeDasharray="4 3"
              />
            ))}

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
  content: { padding: 20, paddingBottom: 40 },
  chartTitle: { fontSize: 14, fontWeight: '700', color: '#111', marginBottom: 8 },
  chartScroll: { marginBottom: 20 },
  empty: { color: '#9CA3AF', marginBottom: 20 },
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
});

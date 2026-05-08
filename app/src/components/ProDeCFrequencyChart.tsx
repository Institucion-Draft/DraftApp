import React, { useId, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { G, Line, Circle, Rect, Text as SvgText } from 'react-native-svg';
import type { MtgColor } from '../lib/database.types';
import { MTG_COLOR_HEX } from './ColorFlag';
import { PRODEC_BAR_ORDER } from '../lib/prodecDisplay';

type Props = {
  counts: Record<MtgColor, number>;
  width: number;
};

const CHART_H = 158;
const MARGIN_LEFT = 34;
const MARGIN_RIGHT = 12;
const MARGIN_TOP = 10;
/** Solo letra bajo el eje X (sin número). */
const MARGIN_BOTTOM = 30;
const AXIS_STROKE = '#374151';
/** Fondo del área de trazado: tono medio-claro para que W y B sigan contrastando. */
const PLOT_FILL = '#CAD4DE';
const GRID_STROKE = 'rgba(255,255,255,0.45)';

function yScaleMax(maxFreq: number): number {
  if (maxFreq <= 0) return 5;
  return Math.ceil(maxFreq / 5) * 5;
}

/**
 * Gráfico de frecuencias: ejes esquemáticos, rejilla, tallos + puntos (sin barras rellenas).
 */
export default function ProDeCFrequencyChart({ counts, width }: Props) {
  const uid = useId().replace(/:/g, '');
  const plotW = Math.max(120, width - MARGIN_LEFT - MARGIN_RIGHT);
  const plotH = CHART_H - MARGIN_TOP - MARGIN_BOTTOM;
  const baselineY = MARGIN_TOP + plotH;
  const axisX0 = MARGIN_LEFT;
  const axisX1 = MARGIN_LEFT + plotW;

  const { yMax, ticks, series } = useMemo(() => {
    const vals = PRODEC_BAR_ORDER.map((c) => counts[c]);
    const maxF = Math.max(0, ...vals);
    const ymax = yScaleMax(maxF);
    const t: number[] = [];
    for (let v = 0; v <= ymax; v += 5) t.push(v);
    const ser = PRODEC_BAR_ORDER.map((col) => ({
      col,
      v: counts[col],
      hex: MTG_COLOR_HEX[col],
    }));
    return { yMax: ymax, ticks: t, series: ser };
  }, [counts]);

  const yToSvg = (freq: number) => baselineY - (freq / yMax) * plotH;

  const slotW = plotW / PRODEC_BAR_ORDER.length;

  return (
    <View style={styles.wrap}>
      <Svg width={width} height={CHART_H}>
        <Rect
          x={axisX0}
          y={MARGIN_TOP}
          width={plotW}
          height={plotH}
          rx={10}
          ry={10}
          fill={PLOT_FILL}
        />
        <G>
          {ticks.map((t) => {
            const y = yToSvg(t);
            return (
              <G key={`g-${t}-${uid}`}>
                <Line
                  x1={axisX0}
                  y1={y}
                  x2={axisX1}
                  y2={y}
                  stroke={GRID_STROKE}
                  strokeWidth={1}
                />
                <SvgText
                  x={axisX0 - 6}
                  y={y + 4}
                  fontSize={11}
                  fontWeight="500"
                  fill="#4B5563"
                  textAnchor="end"
                >
                  {String(t)}
                </SvgText>
              </G>
            );
          })}
          <Line
            x1={axisX0}
            y1={MARGIN_TOP}
            x2={axisX0}
            y2={baselineY}
            stroke={AXIS_STROKE}
            strokeWidth={1.2}
          />
          <Line
            x1={axisX0}
            y1={baselineY}
            x2={axisX1}
            y2={baselineY}
            stroke={AXIS_STROKE}
            strokeWidth={1.2}
          />
        </G>
        {series.map((s, i) => {
          const cx = axisX0 + (i + 0.5) * slotW;
          const yTop = yToSvg(s.v);
          const stemBottom = baselineY;
          const stemTop = s.v > 0 ? yTop : baselineY;
          return (
            <G key={s.col}>
              {s.v > 0 ? (
                <>
                  <Line
                    x1={cx}
                    y1={stemBottom}
                    x2={cx}
                    y2={stemTop}
                    stroke={s.hex}
                    strokeWidth={2.5}
                    strokeLinecap="round"
                  />
                  <Circle
                    cx={cx}
                    cy={stemTop}
                    r={4.5}
                    fill={s.hex}
                    stroke="#1F2937"
                    strokeWidth={1.2}
                  />
                </>
              ) : (
                <Circle
                  cx={cx}
                  cy={baselineY}
                  r={3}
                  fill="#94A3B8"
                  stroke="#1F2937"
                  strokeWidth={1}
                />
              )}
              <SvgText
                x={cx}
                y={baselineY + 18}
                fontSize={13}
                fontWeight="800"
                fill="#374151"
                textAnchor="middle"
              >
                {s.col}
              </SvgText>
            </G>
          );
        })}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch', marginBottom: 4 },
});

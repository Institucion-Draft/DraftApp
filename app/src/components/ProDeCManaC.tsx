import React, { useId } from 'react';
import { View } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Text as SvgText } from 'react-native-svg';
import { MTG_COLOR_HEX } from './ColorFlag';

type Props = {
  /** Alto del bloque del glifo (escala el SVG completo). */
  size?: number;
};

const OUTLINE = '#111827';
const OUTLINE_W = 2.2;

/**
 * Letra "C" con degradé W→G y contorno oscuro (el blanco no desaparece sobre fondo claro).
 * Separación respecto a "ProDe": entre el tuck original (-0.11×) y el hueco amplio (+0.2×);
 * quedó ~75% del camino de vuelta hacia el tuck (≈ -0.0325× la altura del bloque).
 */
export default function ProDeCManaC({ size = 30 }: Props) {
  const rawId = useId().replace(/:/g, '');
  const gradId = `prodec-mana-${rawId}`;
  const vbW = 28;
  const vbH = 44;
  /** Coordenadas en viewBox; el `height={size}` escala todo junto. */
  const fontSize = 37;
  const yBaseline = 33.5;
  const x0 = 1.5;
  const svgW = size * (vbW / vbH);
  const tuckPrev = -0.11 * size;
  const gapWide = 0.2 * size;
  const marginLeft = Math.round(0.25 * gapWide + 0.75 * tuckPrev);

  return (
    <View
      style={{
        marginLeft,
        height: size,
        justifyContent: 'center',
        alignItems: 'flex-start',
      }}
    >
      <Svg width={svgW} height={size} viewBox={`0 0 ${vbW} ${vbH}`}>
        <Defs>
          <LinearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={MTG_COLOR_HEX.W} />
            <Stop offset="0.25" stopColor={MTG_COLOR_HEX.U} />
            <Stop offset="0.5" stopColor={MTG_COLOR_HEX.B} />
            <Stop offset="0.75" stopColor={MTG_COLOR_HEX.R} />
            <Stop offset="1" stopColor={MTG_COLOR_HEX.G} />
          </LinearGradient>
        </Defs>
        <SvgText
          x={x0}
          y={yBaseline}
          fontSize={fontSize}
          fontWeight="800"
          fill="none"
          stroke={OUTLINE}
          strokeWidth={OUTLINE_W}
          strokeLinejoin="round"
          strokeLinecap="round"
        >
          C
        </SvgText>
        <SvgText x={x0} y={yBaseline} fontSize={fontSize} fontWeight="800" fill={`url(#${gradId})`}>
          C
        </SvgText>
      </Svg>
    </View>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import PlayerAvatar, { RouletteAvatar } from './PlayerAvatar';
import { mateDirection, packDirection, seatSlots, tableLayout, type PackDirection, type SeatSlot } from '../lib/eventSeating';
import { circuitArrows, scatterEmojis, tableBodySize } from '../lib/seatingLayout';
import { useTheme } from '../theme';

export type SeatOccupant = { userId: string; participantId: string; member: 'a' | 'b'; name: string };

type Props = {
  /** Id del evento: de él salen, de forma determinística, los emojis desperdigados antes del sorteo. */
  eventId: string;
  n: number;
  /** Lugar (1..n) -> quien lo ocupa. Vacío antes del sorteo. */
  occupants: Map<number, SeatOccupant>;
  /** Sentido del primer sobre; null antes del sorteo (se ven los emojis desperdigados, sin flechas). */
  direction: PackDirection | null;
  /** Opacidad de los avatares durante la ruleta. */
  blink?: Animated.Value;
  /** Opacidad de cada lugar (índice = lugar - 1), avatar y nombre juntos: fade out / fade in del final de la ruleta. */
  seatFade?: Animated.Value[];
  /** Ruleta en curso: los avatares son livianos y salen sincrónicamente del caché, así cambian junto con el nombre. */
  lite?: boolean;
  /** Los vórtices giran mientras sea true (la pantalla lo pone en false al perder el foco). */
  active?: boolean;
};

/** Una vuelta completa de cada vórtice. */
const SPIN_MS = 4000;

// Colores de CONTENIDO (no de UI) para que la mesa se distinga del fondo en ambos temas. Los lugares son siempre gris claro.
const SEAT_BG = '#E5E7EB';
const SEAT_BORDER = '#9CA3AF';
// Insignia del número: fondo oscuro con texto claro y contorno blanco; se lee igual sobre el cuadrado gris en ambos temas.
const BADGE_BG = '#1F2937';
const BADGE_BORDER = '#FFFFFF';
const BADGE_TXT = '#FFFFFF';
export const TABLE = {
  light: { bg: '#C3CEDB', border: '#64748B', packs: '#4F46E5', mate: '#B45309' },
  dark: { bg: '#475569', border: '#CBD5E1', packs: '#A5B4FC', mate: '#FBBF24' },
} as const;

/** Una sola flecha circular. 'ccw' es la misma flecha espejada: el sentido se lee por la punta, no sólo por el color. */
function VortexArrow({ size, color, direction }: { size: number; color: string; direction: PackDirection }) {
  const c = size / 2;
  const r = size / 2 - 3;
  const pt = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return { x: c + r * Math.sin(a), y: c - r * Math.cos(a) };
  };
  const start = pt(25);
  const end = pt(325);
  // Punta de flecha en `end`, apuntando en el sentido del reloj (tangente = (cos, sin) del ángulo).
  const a = (325 * Math.PI) / 180;
  const tan = { x: Math.cos(a), y: Math.sin(a) };
  const nor = { x: -tan.y, y: tan.x };
  const back = (k: number, s: number) => `${(end.x - tan.x * k + nor.x * s).toFixed(2)} ${(end.y - tan.y * k + nor.y * s).toFixed(2)}`;
  const arc = `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 1 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
  const head = `M ${end.x.toFixed(2)} ${end.y.toFixed(2)} L ${back(7, 4.5)} L ${back(7, -4.5)} Z`;
  return (
    <Svg width={size} height={size} style={{ transform: [{ scaleX: direction === 'ccw' ? -1 : 1 }] }}>
      <Path d={arc} stroke={color} strokeWidth={2.5} fill="none" strokeLinecap="round" />
      <Path d={head} fill={color} />
    </Svg>
  );
}

/**
 * Vórtice: la flecha circular gira sin parar sobre sí misma en su sentido ('cw' = como el reloj, 'ccw' = al revés), con
 * Animated y driver nativo; el emoji queda derecho en el centro. Si `active` es false se detiene (pantalla sin foco).
 * La punta de la flecha y el color siguen indicando el sentido aunque esté quieto.
 */
export function Vortex({ emoji, color, direction, size, active }: { emoji: string; color: string; direction: PackDirection; size: number; active: boolean }) {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) return undefined;
    spin.setValue(0);
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: SPIN_MS, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => {
      loop.stop();
    };
  }, [active, spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: direction === 'cw' ? ['0deg', '360deg'] : ['0deg', '-360deg'] });
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ rotate }] }]}>
        <VortexArrow size={size} color={color} direction={direction} />
      </Animated.View>
      <Text style={{ fontSize: size * 0.42 }}>{emoji}</Text>
    </View>
  );
}

/** Flechas curvas fijas que envuelven la mesa y los lugares formando un óvalo, con la punta en el sentido de los sobres. */
function CircuitOverlay({ width, height, direction, color }: { width: number; height: number; direction: PackDirection; color: string }) {
  if (width <= 0 || height <= 0) return null;
  const arrows = circuitArrows(width, height, direction, { count: 4 });
  return (
    <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">
      {arrows.map((a, i) => (
        <React.Fragment key={i}>
          <Path
            d={`M ${a.points.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ')}`}
            stroke={color}
            strokeWidth={3.5}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <Path d={`M ${a.head.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ')} Z`} fill={color} />
        </React.Fragment>
      ))}
    </Svg>
  );
}

/** Aparece con un fundido corto al montarse (los vórtices y las flechas entran sin "pop" al empezar el sorteo). */
function FadeIn({ children, style }: { children: React.ReactNode; style?: React.ComponentProps<typeof Animated.View>['style'] }) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: 250, useNativeDriver: true }).start();
  }, [opacity]);
  return <Animated.View style={[style, { opacity }]}>{children}</Animated.View>;
}

const PAD_H = 40;
const PAD_V = 36;

/**
 * Mesa rectangular esquemática y vertical: cabeceras arriba y abajo, lados largos a izquierda y derecha, numerada en
 * sentido horario desde la cabecera de arriba. Sin scroll horizontal (el ancho es acotado); el alto crece con los
 * lugares de cada lado (lo absorbe el scroll vertical de la pantalla).
 */
export default function SeatingTable({ eventId, n, occupants, direction, blink, seatFade, lite = false, active = true }: Props) {
  const { colors, mode } = useTheme();
  const pal = TABLE[mode === 'dark' ? 'dark' : 'light'];
  const { width: winW } = useWindowDimensions();
  const [outerSize, setOuterSize] = useState({ w: 0, h: 0 });

  const layout = tableLayout(n);
  const slots = seatSlots(n);
  const usable = Math.min(winW - 32, 420);
  const base = Math.max(38, Math.min(60, Math.floor(usable / 6.5)));
  const sq = layout.perSide > 8 ? Math.min(base, 44) : base;
  const cellW = sq + 10;
  const cellH = sq + 19; // cuadrado + nombre
  const sideColsW = layout.perSide > 0 ? 2 * cellW + 4 : 0;
  const body = tableBodySize(n, usable - 2 * PAD_H - sideColsW, cellH);
  const scatter = React.useMemo(() => scatterEmojis(eventId), [eventId]);

  const slotOf = (zone: SeatSlot['zone'], row = 0) => slots.find((s) => s.zone === zone && s.row === row);

  const renderSeat = (slot: SeatSlot | undefined) => {
    if (!slot) return null;
    const occ = occupants.get(slot.seat);
    const fade = seatFade?.[slot.seat - 1];
    return (
      <View key={slot.seat} style={[styles.cell, { width: cellW }]}>
        <View style={[styles.seat, { width: sq, height: sq }]}>
          <Animated.View style={fade ? { opacity: fade } : undefined}>
            {occ ? (
              <Animated.View style={blink ? { opacity: blink } : undefined}>
                {lite ? (
                  <RouletteAvatar
                    participantId={occ.participantId}
                    isMemberB={occ.member === 'b'}
                    diameter={sq - 14}
                    letter={occ.name.trim().slice(0, 1).toUpperCase() || '?'}
                  />
                ) : (
                  <PlayerAvatar
                    userId={occ.userId}
                    participantId={occ.participantId}
                    isMemberB={occ.member === 'b'}
                    size="small"
                    diameter={sq - 14}
                    withColorBorder={false}
                  />
                )}
              </Animated.View>
            ) : null}
          </Animated.View>
          {/* Insignia con el número: SIEMPRE después del avatar (por encima), fuera del Animated.View que parpadea en la
              ruleta, en la esquina superior izquierda (la esquina de las estrellas shiny es la superior derecha). */}
          <View style={styles.badge} pointerEvents="none">
            <Text style={styles.badgeTxt}>{slot.seat}</Text>
          </View>
        </View>
        <Animated.Text style={[styles.name, { color: colors.text }, fade ? { opacity: fade } : null]} numberOfLines={1}>
          {occ ? occ.name : ' '}
        </Animated.Text>
      </View>
    );
  };

  const sideRows = Array.from({ length: layout.perSide }, (_, i) => i);
  const col = (zone: 'left' | 'right') => (
    <View style={{ width: cellW, height: body.height, justifyContent: 'space-evenly' }}>
      {sideRows.map((r) => renderSeat(slotOf(zone, r)))}
    </View>
  );

  const first = direction;
  const vortexSize = 46;
  return (
    <View
      style={styles.outer}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setOuterSize((prev) => (Math.abs(prev.w - width) < 1 && Math.abs(prev.h - height) < 1 ? prev : { w: width, h: height }));
      }}
    >
      {first ? (
        <FadeIn style={StyleSheet.absoluteFill}>
          <CircuitOverlay width={outerSize.w} height={outerSize.h} direction={first} color={pal.packs} />
        </FadeIn>
      ) : null}
      <View style={styles.layout}>
        {layout.top ? <View style={styles.headerRow}>{renderSeat(slotOf('top'))}</View> : null}
        <View style={styles.middle}>
          {layout.perSide > 0 ? col('left') : null}
          <View style={[styles.body, { width: body.width, height: body.height, backgroundColor: pal.bg, borderColor: pal.border }]}>
            {first ? (
              <FadeIn style={styles.vortexRow}>
                <Vortex emoji="🃏" color={pal.packs} direction={packDirection(first, 1)} size={vortexSize} active={active} />
                <Vortex emoji="🧉" color={pal.mate} direction={mateDirection(first, 1)} size={vortexSize} active={active} />
                <Vortex emoji="🚬" color={pal.mate} direction={mateDirection(first, 1)} size={vortexSize} active={active} />
              </FadeIn>
            ) : (
              scatter.map((s, i) => (
                <Text
                  key={i}
                  style={[styles.scatter, { left: `${s.left * 100}%`, top: `${s.top * 100}%`, transform: [{ rotate: `${s.rotate}deg` }] }]}
                >
                  {s.emoji}
                </Text>
              ))
            )}
          </View>
          {layout.perSide > 0 ? col('right') : null}
        </View>
        {layout.bottom ? <View style={styles.headerRow}>{renderSeat(slotOf('bottom'))}</View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Anillo exterior para las flechas curvas del circuito (fuera de la mesa y de los avatares sentados).
  outer: { alignSelf: 'center', paddingVertical: PAD_V, paddingHorizontal: PAD_H, position: 'relative' },
  layout: { alignItems: 'center' },
  headerRow: { alignItems: 'center' },
  middle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  body: {
    marginHorizontal: 2,
    borderWidth: 2,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  vortexRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 4 },
  scatter: { position: 'absolute', fontSize: 22, lineHeight: 26 },
  cell: { alignItems: 'center' },
  seat: {
    backgroundColor: SEAT_BG,
    borderWidth: 1.5,
    borderColor: SEAT_BORDER,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -6,
    left: -6,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: BADGE_BG,
    borderWidth: 1.5,
    borderColor: BADGE_BORDER,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    elevation: 10,
  },
  badgeTxt: { fontSize: 10, lineHeight: 12, fontWeight: '800', color: BADGE_TXT },
  name: { fontSize: 10, marginTop: 2, maxWidth: '100%', textAlign: 'center' },
});

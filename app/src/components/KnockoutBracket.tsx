/**
 * Cuadro de llaves simétrico de la Copa (sólo llaves): la final al medio, las rondas entrando desde
 * los dos extremos, el 3er y 4to puesto aparte debajo de la final. Colores sólo con tokens del tema.
 * El árbol y las posiciones salen de lib/knockoutBracketModel.ts (puro).
 *
 * Pensado para pantalla horizontal: el ancho sale del contenedor descontando los safe area insets y
 * el alto de las tarjetas se ajusta al alto disponible para que, con 8 jugadores, el cuadro entero
 * (con el 3er y 4to puesto) se vea de una vez. Con más jugadores se admite scroll vertical.
 */
import React, { useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import PlayerAvatar from './PlayerAvatar';
import {
  layoutKnockoutBracket,
  type KnockoutBox,
  type KnockoutBracketModel,
  type KnockoutNode,
} from '../lib/knockoutBracketModel';
import { bracketPhaseTickerName, bracketPhaseTitle } from '../lib/knockoutRounds';
import { useTheme, useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';

type Props = {
  model: KnockoutBracketModel;
  names: Map<string, { userId: string; name: string }>;
  /** Partidas ganadas de verdad (countSeriesWins) por un jugador en la serie del pairing. */
  seriesWins: (pairingId: string | null, participantId: string) => number;
  /** BO3: las píldoras de cada jugador van pegadas bajo su nombre. En BO1 no hay marcador parcial. */
  bo3: boolean;
  /** Alto visible de la pantalla que contiene al cuadro (sin header). Si falta, no se ajusta el alto. */
  viewportHeight?: number;
  onPressMatch: (node: KnockoutNode) => void;
};

const GAP_X = 8;
/** Ancho mínimo legible de una tarjeta. Por debajo se scrollea en horizontal. */
const MIN_CARD_W = 64;
/** Ancho máximo de una tarjeta: con pocas columnas (4 jugadores) no se estira a lo ancho de la pantalla. */
const MAX_CARD_W = 200;
/** Desde este ancho el avatar ocupa todo el alto de su mitad; por debajo se achica para dejarle lugar al texto. */
const WIDE_CARD_W = 118;
/** Diámetro máximo del avatar en tarjetas angostas (16 jugadores). */
const NARROW_AVATAR = 26;
/** Padding mínimo entre el avatar y el borde de su mitad. */
const AVATAR_PAD = 2;
/** Desde este ancho los encabezados de columna usan el título completo de la ronda. */
const FULL_TITLE_W = 96;
const SIDE_PAD = 8;
const HEADER_H = 18;
const THIRD_HEADER_H = 16;
const NAME_LINE = 15;
const PILL_H = 7;
const SECTION_MARGIN = 8;
/** Padding inferior del ScrollView que contiene al cuadro (StandingsScreen, styles.scroll). */
const SCROLL_BOTTOM_PAD = 28;

/** Densidades de la tarjeta, de más a menos holgada: se usa la primera que entra en el alto. */
const TIERS = [
  { pad: 5, pillGap: 3, vGap: 10, minHalf: bo3Half(44, 36) },
  { pad: 3, pillGap: 2, vGap: 8, minHalf: bo3Half(39, 32) },
  { pad: 1, pillGap: 1, vGap: 6, minHalf: bo3Half(34, 28) },
] as const;

/** Alto mínimo de cada mitad por densidad: [BO3, BO1]. */
function bo3Half(withPills: number, withoutPills: number): readonly [number, number] {
  return [withPills, withoutPills];
}

export default function KnockoutBracket({ model, names, seriesWins, bo3, viewportHeight, onPressMatch }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { width: winW } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [measuredW, setMeasuredW] = useState(0);

  // Ancho útil: el del contenedor medido (ya sin los insets, que se aplican como padding).
  const containerW = measuredW > 0 ? measuredW : winW - insets.left - insets.right;
  const availW = containerW - SIDE_PAD * 2;

  // Columnas: sólo depende del árbol (5 con 8 jugadores, 7 con 9 a 16).
  const cols = layoutKnockoutBracket(model, 10, 0, 0).cols;
  const fitW = Math.floor((availW - (cols - 1) * GAP_X) / cols);
  const cardW = Math.min(MAX_CARD_W, Math.max(MIN_CARD_W, fitW));
  const wide = cardW >= WIDE_CARD_W;

  // La mitad mide lo que pide su bloque de texto (nombre + píldoras) o el mínimo de la densidad, el mayor.
  const halfHeight = (tier: (typeof TIERS)[number]) =>
    Math.max(
      tier.pad * 2 + NAME_LINE + (bo3 ? tier.pillGap + PILL_H : 0),
      bo3 ? tier.minHalf[0] : tier.minHalf[1]
    );

  const availBodyH =
    viewportHeight != null && viewportHeight > 0
      ? viewportHeight - Math.max(SCROLL_BOTTOM_PAD, insets.bottom) - HEADER_H - SECTION_MARGIN * 2
      : Infinity;
  let tier: (typeof TIERS)[number] = TIERS[0];
  let layout = layoutKnockoutBracket(model, halfHeight(tier) * 2 + 1, tier.vGap, THIRD_HEADER_H + 8);
  for (const candidate of TIERS) {
    const l = layoutKnockoutBracket(model, halfHeight(candidate) * 2 + 1, candidate.vGap, THIRD_HEADER_H + 8);
    tier = candidate;
    layout = l;
    if (l.bodyHeight <= availBodyH) break;
  }
  const halfH = halfHeight(tier);
  const cardH = halfH * 2 + 1;

  const totalW = layout.cols * cardW + (layout.cols - 1) * GAP_X;
  const needsScroll = totalW > availW;
  const colX = (col: number) => col * (cardW + GAP_X);
  // Avatar: todo el alto de su mitad menos un padding mínimo; en tarjetas angostas, más chico.
  const avatarD = Math.round(wide ? halfH - AVATAR_PAD * 2 : Math.min(halfH - AVATAR_PAD * 2, NARROW_AVATAR));
  const nameStyle = { fontSize: cardW >= 150 ? 13 : wide ? 12 : 11 };
  const roundLabel = (round: Parameters<typeof bracketPhaseTitle>[0]) =>
    cardW >= FULL_TITLE_W ? bracketPhaseTitle(round) : bracketPhaseTickerName(round);

  const linkPath = (l: (typeof layout.links)[number]) => {
    const x1 = l.side === 'left' ? colX(l.fromCol) + cardW : colX(l.fromCol);
    const x2 = l.side === 'left' ? colX(l.toCol) : colX(l.toCol) + cardW;
    const mid = (x1 + x2) / 2;
    return `M ${x1} ${l.fromY} H ${mid} V ${l.toY} H ${x2}`;
  };

  const pills = (wins: number) => (
    <View style={styles.pillsRow}>
      <View style={[styles.pill, wins >= 1 && styles.pillFilled]} />
      <View style={[styles.pill, wins >= 2 && styles.pillFilled]} />
    </View>
  );

  /**
   * Una mitad de la tarjeta, en fila: avatar a la izquierda (todo el alto de la mitad) y, a su derecha,
   * un bloque de dos líneas centrado: arriba nombre + píldoras abajo (jugador A), o píldoras arriba +
   * nombre abajo (jugador B), de modo que las píldoras quedan pegadas al divisor del medio.
   * Sin jugador, la mitad queda vacía.
   */
  const renderHalf = (node: KnockoutNode, participantId: string | null, isTop: boolean, showPills: boolean) => {
    const decided = node.winnerId != null && !node.isBye;
    const isWinner = decided && participantId != null && node.winnerId === participantId;
    const isLoser = decided && participantId != null && node.winnerId !== participantId;
    const halfStyle = [
      styles.half,
      { height: halfH },
      isWinner && styles.halfWin,
      isLoser && styles.halfLose,
    ];
    const divider = !isTop ? styles.dividerTop : null;
    if (participantId == null) {
      // Un lugar sin definir queda vacío, sin texto.
      return <View style={[halfStyle, divider, styles.halfEmpty]} />;
    }
    const info = names.get(participantId);
    // PlayerAvatar recibe el diámetro real: el sprite se dibuja a ese tamaño, sin escalar la vista.
    const avatar = info ? (
      <View style={{ marginLeft: AVATAR_PAD }}>
        <PlayerAvatar
          userId={info.userId}
          participantId={participantId}
          size="small"
          diameter={avatarD}
          withColorBorder={false}
        />
      </View>
    ) : (
      <View style={{ width: avatarD, marginLeft: AVATAR_PAD }} />
    );
    const nameEl = (
      <Text
        style={[styles.name, nameStyle]}
        numberOfLines={1}
        ellipsizeMode="tail"
        adjustsFontSizeToFit
        minimumFontScale={0.7}
      >
        {info?.name ?? 'Jugador'}
      </Text>
    );
    const pillsEl = bo3 && showPills ? pills(seriesWins(node.pairingId, participantId)) : <View style={styles.pillsSpacer} />;
    const hasPillSlot = bo3;
    return (
      <View style={[halfStyle, divider]}>
        {avatar}
        <View
          style={[
            styles.textBlock,
            { paddingVertical: tier.pad },
            hasPillSlot ? styles.textBlockSpread : styles.textBlockCentered,
          ]}
        >
          {isTop ? (
            <>
              {nameEl}
              {hasPillSlot ? pillsEl : null}
            </>
          ) : (
            <>
              {hasPillSlot ? pillsEl : null}
              {nameEl}
            </>
          )}
        </View>
      </View>
    );
  };

  const renderCard = (box: KnockoutBox) => {
    const node = box.node;
    // Pase directo (bye): no se dibuja la tarjeta del jugador; queda un hueco apagado, del mismo tamaño,
    // que mantiene la simetría. El jugador se ve únicamente en su tarjeta de la ronda siguiente.
    if (node.isBye) {
      return (
        <View
          key={node.slotId}
          style={[
            styles.ghost,
            { position: 'absolute' as const, left: colX(box.col), top: box.yCenter - cardH / 2, width: cardW, height: cardH },
          ]}
        />
      );
    }
    const bothDefined = node.participantAId != null && node.participantBId != null;
    const tappable = bothDefined && !node.isBye && node.pairingId != null && node.bracketMatchId != null;
    const isFinal = node.round === 'final';
    const cardStyle = [
      styles.card,
      isFinal && styles.cardFinal,
      { position: 'absolute' as const, left: colX(box.col), top: box.yCenter - cardH / 2, width: cardW, height: cardH },
    ];
    // BO3: todo jugador definido muestra sus dos píldoras (vacías si todavía no ganó partidas), aunque el
    // rival no esté definido o el cruce no tenga pairing. Los byes no tienen serie.
    const showPills = !node.isBye;
    const inner = (
      <>
        {renderHalf(node, node.participantAId, true, showPills)}
        {renderHalf(node, node.participantBId, false, showPills)}
      </>
    );
    return tappable ? (
      <TouchableOpacity key={node.slotId} style={cardStyle} activeOpacity={0.7} onPress={() => onPressMatch(node)}>
        {inner}
      </TouchableOpacity>
    ) : (
      <View key={node.slotId} style={cardStyle}>
        {inner}
      </View>
    );
  };

  const body = (
    <View style={{ width: totalW }}>
      <View style={{ width: totalW, height: HEADER_H }}>
        {layout.columnRounds.map((round, col) => (
          <Text
            key={`hdr-${col}`}
            style={[styles.hdr, { position: 'absolute', left: colX(col), width: cardW }]}
            numberOfLines={1}
          >
            {roundLabel(round)}
          </Text>
        ))}
      </View>
      <View style={{ width: totalW, height: layout.bodyHeight }}>
        <Svg width={totalW} height={layout.bodyHeight} style={StyleSheet.absoluteFill} pointerEvents="none">
          {layout.links.filter((l) => !l.fromIsBye).map((l, i) => (
            <Path key={`lk-${i}`} d={linkPath(l)} stroke={colors.borderStrong} strokeWidth={1} fill="none" />
          ))}
        </Svg>
        {layout.boxes.map(renderCard)}
        {layout.thirdBox ? (
          <>
            <Text
              style={[
                styles.hdr,
                {
                  position: 'absolute',
                  left: colX(layout.thirdBox.col),
                  width: cardW,
                  top: layout.thirdBox.yCenter - cardH / 2 - THIRD_HEADER_H,
                },
              ]}
              numberOfLines={1}
            >
              {roundLabel('third_place')}
            </Text>
            {renderCard(layout.thirdBox)}
          </>
        ) : null}
      </View>
    </View>
  );

  return (
    <View style={[styles.section, { paddingLeft: insets.left, paddingRight: insets.right }]}>
      <View
        style={styles.measure}
        onLayout={(e) => {
          const w = Math.round(e.nativeEvent.layout.width);
          if (w !== measuredW) setMeasuredW(w);
        }}
      >
        {needsScroll ? (
          <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.scrollContent}>
            {body}
          </ScrollView>
        ) : (
          <View style={styles.centered}>{body}</View>
        )}
      </View>
    </View>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    section: { marginTop: SECTION_MARGIN, marginBottom: SECTION_MARGIN, width: '100%' },
    measure: { width: '100%' },
    centered: { alignItems: 'center' },
    scrollContent: { paddingHorizontal: SIDE_PAD },
    hdr: { fontSize: 11, color: c.textSecondary, fontWeight: '700', textAlign: 'center' },
    card: {
      backgroundColor: c.background,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.border,
      overflow: 'hidden',
      ...Platform.select({
        ios: {
          shadowColor: c.shadow,
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.06,
          shadowRadius: 3,
        },
        android: { elevation: 1 },
        default: {},
      }),
    },
    // Hueco de un pase directo: sólo un borde tenue, sin texto ni avatar.
    ghost: {
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.border,
      opacity: 0.35,
    },
    cardFinal: { backgroundColor: c.card, borderWidth: 1.5, borderColor: c.textMuted },
    // Cada mitad es una fila: avatar a la izquierda y bloque de texto a la derecha.
    half: { flexDirection: 'row', alignItems: 'center', paddingRight: 6 },
    halfEmpty: { justifyContent: 'center', paddingLeft: 6 },
    // Único divisor interno de la tarjeta: el del medio.
    dividerTop: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.borderStrong },
    halfWin: { backgroundColor: c.status.warning.subtle },
    halfLose: { opacity: 0.45 },
    // Bloque de dos líneas a la derecha del avatar: ocupa todo el alto de la mitad, centrado en horizontal.
    textBlock: { flex: 1, minWidth: 0, alignSelf: 'stretch', alignItems: 'center', marginLeft: 6 },
    textBlockSpread: { justifyContent: 'space-between' },
    textBlockCentered: { justifyContent: 'center' },
    name: { fontWeight: '600', color: c.text, textAlign: 'center', alignSelf: 'stretch' },
    pillsSpacer: { height: PILL_H },
    pillsRow: { flexDirection: 'row', justifyContent: 'center' },
    pill: {
      width: 14,
      height: PILL_H,
      borderRadius: 2,
      borderWidth: 1,
      borderColor: c.borderStrong,
      marginHorizontal: 2,
    },
    pillFilled: { backgroundColor: c.accent, borderColor: c.accent },
  });
}

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ConfettiCannon from 'react-native-confetti-cannon';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import type { MtgColor } from '../lib/database.types';
import PlayerAvatar, { type PlayerAvatarSize } from '../components/PlayerAvatar';
import ColorFlag from '../components/ColorFlag';
import { resolveGenderedText, type Gender } from '../lib/genderText';
import {
  computePodium,
  type PodiumState,
  type ActiveTiebreakGroupPodiumInput,
  type TiebreakMatchPodiumInput,
  type BracketMatchPodiumInput,
} from '../lib/podium';

/** Igual que `styles.podiumCol.width`: ancho útil de la fila de avatares del step. */
const PODIUM_COL_WIDTH = 132;
const PODIUM_AVATAR_ROW_GAP = 6;
const AVATAR_BORDER_W = 2;
const AVATAR_DIAM_MEDIUM = 48;
const AVATAR_DIAM_SMALL = 32;
const AVATAR_DIAM_TINY = 24;

function avatarOuterApprox(diameterPx: number): number {
  return diameterPx + 2 * AVATAR_BORDER_W;
}

function podiumRowMinWidthPx(n: number, diameterPx: number, gapPx: number): number {
  if (n <= 0) return 0;
  return diameterPx * n + gapPx * (n - 1);
}

type Props = NativeStackScreenProps<MainStackParamList, 'Standings'>;

type RowView = {
  participantId: string;
  userId: string;
  name: string;
  colors: MtgColor[];
  pg: number;
  pj: number;
  eg: number;
  /** Enfrentamientos con BO3 cerrado (ganados o perdidos). */
  ec: number;
  /** swiss_bo2: partidas individuales finalizadas (match_type='draft', status='completed'). */
  pf: number;
  /** Diferencial medio de vida (sin tracking de turnos); null si no aplica o sin datos. */
  dmv: number | null;
  /** DMV por turnos (evento con turn_tracking_enabled); null si no aplica o sin datos. */
  dmvt: number | null;
  /** Tiempo medio por partida (s); null si no hay partidas completadas con duración. */
  tmp: number | null;
  swissPoints: number;
  swissOmw: number | null;
  swissGw: number | null;
  swissOgw: number | null;
  /** Suizo: bye en ronda ya cerrada (todos los pairings con official_winner). */
  showCompletedByeL: boolean;
  inProgress: boolean;
  leftEventAt: string | null;
  gender: Gender | null;
};

type RevengeRowView = {
  participantId: string;
  userId: string;
  name: string;
  colors: MtgColor[];
  vg: number;
  vj: number;
  cv: number;
  sc: number;
  /** Match de venganza en curso en alguno de sus pairings. */
  inProgress: boolean;
  leftEventAt: string | null;
  gender: Gender | null;
};

type LifeEvRow = { match_id: string; participant_id: string; resulting_life: number; occurred_at: string };

type SwissTopcutPlayerSlot = {
  kind: 'player';
  participantId: string;
  userId: string;
  name: string;
  seed: number;
};

type SwissTopcutPlaceholderSlot = { kind: 'placeholder'; label: string };

type SwissTopcutNodeSlot = SwissTopcutPlayerSlot | SwissTopcutPlaceholderSlot;

type SwissTopcutSemiView = {
  top: SwissTopcutNodeSlot;
  bottom: SwissTopcutNodeSlot;
  winnerParticipantId: string | null;
  /** Raw match ids for loser resolution */
  participantAId: string;
  participantBId: string;
};

type SwissTopcutBracketView = {
  semi1: SwissTopcutSemiView;
  semi2: SwissTopcutSemiView;
  finalTop: SwissTopcutNodeSlot;
  finalBottom: SwissTopcutNodeSlot;
  finalWinnerParticipantId: string | null;
  thirdTop: SwissTopcutNodeSlot;
  thirdBottom: SwissTopcutNodeSlot;
  thirdWinnerParticipantId: string | null;
};

function buildSwissTopcutBracketModel(
  gpRows: { participant_id: string; user_id: string; seed: number }[],
  matches: BracketMatchPodiumInput[],
  infoByParticipantId: Map<string, { userId: string; name: string }>
): SwissTopcutBracketView | null {
  const seedByPid = new Map<string, number>();
  for (const r of gpRows) {
    seedByPid.set(String(r.participant_id), Number(r.seed));
  }
  const slot = (pid: string): SwissTopcutPlayerSlot | null => {
    const s = seedByPid.get(pid);
    if (s == null || !Number.isFinite(s)) return null;
    const info = infoByParticipantId.get(pid);
    return {
      kind: 'player',
      participantId: pid,
      userId: info?.userId ?? '',
      name: info?.name ?? 'Jugador',
      seed: s,
    };
  };

  const semis = matches.filter((m) => m.bracket_phase === 'semi');
  if (semis.length < 2) return null;

  const seedsOf = (m: BracketMatchPodiumInput) => ({
    sa: seedByPid.get(m.participant_a_id),
    sb: seedByPid.get(m.participant_b_id),
  });

  let semi14: BracketMatchPodiumInput | null = null;
  let semi23: BracketMatchPodiumInput | null = null;
  for (const m of semis) {
    const { sa, sb } = seedsOf(m);
    const set = new Set([sa, sb].filter((x) => x != null) as number[]);
    if (set.has(1) && set.has(4)) semi14 = m;
    else if (set.has(2) && set.has(3)) semi23 = m;
  }
  if (!semi14 || !semi23) return null;

  const s1a = slot(semi14.participant_a_id);
  const s1b = slot(semi14.participant_b_id);
  if (!s1a || !s1b) return null;
  const topSf1 = s1a.seed === 1 ? s1a : s1b.seed === 1 ? s1b : null;
  const botSf1 = s1a.seed === 4 ? s1a : s1b.seed === 4 ? s1b : null;
  if (!topSf1 || !botSf1) return null;
  const semi1View: SwissTopcutSemiView = {
    top: topSf1,
    bottom: botSf1,
    winnerParticipantId: semi14.winner_participant_id,
    participantAId: semi14.participant_a_id,
    participantBId: semi14.participant_b_id,
  };

  const pa2 = slot(semi23.participant_a_id);
  const pb2 = slot(semi23.participant_b_id);
  if (!pa2 || !pb2) return null;
  const topSf2 = pa2.seed === 3 ? pa2 : pb2.seed === 3 ? pb2 : null;
  const bottomSf2 = pa2.seed === 2 ? pa2 : pb2.seed === 2 ? pb2 : null;
  if (!topSf2 || !bottomSf2) return null;

  const semi2View: SwissTopcutSemiView = {
    top: topSf2,
    bottom: bottomSf2,
    winnerParticipantId: semi23.winner_participant_id,
    participantAId: semi23.participant_a_id,
    participantBId: semi23.participant_b_id,
  };

  const loserOf = (semi: SwissTopcutSemiView): string | null => {
    const w = semi.winnerParticipantId;
    if (!w) return null;
    if (w === semi.participantAId) return semi.participantBId;
    if (w === semi.participantBId) return semi.participantAId;
    return null;
  };

  const finalM = matches.find((m) => m.bracket_phase === 'final');
  const thirdM = matches.find((m) => m.bracket_phase === 'third_place');

  const wSf1 = semi1View.winnerParticipantId;
  const wSf2 = semi2View.winnerParticipantId;

  let finalTop: SwissTopcutNodeSlot;
  let finalBottom: SwissTopcutNodeSlot;
  let finalWinner = finalM?.winner_participant_id ?? null;

  if (finalM) {
    const ta = slot(finalM.participant_a_id);
    const tb = slot(finalM.participant_b_id);
    finalTop = ta ?? { kind: 'placeholder', label: 'Ganador SF1' };
    finalBottom = tb ?? { kind: 'placeholder', label: 'Ganador SF2' };
  } else if (wSf1 && wSf2) {
    const a = slot(wSf1);
    const b = slot(wSf2);
    finalTop = a ?? { kind: 'placeholder', label: 'Ganador SF1' };
    finalBottom = b ?? { kind: 'placeholder', label: 'Ganador SF2' };
  } else {
    finalTop = wSf1 ? (slot(wSf1) ?? { kind: 'placeholder', label: 'Ganador SF1' }) : { kind: 'placeholder', label: 'Ganador SF1' };
    finalBottom = wSf2 ? (slot(wSf2) ?? { kind: 'placeholder', label: 'Ganador SF2' }) : { kind: 'placeholder', label: 'Ganador SF2' };
  }

  let thirdTop: SwissTopcutNodeSlot;
  let thirdBottom: SwissTopcutNodeSlot;
  let thirdWinner = thirdM?.winner_participant_id ?? null;

  if (thirdM) {
    const ta = slot(thirdM.participant_a_id);
    const tb = slot(thirdM.participant_b_id);
    thirdTop = ta ?? { kind: 'placeholder', label: 'Perdedor SF1' };
    thirdBottom = tb ?? { kind: 'placeholder', label: 'Perdedor SF2' };
  } else {
    const l1 = loserOf(semi1View);
    const l2 = loserOf(semi2View);
    if (l1 && l2) {
      thirdTop = slot(l1) ?? { kind: 'placeholder', label: 'Perdedor SF1' };
      thirdBottom = slot(l2) ?? { kind: 'placeholder', label: 'Perdedor SF2' };
    } else {
      thirdTop = { kind: 'placeholder', label: 'Perdedor SF1' };
      thirdBottom = { kind: 'placeholder', label: 'Perdedor SF2' };
    }
  }

  return {
    semi1: semi1View,
    semi2: semi2View,
    finalTop,
    finalBottom,
    finalWinnerParticipantId: finalWinner,
    thirdTop,
    thirdBottom,
    thirdWinnerParticipantId: thirdWinner,
  };
}

type MatchTurnRow = {
  match_id: string;
  turn_number: number;
  life_a_after: number;
  life_b_after: number;
};

/**
 * DMVt del match: promedio de (vida propia − vida oponente) después de cada turno válido.
 * Turnos válidos: desde el primer turno con vida distinta de 20-20 hasta el penúltimo turno (excluye el que cierra).
 */
function computeMatchDmvt(turns: MatchTurnRow[], myPid: string, pa: string, pb: string): number | null {
  if (turns.length === 0) return null;
  const sorted = [...turns].sort((a, b) => a.turn_number - b.turn_number);
  const maxTurnNum = sorted[sorted.length - 1]!.turn_number;
  let firstChangeNum: number | null = null;
  for (const t of sorted) {
    if (t.life_a_after !== 20 || t.life_b_after !== 20) {
      firstChangeNum = t.turn_number;
      break;
    }
  }
  if (firstChangeNum == null) return null;
  const lastValidTurnNum = maxTurnNum - 1;
  if (firstChangeNum > lastValidTurnNum) return null;

  const myAfter = (t: MatchTurnRow) => (myPid === pa ? t.life_a_after : t.life_b_after);
  const oppAfter = (t: MatchTurnRow) => (myPid === pa ? t.life_b_after : t.life_a_after);

  const valid = sorted.filter(
    (t) => t.turn_number >= firstChangeNum && t.turn_number <= lastValidTurnNum
  );
  if (valid.length === 0) return null;

  let sum = 0;
  for (const t of valid) {
    sum += myAfter(t) - oppAfter(t);
  }
  return sum / valid.length;
}

const DMV_POS = '#10B981';
const DMV_NEG = '#EF4444';
const DMV_GRAY = '#6B7280';

function parseEventMs(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * DMV del match: promedio temporal de (vida_propia − vida_oponente) entre el primer y último
 * life_event. Solo estados después de cada evento i y antes de i+1 (el post-último evento no cuenta).
 * Peso dur_i / (lastEventTime − firstEventTime); se incluyen todos los diffs, también 0.
 */
function computeMatchDmv(events: LifeEvRow[], myPid: string, oppPid: string): number | null {
  const filtered = events.filter((e) => {
    const pid = String(e.participant_id);
    return pid === myPid || pid === oppPid;
  });
  if (filtered.length < 2) return null;

  const sorted = [...filtered].sort((a, b) => {
    const dt = parseEventMs(String(a.occurred_at)) - parseEventMs(String(b.occurred_at));
    if (dt !== 0) return dt;
    return String(a.participant_id).localeCompare(String(b.participant_id));
  });

  const tFirst = parseEventMs(String(sorted[0]!.occurred_at));
  const tLast = parseEventMs(String(sorted[sorted.length - 1]!.occurred_at));
  const duracionEfectiva = tLast - tFirst;
  if (!Number.isFinite(tFirst) || !Number.isFinite(tLast) || duracionEfectiva <= 0) return null;

  const apply = (ev: LifeEvRow, life: { my: number; opp: number }) => {
    const pid = String(ev.participant_id);
    if (pid === myPid) life.my = Number(ev.resulting_life);
    else life.opp = Number(ev.resulting_life);
  };

  const life = { my: 20, opp: 20 };
  apply(sorted[0]!, life);

  let weightedSum = 0;
  const n = sorted.length;
  for (let i = 0; i < n - 1; i++) {
    const durI = parseEventMs(String(sorted[i + 1]!.occurred_at)) - parseEventMs(String(sorted[i]!.occurred_at));
    const diffI = life.my - life.opp;
    weightedSum += diffI * (durI / duracionEfectiva);
    if (i < n - 2) {
      apply(sorted[i + 1]!, life);
    }
  }

  return weightedSum;
}

function formatDmvCell(dmv: number | null): string {
  if (dmv == null) return '—';
  const rounded = Math.round(dmv * 10) / 10;
  if (rounded > 0) return `+${rounded.toFixed(1)}`;
  if (rounded === 0) return '0.0';
  return rounded.toFixed(1);
}

function dmvCellColor(dmv: number | null): string {
  if (dmv == null) return DMV_GRAY;
  if (dmv > 1e-9) return DMV_POS;
  if (dmv < -1e-9) return DMV_NEG;
  return DMV_GRAY;
}

/** TMP en minutos para la tabla; cálculo interno sigue en segundos. */
function formatTmpDisplay(tmpSeconds: number | null): string {
  if (tmpSeconds == null || !Number.isFinite(tmpSeconds)) return '—';
  const minutes = tmpSeconds / 60;
  if (minutes < 10) {
    return `${minutes.toFixed(1).replace('.', ',')} min`;
  }
  return `${Math.round(minutes)} min`;
}

/** Porcentaje con un decimal y coma (0–100 como fracción del total). */
function formatPctOneDecimal(fraction: number): string {
  if (!Number.isFinite(fraction)) return '0,0%';
  const pct = fraction * 100;
  return `${pct.toFixed(1).replace('.', ',')}%`;
}

/** Porcentaje suizo (OMW%, GW%): 1 decimal si hace falta; "33%" sin coma si es entero. No usar con null: usar celda "—" explícita. */
function formatSwissPctDisplay(rate: number): string {
  if (!Number.isFinite(rate)) return '—';
  const pct = rate * 100;
  const rounded = Math.round(pct * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 1e-9) return `${Math.round(rounded)}%`;
  return `${rounded.toFixed(1).replace('.', ',')}%`;
}

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

/** Ronda suiza cerrada: todos los pairings de esa ronda tienen ganador oficial o empate (swiss_bo2). */
function isSwissRoundFullyResolved(
  pairings: {
    swiss_round?: number | string | null;
    official_winner_participant_id?: string | null;
    official_draw?: boolean | null;
  }[],
  round: number
): boolean {
  const inRound = pairings.filter((pr) => Number(pr.swiss_round) === round);
  if (inRound.length === 0) return false;
  return inRound.every((pr) => pr.official_winner_participant_id != null || pr.official_draw === true);
}

/** Tamaño por cantidad y por si caben con `gap` en el peldaño (misma lógica en 1º, 2º y 3º). */
function podiumStepAvatarSize(nInStep: number): PlayerAvatarSize {
  const w = PODIUM_COL_WIDTH;
  const g = PODIUM_AVATAR_ROW_GAP;

  if (nInStep <= 1) return 'large';

  if (nInStep === 2) {
    if (w < podiumRowMinWidthPx(2, avatarOuterApprox(AVATAR_DIAM_MEDIUM), g)) return 'small';
    return 'medium';
  }

  if (nInStep <= 4) {
    if (w < podiumRowMinWidthPx(nInStep, avatarOuterApprox(AVATAR_DIAM_SMALL), g)) return 'tiny';
    return 'small';
  }

  return 'tiny';
}

/** Ciclo ~1.2s; opacidad 1 ↔ 0.3. Usa `View` (no anidar en `Text`) para que `useNativeDriver` componga bien. */
const PULSE_HALF_MS = 600;

function PulsingLiveDot() {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.3, duration: PULSE_HALF_MS, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: PULSE_HALF_MS, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [opacity]);
  return (
    <Animated.View style={[styles.liveDotWrap, { opacity }]} accessibilityLabel="En juego">
      <Text style={styles.liveDot}>●</Text>
    </Animated.View>
  );
}

type Bo3Footer = {
  pct20: string;
  pct21: string;
  bold20: boolean;
  bold21: boolean;
};

type EventFooterStats = { torneo: string | null; bo3: Bo3Footer | null };

const STC_ROW_H = 46;

function SwissTopcutBracketBlock({ model }: { model: SwissTopcutBracketView }) {
  const winW = Dimensions.get('window').width;
  const totalW = Math.min(Math.max(winW - 24, 300), 540);
  const gap = Math.max(30, Math.round(totalW * 0.07));
  const finalW = Math.min(196, Math.round(totalW * 0.36));
  const semiW = Math.floor((totalW - 2 * gap - finalW) / 2);
  const cardH = STC_ROW_H * 2 + 1;
  const yTop = STC_ROW_H / 2;
  const yBot = STC_ROW_H + 1 + STC_ROW_H / 2;
  const semi1Right = semiW;
  const finalLeft = semiW + gap;
  const finalRight = semiW + gap + finalW;
  const semi2Left = finalRight + gap;
  const hStub = Math.min(20, gap * 0.42);
  const midL = semi1Right + hStub;
  const midR = semi2Left - hStub;
  const jog = 10;
  const dLeftTop = `M ${semi1Right} ${yTop} L ${midL} ${yTop} L ${midL} ${yTop + jog} L ${finalLeft} ${yTop + jog} L ${finalLeft} ${yTop}`;
  const dLeftBot = `M ${semi1Right} ${yBot} L ${midL} ${yBot} L ${midL} ${yBot - jog} L ${finalLeft} ${yBot - jog} L ${finalLeft} ${yBot}`;
  const dRightTop = `M ${semi2Left} ${yTop} L ${midR} ${yTop} L ${midR} ${yTop + jog} L ${finalRight} ${yTop + jog} L ${finalRight} ${yTop}`;
  const dRightBot = `M ${semi2Left} ${yBot} L ${midR} ${yBot} L ${midR} ${yBot - jog} L ${finalRight} ${yBot - jog} L ${finalRight} ${yBot}`;

  const finalDecided = model.finalWinnerParticipantId != null;
  const finalWinnerId = model.finalWinnerParticipantId;

  const rowHighlight = (
    slot: SwissTopcutNodeSlot,
    winnerPid: string | null,
    matchDone: boolean
  ): 'none' | 'win' | 'lose' => {
    if (slot.kind !== 'player') return 'none';
    if (!matchDone || winnerPid == null) return 'none';
    if (winnerPid === slot.participantId) return 'win';
    return 'lose';
  };

  const renderMatchRow = (
    slot: SwissTopcutNodeSlot,
    hi: 'none' | 'win' | 'lose',
    text: string,
    opts: { isTop: boolean; showCrown: boolean }
  ) => {
    const rowStyle = [
      styles.tcMatchRow,
      !opts.isTop && styles.tcMatchRowBorder,
      hi === 'win' && styles.tcMatchRowWin,
      hi === 'lose' && styles.tcMatchRowLose,
    ];
    if (slot.kind === 'placeholder') {
      return (
        <View style={rowStyle}>
          <View style={styles.tcPhAvatarSm} />
          <Text style={styles.tcMatchNamePh} numberOfLines={1} ellipsizeMode="tail">
            {slot.label}
          </Text>
        </View>
      );
    }
    return (
      <View style={rowStyle}>
        <PlayerAvatar
          userId={slot.userId}
          participantId={slot.participantId}
          size="small"
          withColorBorder={false}
        />
        <Text style={styles.tcMatchName} numberOfLines={1} ellipsizeMode="tail">
          {opts.showCrown ? `${text} 👑` : text}
        </Text>
      </View>
    );
  };

  const semiCard = (semi: SwissTopcutSemiView) => {
    const done = semi.winnerParticipantId != null;
    const topHi = rowHighlight(semi.top, semi.winnerParticipantId, done);
    const botHi = rowHighlight(semi.bottom, semi.winnerParticipantId, done);
    const topLabel = semi.top.kind === 'player' ? `${semi.top.seed}°` : semi.top.label;
    const botLabel = semi.bottom.kind === 'player' ? `${semi.bottom.seed}°` : semi.bottom.label;
    return (
      <View style={[styles.tcMatchCard, { width: semiW }]}>
        {renderMatchRow(semi.top, topHi, topLabel, { isTop: true, showCrown: false })}
        {renderMatchRow(semi.bottom, botHi, botLabel, { isTop: false, showCrown: false })}
      </View>
    );
  };

  const topHiF = rowHighlight(model.finalTop, finalWinnerId, finalDecided);
  const botHiF = rowHighlight(model.finalBottom, finalWinnerId, finalDecided);
  const topTextF = model.finalTop.kind === 'player' ? model.finalTop.name : model.finalTop.label;
  const botTextF = model.finalBottom.kind === 'player' ? model.finalBottom.name : model.finalBottom.label;
  const crownTop =
    finalDecided &&
    model.finalTop.kind === 'player' &&
    finalWinnerId === model.finalTop.participantId;
  const crownBot =
    finalDecided &&
    model.finalBottom.kind === 'player' &&
    finalWinnerId === model.finalBottom.participantId;

  return (
    <View style={styles.tcSection}>
      <View style={[styles.tcBracketOuter, { width: totalW, alignSelf: 'center' }]}>
        <View style={[styles.tcHdrRow, { width: totalW }]}>
          <Text style={[styles.tcHdrCol, { width: semiW }]}>Semifinal</Text>
          <View style={{ width: gap }} />
          <Text style={[styles.tcHdrCol, { width: finalW }]}>Final</Text>
          <View style={{ width: gap }} />
          <Text style={[styles.tcHdrCol, { width: semiW }]}>Semifinal</Text>
        </View>
        <View style={[styles.tcBodyWrap, { width: totalW, height: cardH }]}>
          <Svg
            width={totalW}
            height={cardH}
            style={StyleSheet.absoluteFillObject}
            pointerEvents="none"
          >
            <Path d={dLeftTop} stroke="#9CA3AF" strokeWidth={1.25} fill="none" />
            <Path d={dLeftBot} stroke="#9CA3AF" strokeWidth={1.25} fill="none" />
            <Path d={dRightTop} stroke="#9CA3AF" strokeWidth={1.25} fill="none" />
            <Path d={dRightBot} stroke="#9CA3AF" strokeWidth={1.25} fill="none" />
          </Svg>
          <View style={[styles.tcBodyRow, { width: totalW }]}>
            {semiCard(model.semi1)}
            <View style={{ width: gap }} />
            <View style={[styles.tcMatchCard, styles.tcMatchCardFinal, { width: finalW }]}>
              {renderMatchRow(model.finalTop, topHiF, topTextF, {
                isTop: true,
                showCrown: crownTop,
              })}
              {renderMatchRow(model.finalBottom, botHiF, botTextF, {
                isTop: false,
                showCrown: crownBot,
              })}
            </View>
            <View style={{ width: gap }} />
            {semiCard(model.semi2)}
          </View>
        </View>
      </View>
    </View>
  );
}

export default function StandingsScreen({ route, navigation }: Props) {
  const { eventId, showPodiumIntro } = route.params;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rows, setRows] = useState<RowView[]>([]);
  const [revengeRows, setRevengeRows] = useState<RevengeRowView[]>([]);
  const [tab, setTab] = useState<'official' | 'revenge'>('official');
  const [eventFooter, setEventFooter] = useState<EventFooterStats>({ torneo: null, bo3: null });
  const [podiumState, setPodiumState] = useState<PodiumState | null>(null);
  const [swissTopcutBracketView, setSwissTopcutBracketView] = useState<SwissTopcutBracketView | null>(null);
  const [eventStatusStored, setEventStatusStored] = useState<string | null>(null);
  const [showConfettiOnce, setShowConfettiOnce] = useState(false);
  const [turnTrackingEnabled, setTurnTrackingEnabled] = useState(false);
  const [competitionFormat, setCompetitionFormat] = useState<'round_robin' | 'swiss'>('round_robin');
  /** True cuando el formato real es swiss_bo2 (mapeado a 'swiss' para comportamiento, separado para display). */
  const [isSwissBo2, setIsSwissBo2] = useState(false);
  /** Suizo completado: nombre + campeón/campeona (sin otras estadísticas en el banner ni en la meta junto al banner). */
  const [swissChampionName, setSwissChampionName] = useState<string | null>(null);
  const [swissChampionHonorific, setSwissChampionHonorific] = useState<string | null>(null);
  const [eventChampionUserId, setEventChampionUserId] = useState<string | null>(null);
  const [eventChampionIsShiny, setEventChampionIsShiny] = useState(false);
  const firstRef = useRef(true);
  const standingsChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'EventDetail', { eventId }),
    });
  }, [navigation, eventId]);

  const load = useCallback(async () => {
    let swissTopcutBracketModel: SwissTopcutBracketView | null = null;
    const [partsRes, pairingsRes, eventRes, tiebreakGroupRes] = await Promise.all([
      supabase
        .from('event_participants')
        .select(
          `
          id,
          user_id,
          is_shiny,
          left_event_at,
          bye_rounds,
          swiss_points,
          swiss_omw,
          swiss_gw,
          swiss_ogw,
          users!event_participants_user_id_fkey (
            username,
            display_name,
            gender,
            custom_avatar_path,
            default_avatars (storage_path)
          )
        `
        )
        .eq('event_id', eventId)
        .eq('role', 'player'),
      supabase
        .from('pairings')
        .select(
          'id, participant_a_id, participant_b_id, official_winner_participant_id, official_draw, super_cup_winner_participant_id, revenge_cup_winner_participant_id, swiss_round'
        )
        .eq('event_id', eventId),
      supabase
        .from('draft_events')
        .select(
          'status, champion_user_id, champion_decided_by, polemica_winners, recognition_winners, turn_tracking_enabled, competition_format'
        )
        .eq('id', eventId)
        .maybeSingle(),
      supabase
        .from('event_tiebreak_groups')
        .select('id, champion_user_id, status, group_type, round_number, created_at, group_origin')
        .eq('event_id', eventId)
        .in('status', ['active', 'resolved'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (partsRes.error || pairingsRes.error) {
      setRows([]);
      setRevengeRows([]);
      setEventFooter({ torneo: null, bo3: null });
      setPodiumState(null);
      setSwissTopcutBracketView(null);
      setSwissChampionName(null);
      setSwissChampionHonorific(null);
      setEventChampionUserId(null);
      setEventChampionIsShiny(false);
      return;
    }

    const participants = partsRes.data ?? [];
    const infoByParticipantId = new Map<string, { userId: string; name: string }>();
    for (const p of participants as { id: string; user_id: string; users?: unknown }[]) {
      const u = relationOne(p.users) as { display_name?: string; username?: string } | null;
      infoByParticipantId.set(String(p.id), {
        userId: String(p.user_id),
        name: u?.display_name || u?.username || 'Jugador',
      });
    }
    const participantIds = participants.map((p) => p.id as string);

    const leftAtByParticipant = new Map<string, string | null>();
    for (const p of participants as { id: string; left_event_at?: string | null }[]) {
      leftAtByParticipant.set(String(p.id), (p.left_event_at as string | null) ?? null);
    }

    const colorsRes =
      participantIds.length > 0
        ? await supabase
            .from('participant_colors')
            .select('participant_id, color')
            .in('participant_id', participantIds)
        : { data: [], error: null };
    if (colorsRes.error) {
      setRows([]);
      setRevengeRows([]);
      setEventFooter({ torneo: null, bo3: null });
      setPodiumState(null);
      setSwissTopcutBracketView(null);
      setSwissChampionName(null);
      setSwissChampionHonorific(null);
      setEventChampionUserId(null);
      setEventChampionIsShiny(false);
      return;
    }
    const colorMap: Record<string, MtgColor[]> = {};
    for (const row of colorsRes.data ?? []) {
      const pid = row.participant_id as string;
      if (!colorMap[pid]) colorMap[pid] = [];
      colorMap[pid].push(row.color as MtgColor);
    }
    const pairings = pairingsRes.data ?? [];
    const pairingIds = pairings.map((p) => p.id as string);

    const turnTrackOn = !!(
      eventRes.data as { turn_tracking_enabled?: boolean | null } | null
    )?.turn_tracking_enabled;
    setTurnTrackingEnabled(turnTrackOn);
    const rawFmt = (eventRes.data as { competition_format?: string | null } | null)?.competition_format;
    // swiss_bo2 se muestra igual que swiss (Pts / OMW% / GW%, top cut, campeón).
    // Los puntos ya vienen calculados por swiss_bo2_points_of en la columna swiss_points.
    const fmt = rawFmt === 'swiss' || rawFmt === 'swiss_bo2' ? 'swiss' : 'round_robin';
    setCompetitionFormat(fmt);
    setIsSwissBo2(rawFmt === 'swiss_bo2');

    const matchesRes =
      pairingIds.length > 0
        ? await supabase
            .from('matches')
            .select('id, pairing_id, winner_participant_id, status, started_at, ended_at, match_type, tiebreak_round')
            .in('pairing_id', pairingIds)
        : { data: [], error: null };

    const matches = (matchesRes.data ?? []) as any[];
    const matchIds = matches.map((m) => String(m.id));

    const lifeRes =
      !turnTrackOn && matchIds.length > 0
        ? await supabase
            .from('life_events')
            .select('match_id, participant_id, resulting_life, occurred_at')
            .in('match_id', matchIds)
        : { data: [], error: null };

    const officialCompletedMatchIds = matches
      .filter(
        (m: any) =>
          m.status === 'completed' &&
          (m.match_type === 'draft' || m.match_type === 'final') &&
          m.winner_participant_id != null &&
          String(m.winner_participant_id).length > 0
      )
      .map((m: any) => String(m.id));

    const turnsRes =
      turnTrackOn && officialCompletedMatchIds.length > 0
        ? await supabase
            .from('match_turns')
            .select('match_id, turn_number, life_a_after, life_b_after')
            .in('match_id', officialCompletedMatchIds)
        : { data: [], error: null };

    if (matchesRes.error || lifeRes.error || turnsRes.error) {
      setRows([]);
      setRevengeRows([]);
      setEventFooter({ torneo: null, bo3: null });
      setPodiumState(null);
      setSwissTopcutBracketView(null);
      setSwissChampionName(null);
      setSwissChampionHonorific(null);
      setEventChampionUserId(null);
      setEventChampionIsShiny(false);
      return;
    }

    const eventStatus = eventRes.data?.status as string | undefined;
    const championUserId = (eventRes.data as { champion_user_id?: string | null } | null)?.champion_user_id ?? null;
    const championDecidedBy =
      (eventRes.data as { champion_decided_by?: string | null } | null)?.champion_decided_by ?? null;
    const polemicaWinners = ((eventRes.data as { polemica_winners?: string[] | null } | null)?.polemica_winners ??
      []) as string[];
    const recognitionWinners = ((eventRes.data as { recognition_winners?: string[] | null } | null)
      ?.recognition_winners ?? []) as string[];
    setEventStatusStored(eventStatus ?? null);
    let swissChampName: string | null = null;
    let swissChampHonorific: string | null = null;
    if (fmt === 'swiss' && eventStatus === 'completed' && championUserId) {
      const cp = (participants as { id: string; user_id: string; users?: unknown }[]).find(
        (p) => String(p.user_id) === String(championUserId)
      );
      if (cp) {
        const u = relationOne(
          cp.users as
            | { display_name?: string; username?: string; gender?: Gender | null }
            | { display_name?: string; username?: string; gender?: Gender | null }[]
            | null
        );
        swissChampName = u?.display_name || u?.username || 'Campeón';
        const gen = (u?.gender as Gender | null | undefined) ?? null;
        swissChampHonorific = resolveGenderedText(gen, 'campeón', 'campeona');
      }
    }
    setSwissChampionName(swissChampName);
    setSwissChampionHonorific(swissChampHonorific);
    setEventChampionUserId(
      championUserId != null && String(championUserId).trim() !== '' ? String(championUserId) : null
    );
    const championPart = championUserId
      ? (participants as { user_id: string; is_shiny?: boolean }[]).find(
          (p) => String(p.user_id) === String(championUserId)
        )
      : null;
    setEventChampionIsShiny(!!championPart?.is_shiny);
    const totalPairings = pairings.length;
    const resolvedPairings = pairings.filter(
      (pr: any) => pr.official_winner_participant_id != null
    ).length;
    let torneoLine: string | null = null;
    if (
      fmt !== 'swiss' &&
      (eventStatus === 'playing' || eventStatus === 'completed')
    ) {
      const frac = totalPairings > 0 ? resolvedPairings / totalPairings : 0;
      torneoLine = `Completitud: ${formatPctOneDecimal(frac)} (${resolvedPairings}/${totalPairings})`;
    }

    let bo3TwoZero = 0;
    let bo3TwoOne = 0;
    for (const pr of pairings as { id: string; official_winner_participant_id: string | null }[]) {
      if (pr.official_winner_participant_id == null) continue;
      const officialCompleted = matches.filter(
        (m: any) =>
          m.pairing_id === pr.id &&
          m.status === 'completed' &&
          (m.match_type === 'draft' || m.match_type === 'final')
      ).length;
      if (officialCompleted === 2) bo3TwoZero += 1;
      else if (officialCompleted === 3) bo3TwoOne += 1;
    }
    const bo3ClosedTotal = bo3TwoZero + bo3TwoOne;
    let bo3Footer: Bo3Footer | null = null;
    if (bo3ClosedTotal > 0) {
      const pct20 = formatPctOneDecimal(bo3TwoZero / bo3ClosedTotal);
      const pct21 = formatPctOneDecimal(bo3TwoOne / bo3ClosedTotal);
      let bold20 = false;
      let bold21 = false;
      if (bo3TwoZero === bo3TwoOne) {
        bold20 = true;
        bold21 = true;
      } else if (bo3TwoZero > bo3TwoOne) {
        bold20 = true;
      } else {
        bold21 = true;
      }
      bo3Footer = { pct20, pct21, bold20, bold21 };
    }
    setEventFooter({ torneo: torneoLine, bo3: bo3Footer });

    const podiumPlayers = (participants as any[]).map((p: any) => {
      const pid = p.id as string;
      const userId = p.user_id as string;
      const u = relationOne(p.users);
      const name = u?.display_name || u?.username || 'Jugador';
      const playerPairings = pairings.filter((pr: any) => pr.participant_a_id === pid || pr.participant_b_id === pid);
      const pairingSet = new Set(playerPairings.map((x: any) => x.id));
      const playerMatches = matches.filter((m: any) => pairingSet.has(m.pairing_id));
      const officialDone = playerMatches.filter(
        (m: any) =>
          m.status === 'completed' &&
          (m.match_type === 'draft' || m.match_type === 'final') &&
          m.winner_participant_id != null &&
          String(m.winner_participant_id).length > 0
      );
      const pgOff = officialDone.filter((m: any) => m.winner_participant_id === pid).length;
      const pjOff = officialDone.length;
      const eg = playerPairings.filter((pr: any) => pr.official_winner_participant_id === pid).length;
      const ec = playerPairings.filter((pr: any) => pr.official_winner_participant_id != null).length;
      return {
        participantId: pid,
        userId,
        name,
        avatarUserId: userId,
        bo3Won: eg,
        bo3Completed: ec,
        bo3WinRate: ec > 0 ? eg / ec : 0,
        matchesWon: pgOff,
        matchesCompleted: pjOff,
        matchWinRate: pjOff > 0 ? pgOff / pjOff : 0,
      };
    });

    const pairingRemain = (pairings as any[])
      .filter((pr) => pr.official_winner_participant_id == null)
      .map((pr: any) => ({
        participantAId: String(pr.participant_a_id),
        participantBId: String(pr.participant_b_id),
        isBlocked: !!(
          leftAtByParticipant.get(String(pr.participant_a_id)) || leftAtByParticipant.get(String(pr.participant_b_id))
        ),
      }));

    let podiumTiebreakGroup: ActiveTiebreakGroupPodiumInput | null = null;
    let podiumTiebreakMatches: TiebreakMatchPodiumInput[] = [];
    let podiumBracketMatches: BracketMatchPodiumInput[] = [];
    if (!tiebreakGroupRes.error && tiebreakGroupRes.data) {
      const tgRow = tiebreakGroupRes.data as {
        id: string;
        champion_user_id: string | null;
        status: string;
        group_type: string;
        round_number: number;
        group_origin?: string | null;
      };
      const gpRes = await supabase
        .from('event_tiebreak_group_participants')
        .select('participant_id, user_id, seed')
        .eq('group_id', tgRow.id);
      if (!gpRes.error && gpRes.data && (gpRes.data as { participant_id: string }[]).length > 0) {
        podiumTiebreakGroup = {
          id: tgRow.id,
          group_type: tgRow.group_type === 'bracket' ? 'bracket' : 'round_robin',
          round_number: tgRow.round_number ?? 1,
          champion_user_id: tgRow.champion_user_id,
          participants: gpRes.data as { participant_id: string; user_id: string; seed: number }[],
        };
      }
      const prById = new Map((pairings as { id: string }[]).map((pr) => [String(pr.id), pr]));
      for (const m of matches as any[]) {
        if (m.match_type !== 'tiebreak' || m.status !== 'completed') continue;
        if (m.winner_participant_id == null || String(m.winner_participant_id).length === 0) continue;
        const pr = prById.get(String(m.pairing_id)) as
          | { id: string; participant_a_id: string; participant_b_id: string }
          | undefined;
        if (!pr) continue;
        podiumTiebreakMatches.push({
          pairing_id: String(m.pairing_id),
          participant_a_id: String(pr.participant_a_id),
          participant_b_id: String(pr.participant_b_id),
          winner_participant_id: String(m.winner_participant_id),
          ended_at: m.ended_at != null ? String(m.ended_at) : null,
          tiebreak_round: m.tiebreak_round != null ? Number(m.tiebreak_round) : null,
        });
      }
      if (tgRow.group_type === 'bracket') {
        const bmRes = await supabase
          .from('event_tiebreak_bracket_matches')
          .select('bracket_phase, participant_a_id, participant_b_id, winner_participant_id')
          .eq('group_id', tgRow.id);
        if (!bmRes.error && bmRes.data) {
          podiumBracketMatches = (bmRes.data as {
            bracket_phase: 'semi' | 'final' | 'third_place';
            participant_a_id: string;
            participant_b_id: string;
            winner_participant_id: string | null;
          }[]).map((r) => ({
            bracket_phase: r.bracket_phase,
            participant_a_id: String(r.participant_a_id),
            participant_b_id: String(r.participant_b_id),
            winner_participant_id:
              r.winner_participant_id != null ? String(r.winner_participant_id) : null,
          }));
        }
      }
      const groupOrigin = tgRow.group_origin ?? 'tiebreak';
      if (
        groupOrigin === 'swiss_topcut' &&
        !gpRes.error &&
        gpRes.data &&
        (gpRes.data as { participant_id: string }[]).length >= 4 &&
        podiumBracketMatches.length >= 2
      ) {
        const built = buildSwissTopcutBracketModel(
          gpRes.data as { participant_id: string; user_id: string; seed: number }[],
          podiumBracketMatches,
          infoByParticipantId
        );
        if (built) swissTopcutBracketModel = built;
      }
    }

    setPodiumState(
      computePodium(
        podiumPlayers,
        pairingRemain,
        participants.length,
        championUserId,
        podiumTiebreakGroup,
        podiumTiebreakMatches,
        championDecidedBy,
        polemicaWinners,
        recognitionWinners,
        podiumBracketMatches
      )
    );

    const lifeEvents = (lifeRes.data ?? []) as LifeEvRow[];
    const lifeByMatchId = new Map<string, LifeEvRow[]>();
    for (const e of lifeEvents) {
      const mid = String(e.match_id);
      if (!lifeByMatchId.has(mid)) lifeByMatchId.set(mid, []);
      lifeByMatchId.get(mid)!.push(e);
    }

    const turnRows = (turnsRes.data ?? []) as MatchTurnRow[];
    const turnsByMatchId = new Map<string, MatchTurnRow[]>();
    for (const t of turnRows) {
      const mid = String(t.match_id);
      if (!turnsByMatchId.has(mid)) turnsByMatchId.set(mid, []);
      turnsByMatchId.get(mid)!.push(t);
    }

    const swissRoundResolved = new Map<number, boolean>();
    if (fmt === 'swiss') {
      const rounds = new Set<number>();
      for (const pr of pairings as { swiss_round?: number | string | null }[]) {
        const r = pr.swiss_round;
        if (r == null || r === '') continue;
        const n = typeof r === 'number' ? r : Number(r);
        if (Number.isFinite(n)) rounds.add(n);
      }
      for (const r of rounds) {
        swissRoundResolved.set(r, isSwissRoundFullyResolved(pairings as any, r));
      }
    }

    const rowsBuilt: RowView[] = participants.map((p: any) => {
      const pid = p.id as string;
      const u = relationOne(p.users);
      const name = u?.display_name || u?.username || 'Jugador';
      const userId = p.user_id as string;
      const colors = colorMap[pid] ?? [];
      const gender = (u?.gender as Gender | null | undefined) ?? null;

      const playerPairings = pairings.filter((pr: any) => pr.participant_a_id === pid || pr.participant_b_id === pid);
      const pairingSet = new Set(playerPairings.map((x: any) => x.id));
      const playerMatches = matches.filter((m: any) => pairingSet.has(m.pairing_id));
      const completedMatches = playerMatches.filter(
        (m: any) =>
          !!m.winner_participant_id &&
          (m.match_type === 'draft' || m.match_type === 'final')
      );
      const pg = completedMatches.filter((m: any) => m.winner_participant_id === pid).length;
      const pj = completedMatches.length;
      // swiss_bo2: partidas finalizadas (sin importar si tienen ganador declarado).
      const pf = playerMatches.filter(
        (m: any) => m.match_type === 'draft' && m.status === 'completed'
      ).length;
      const eg = playerPairings.filter((pr: any) => pr.official_winner_participant_id === pid).length;
      const ec = playerPairings.filter((pr: any) => pr.official_winner_participant_id != null).length;
      const inProgress = playerMatches.some(
        (m: any) =>
          m.status === 'in_progress' && (m.match_type === 'draft' || m.match_type === 'final')
      );
      const leftEventAt = (p.left_event_at as string | null) ?? null;

      const swissPoints = Number((p as { swiss_points?: number | null }).swiss_points ?? 0);
      const rawOmw = (p as { swiss_omw?: number | string | null }).swiss_omw;
      const rawGw = (p as { swiss_gw?: number | string | null }).swiss_gw;
      const rawOgw = (p as { swiss_ogw?: number | string | null }).swiss_ogw;
      const swissOmw = rawOmw != null && rawOmw !== '' ? Number(rawOmw) : null;
      const swissGw = rawGw != null && rawGw !== '' ? Number(rawGw) : null;
      const swissOgw = rawOgw != null && rawOgw !== '' ? Number(rawOgw) : null;

      const rawBye = (p as { bye_rounds?: (number | string)[] | null }).bye_rounds;
      const byeRounds = Array.isArray(rawBye)
        ? rawBye.map((x) => (typeof x === 'number' ? x : Number(x))).filter((n) => Number.isFinite(n))
        : [];
      const showCompletedByeL =
        fmt === 'swiss' &&
        byeRounds.length > 0 &&
        byeRounds.some((r) => swissRoundResolved.get(r) === true);

      const matchDmvs: number[] = [];
      const matchDmvts: number[] = [];
      for (const m of playerMatches) {
        if (m.match_type !== 'draft' && m.match_type !== 'final') continue;
        if (m.status !== 'completed') continue;
        const mid = String(m.id);
        const pr = pairings.find((x: any) => x.id === m.pairing_id);
        if (!pr) continue;
        const pa = pr.participant_a_id as string;
        const pb = pr.participant_b_id as string;
        if (pid !== pa && pid !== pb) continue;
        const opp = pid === pa ? pb : pa;
        if (turnTrackOn) {
          const tns = turnsByMatchId.get(mid) ?? [];
          const dmvtOne = computeMatchDmvt(tns, pid, pa, pb);
          if (dmvtOne != null) matchDmvts.push(dmvtOne);
        } else {
          const evs = lifeByMatchId.get(mid) ?? [];
          if (evs.length === 0) continue;
          const mdv = computeMatchDmv(evs, pid, opp);
          if (mdv != null) matchDmvs.push(mdv);
        }
      }
      const dmv =
        !turnTrackOn && matchDmvs.length > 0
          ? matchDmvs.reduce((a, b) => a + b, 0) / matchDmvs.length
          : null;
      const dmvt =
        turnTrackOn && matchDmvts.length > 0
          ? matchDmvts.reduce((a, b) => a + b, 0) / matchDmvts.length
          : null;

      const durations = completedMatches
        .filter((m: any) => m.ended_at)
        .map((m: any) => (new Date(m.ended_at as string).getTime() - new Date(m.started_at as string).getTime()) / 1000);
      const tmp =
        durations.length > 0 ? durations.reduce((a: number, b: number) => a + b, 0) / durations.length : null;

      return {
        participantId: pid,
        userId,
        name,
        colors,
        pg,
        pj,
        eg,
        ec,
        pf,
        dmv,
        dmvt,
        tmp,
        swissPoints,
        swissOmw: swissOmw != null && Number.isFinite(swissOmw) ? swissOmw : null,
        swissGw: swissGw != null && Number.isFinite(swissGw) ? swissGw : null,
        swissOgw: swissOgw != null && Number.isFinite(swissOgw) ? swissOgw : null,
        showCompletedByeL,
        inProgress,
        leftEventAt,
        gender,
      };
    });

    if (fmt === 'swiss') {
      rowsBuilt.sort((a, b) => {
        if (b.swissPoints !== a.swissPoints) return b.swissPoints - a.swissPoints;
        const oa = a.swissOmw ?? -Infinity;
        const ob = b.swissOmw ?? -Infinity;
        if (ob !== oa) return ob - oa;
        const ga = a.swissGw ?? -Infinity;
        const gb = b.swissGw ?? -Infinity;
        if (gb !== ga) return gb - ga;
        const wa = a.swissOgw ?? -Infinity;
        const wb = b.swissOgw ?? -Infinity;
        if (wb !== wa) return wb - wa;
        return 0;
      });
    } else {
      const winrateBO3 = (r: RowView) => (r.ec > 0 ? r.eg / r.ec : 0);
      const winrateMatches = (r: RowView) => (r.pj > 0 ? r.pg / r.pj : 0);
      rowsBuilt.sort((a, b) => {
        const wbA = winrateBO3(a);
        const wbB = winrateBO3(b);
        if (wbA !== wbB) return wbB - wbA;
        const wmA = winrateMatches(a);
        const wmB = winrateMatches(b);
        if (wmA !== wmB) return wmB - wmA;
        const av = turnTrackOn ? (a.dmvt ?? -Infinity) : (a.dmv ?? -Infinity);
        const bv = turnTrackOn ? (b.dmvt ?? -Infinity) : (b.dmv ?? -Infinity);
        return bv - av;
      });
    }
    setSwissTopcutBracketView(swissTopcutBracketModel);
    setRows(rowsBuilt);

    const revengeRowsBuilt: RevengeRowView[] = participants.map((p: any) => {
      const pid = p.id as string;
      const u = relationOne(p.users);
      const name = u?.display_name || u?.username || 'Jugador';
      const userId = p.user_id as string;
      const colors = colorMap[pid] ?? [];
      const gender = (u?.gender as Gender | null | undefined) ?? null;

      const playerPairings = pairings.filter((pr: any) => pr.participant_a_id === pid || pr.participant_b_id === pid);
      const pairingSet = new Set(playerPairings.map((x: any) => x.id));
      const playerMatches = matches.filter((m: any) => pairingSet.has(m.pairing_id));

      const revengeCompleted = playerMatches.filter(
        (m: any) => m.match_type === 'revenge' && m.status === 'completed'
      );
      const vj = revengeCompleted.length;
      const vg = revengeCompleted.filter((m: any) => m.winner_participant_id === pid).length;

      const cv = playerPairings.filter((pr: any) => pr.revenge_cup_winner_participant_id === pid).length;
      const sc = playerPairings.filter((pr: any) => pr.super_cup_winner_participant_id === pid).length;

      const inProgress = playerMatches.some(
        (m: any) => m.status === 'in_progress' && m.match_type === 'revenge'
      );
      const leftEventAt = (p.left_event_at as string | null) ?? null;

      return { participantId: pid, userId, name, colors, vg, vj, cv, sc, inProgress, leftEventAt, gender };
    });

    const revengeFiltered = revengeRowsBuilt.filter((r) => r.vj > 0);
    revengeFiltered.sort((a, b) => {
      const ra = a.vj > 0 ? a.vg / a.vj : 0;
      const rb = b.vj > 0 ? b.vg / b.vj : 0;
      if (rb !== ra) return rb - ra;
      return b.vg - a.vg;
    });
    setRevengeRows(revengeFiltered);
    if (revengeFiltered.length === 0) {
      setTab('official');
    }
  }, [eventId]);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      void (async () => {
        if (firstRef.current) setLoading(true);
        await load();
        if (mounted && firstRef.current) {
          setLoading(false);
          firstRef.current = false;
        }
      })();
      return () => {
        mounted = false;
      };
    }, [load])
  );

  useEffect(() => {
    if (standingsChannelRef.current) return;
    const channel = supabase
      .channel(`standings-live:${eventId}:${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, () => {
        void load();
      })
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pairings', filter: `event_id=eq.${eventId}` },
        () => {
          void load();
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'event_tiebreak_groups',
          filter: `event_id=eq.${eventId}`,
        },
        () => {
          void load();
        }
      )
      .subscribe();
    standingsChannelRef.current = channel;
    return () => {
      void channel.unsubscribe();
      void supabase.removeChannel(channel);
      standingsChannelRef.current = null;
    };
  }, [eventId, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  useEffect(() => {
    if (eventStatusStored !== 'completed') return undefined;
    let cancelled = false;
    let dismissT: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        const k = `confetti_seen_${eventId}`;
        const seen = await AsyncStorage.getItem(k);
        if (cancelled || seen != null) return;
        setShowConfettiOnce(true);
        await AsyncStorage.setItem(k, '1');
        dismissT = setTimeout(() => {
          if (!cancelled) setShowConfettiOnce(false);
        }, 4500);
      } catch {
        // ignore storage errors
      }
    })();
    return () => {
      cancelled = true;
      if (dismissT) clearTimeout(dismissT);
    };
  }, [eventId, eventStatusStored]);

  useEffect(() => {
    if (!showPodiumIntro || eventStatusStored !== 'completed') return;
    let cancelled = false;
    setShowConfettiOnce(true);
    void (async () => {
      try {
        await AsyncStorage.setItem(`confetti_seen_${eventId}`, '1');
      } catch {
        // ignore
      }
    })();
    navigation.setParams({ eventId, showPodiumIntro: undefined });
    const t = setTimeout(() => {
      if (!cancelled) setShowConfettiOnce(false);
    }, 4500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [showPodiumIntro, eventStatusStored, eventId, navigation]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  const winW = Dimensions.get('window').width;

  const renderPedestalColumn = (rank: 1 | 2 | 3, baseH: number, bgColor: string) => {
    if (!podiumState) return null;
    const step =
      podiumState.steps.find((s) => s.rank === rank) ??
      ({
        rank,
        players: [],
        topPlayerOnStool: null,
      } as (typeof podiumState.steps)[number]);
    const players = step.players;
    const stoolId = step.topPlayerOnStool;
    const cnt = players.length;
    const avatarSize = cnt > 0 ? podiumStepAvatarSize(cnt) : ('large' as PlayerAvatarSize);
    const avatarBorder = cnt <= 1 ? 3 : 2;

    const isCompactStep = cnt >= 5;
    const compactBorder = 1;
    const compactNativeOuter = AVATAR_DIAM_TINY + 2 * compactBorder;
    const compactFitMax =
      cnt > 1
        ? Math.floor((PODIUM_COL_WIDTH - (cnt - 1) * PODIUM_AVATAR_ROW_GAP) / cnt)
        : compactNativeOuter;
    const compactOuter = Math.max(12, Math.min(20, compactFitMax));
    const compactScale = compactOuter / compactNativeOuter;

    const renderOneAvatar = (pl: (typeof players)[number]) => {
      const isEventChampion =
        rank === 1 &&
        eventChampionUserId != null &&
        String(pl.userId) === String(eventChampionUserId);
      const showChampionShinyAnim = isEventChampion && eventChampionIsShiny;

      return (
        <TouchableOpacity
          key={pl.participantId}
          activeOpacity={0.75}
          style={[styles.podiumPlayerStack, styles.podiumAvatarCol]}
          onPress={() =>
            navigation.navigate('PlayerProfileInEvent', {
              eventId,
              participantId: pl.participantId,
              from: 'Standings',
            })
          }
        >
          {isEventChampion ? (
            <Text style={styles.podiumCrownMark} accessibilityLabel="Campeón del evento">
              👑
            </Text>
          ) : null}
          {isCompactStep ? (
            <View
              style={{
                width: compactOuter,
                height: compactOuter,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <View style={{ transform: [{ scale: compactScale }] }}>
                <PlayerAvatar
                  userId={pl.avatarUserId}
                  participantId={pl.participantId}
                  size="tiny"
                  withColorBorder
                  borderWidth={compactBorder}
                  showShinyAnimation={showChampionShinyAnim}
                />
              </View>
            </View>
          ) : (
            <PlayerAvatar
              userId={pl.avatarUserId}
              participantId={pl.participantId}
              size={avatarSize}
              withColorBorder
              borderWidth={avatarBorder}
              showShinyAnimation={showChampionShinyAnim}
            />
          )}
          {(pl.onStool === true || stoolId === pl.participantId) ? (
            <Text style={styles.podiumStoolMark} accessibilityLabel="Primero sobre el banquito">
              🪑
            </Text>
          ) : null}
        </TouchableOpacity>
      );
    };

    return (
      <View key={rank} style={styles.podiumCol}>
        <View style={styles.podiumAvatarArea}>
          {cnt === 0 ? (
            <View style={styles.podiumAvatarSpacer} />
          ) : (
            <View style={styles.podiumAvatarRow}>{players.map(renderOneAvatar)}</View>
          )}
        </View>
        <View style={[styles.podiumBaseBlock, { height: baseH, backgroundColor: bgColor }]}>
          <Text style={[styles.podiumBaseRank, rank === 3 && styles.podiumBaseRankLight]}>{rank}</Text>
        </View>
      </View>
    );
  };

  const step1Filled =
    podiumState != null &&
    (podiumState.steps.find((s) => s.rank === 1)?.players.length ?? 0) > 0;

  const podiumBlock =
    podiumState != null && step1Filled ? (
      <View style={styles.podiumSection}>
        <View style={styles.podiumArena}>
          <View style={styles.podiumCenterRow}>
            {renderPedestalColumn(2, 90, '#D1D5DB')}
            {renderPedestalColumn(1, 124, '#FCD34D')}
            {renderPedestalColumn(3, 70, '#B45309')}
          </View>
        </View>
      </View>
    ) : null;

  return (
    <View style={styles.screenRoot}>
      {showConfettiOnce ? (
        <View pointerEvents="none" style={styles.confettiOverlay}>
          <ConfettiCannon count={150} origin={{ x: Math.max(80, winW / 2), y: -6 }} fadeOut />
        </View>
      ) : null}
      <ScrollView style={styles.container} contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
      {podiumBlock}
      {revengeRows.length > 0 ? (
        <View style={styles.tabsRow}>
          <TouchableOpacity style={styles.tabBtn} onPress={() => setTab('official')} activeOpacity={0.7}>
            <Text style={[styles.tabLabel, tab === 'official' && styles.tabLabelActive]}>Oficial</Text>
            <View style={[styles.tabUnderline, tab !== 'official' && styles.tabUnderlineHidden]} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.tabBtn} onPress={() => setTab('revenge')} activeOpacity={0.7}>
            <Text style={[styles.tabLabel, tab === 'revenge' && styles.tabLabelActive]}>Venganzas</Text>
            <View style={[styles.tabUnderline, tab !== 'revenge' && styles.tabUnderlineHidden]} />
          </TouchableOpacity>
        </View>
      ) : null}

      {tab === 'official' ? (
        <>
          <View style={styles.header}>
            <Text style={[styles.cell, styles.playerCol]}>Jugador</Text>
            {competitionFormat === 'swiss' ? (
              <>
                <Text style={[styles.cell, styles.statCol]}>Pts</Text>
                <Text style={[styles.cell, styles.swissPctCol]}>OMW%</Text>
                <Text style={[styles.cell, styles.swissPctCol]}>GW%</Text>
                {isSwissBo2 ? (
                  <Text style={[styles.cell, styles.statCol]}>PF</Text>
                ) : null}
              </>
            ) : (
              <>
                <Text style={[styles.cell, styles.statCol]}>PG</Text>
                <Text style={[styles.cell, styles.statCol]}>PJ</Text>
                <Text style={[styles.cell, styles.statCol]}>EG</Text>
                <Text style={[styles.cell, styles.statCol]}>EC</Text>
              </>
            )}
            {!isSwissBo2 ? (
              <>
                <Text style={[styles.cell, styles.dmvCol]}>{turnTrackingEnabled ? 'DMVt' : 'DMV'}</Text>
                <Text style={[styles.cell, styles.tmpCol]}>TMP</Text>
              </>
            ) : null}
          </View>
          {rows.map((r) => (
            <TouchableOpacity
              key={r.participantId}
              style={[styles.row, r.leftEventAt ? styles.rowLeftEvent : null]}
              activeOpacity={0.7}
              onPress={() =>
                navigation.navigate('PlayerProfileInEvent', {
                  eventId,
                  participantId: r.participantId,
                  from: 'Standings',
                })
              }
            >
              <View style={[styles.playerCell, styles.playerCol]}>
                <PlayerAvatar
                  userId={r.userId}
                  participantId={r.participantId}
                  size="tiny"
                  withColorBorder={false}
                  style={styles.standingsAvatar}
                />
                <View style={styles.playerNameRow}>
                  <View style={styles.playerNameInner}>
                    {r.inProgress ? <PulsingLiveDot /> : null}
                    <View style={styles.playerNameWithByeRow}>
                      <Text style={styles.playerNameSwiss} numberOfLines={1}>
                        {r.name}
                        {r.leftEventAt ? ' *' : ''}
                      </Text>
                      {competitionFormat === 'swiss' && r.showCompletedByeL ? (
                        <Text style={styles.byeLMark}>L</Text>
                      ) : null}
                    </View>
                  </View>
                  <ColorFlag colors={r.colors} />
                </View>
              </View>
              {competitionFormat === 'swiss' ? (
                <>
                  <Text style={[styles.cell, styles.statCol]}>{r.swissPoints}</Text>
                  <Text style={[styles.cell, styles.swissPctCol]}>
                    {r.swissOmw == null ? '—' : formatSwissPctDisplay(r.swissOmw)}
                  </Text>
                  <Text style={[styles.cell, styles.swissPctCol]}>
                    {r.swissGw == null ? '—' : formatSwissPctDisplay(r.swissGw)}
                  </Text>
                  {isSwissBo2 ? (
                    <Text style={[styles.cell, styles.statCol]}>{r.pf}</Text>
                  ) : null}
                </>
              ) : (
                <>
                  <Text style={[styles.cell, styles.statCol]}>{r.pg}</Text>
                  <Text style={[styles.cell, styles.statCol]}>{r.pj}</Text>
                  <Text style={[styles.cell, styles.statCol]}>{r.eg}</Text>
                  <Text style={[styles.cell, styles.statCol]}>{r.ec}</Text>
                </>
              )}
              {!isSwissBo2 ? (
                <>
                  <Text
                    style={[
                      styles.cell,
                      styles.dmvCol,
                      { color: dmvCellColor(turnTrackingEnabled ? r.dmvt : r.dmv) },
                    ]}
                  >
                    {formatDmvCell(turnTrackingEnabled ? r.dmvt : r.dmv)}
                  </Text>
                  <Text style={[styles.cell, styles.tmpCol]} numberOfLines={1}>
                    {formatTmpDisplay(r.tmp)}
                  </Text>
                </>
              ) : null}
            </TouchableOpacity>
          ))}
        </>
      ) : (
        <>
          <View style={styles.header}>
            <Text style={[styles.cell, styles.playerCol]}>Jugador</Text>
            <Text style={[styles.cell, styles.statCol]}>VG</Text>
            <Text style={[styles.cell, styles.statCol]}>VJ</Text>
            <Text style={[styles.cell, styles.statCol]}>CV</Text>
            <Text style={[styles.cell, styles.statCol]}>SC</Text>
          </View>
          {revengeRows.map((r) => (
            <TouchableOpacity
              key={r.participantId}
              style={styles.row}
              activeOpacity={0.7}
              onPress={() =>
                navigation.navigate('PlayerProfileInEvent', {
                  eventId,
                  participantId: r.participantId,
                  from: 'Standings',
                })
              }
            >
              <View style={[styles.playerCell, styles.playerCol]}>
                <PlayerAvatar
                  userId={r.userId}
                  participantId={r.participantId}
                  size="tiny"
                  withColorBorder={false}
                  style={styles.standingsAvatar}
                />
                <View style={styles.playerNameRow}>
                  <View style={styles.playerNameInner}>
                    {r.inProgress ? <PulsingLiveDot /> : null}
                    <Text style={styles.playerName} numberOfLines={2}>
                      {r.name}
                    </Text>
                  </View>
                  <ColorFlag colors={r.colors} />
                </View>
              </View>
              <Text style={[styles.cell, styles.statCol]}>{r.vg}</Text>
              <Text style={[styles.cell, styles.statCol]}>{r.vj}</Text>
              <Text style={[styles.cell, styles.statCol]}>{r.cv}</Text>
              <Text style={[styles.cell, styles.statCol]}>{r.sc}</Text>
            </TouchableOpacity>
          ))}
        </>
      )}

      <View style={styles.legendLiveRow}>
        <Text style={styles.legendStaticDot}>●</Text>
        <Text style={styles.legendLiveCaption}> En juego</Text>
      </View>
      {tab === 'official' &&
      (eventFooter.torneo ||
        (eventFooter.bo3 && !(competitionFormat === 'swiss' && swissChampionName))) ? (
        <View style={styles.tourneyMeta}>
          <View style={styles.tourneyMetaRow}>
            {eventFooter.torneo ? (
              <Text style={[styles.tourneyMetaLine, styles.tourneyMetaLeft]}>{eventFooter.torneo}</Text>
            ) : (
              <View style={styles.tourneyMetaLeftSpacer} />
            )}
            {eventFooter.bo3 && !(competitionFormat === 'swiss' && swissChampionName) ? (
              <Text style={styles.tourneyMetaRight}>
                <Text style={eventFooter.bo3.bold20 ? styles.tourneyMetaBo3Bold : styles.tourneyMetaBo3Norm}>
                  E_2-0: {eventFooter.bo3.pct20}
                </Text>
                <Text style={styles.tourneyMetaBo3Sep}>{'  '}</Text>
                <Text style={eventFooter.bo3.bold21 ? styles.tourneyMetaBo3Bold : styles.tourneyMetaBo3Norm}>
                  E_2-1: {eventFooter.bo3.pct21}
                </Text>
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
      {(() => {
        const footnoteOfficial = '* Se fue antes de completar sus enfrentamientos';
        const segments: string[] =
          tab === 'official'
            ? competitionFormat === 'swiss'
              ? isSwissBo2
                ? 'Pts: Puntos (victoria=3, empate=1, bye=2) · OMW%: Rendimiento medio de los rivales (mín. 33%) · GW%: Porcentaje de partidas individuales ganadas · PF: Partidas individuales finalizadas'.split(' · ')
                : (
                    turnTrackingEnabled
                      ? 'Pts: Puntos suizos · OMW%: Porcentaje de victorias en enfrentamientos de los rivales (mín. 33% por rival) · GW%: Porcentaje de partidas oficiales ganadas · DMVt: Diferencial Medio de Vida por turno (oficial) · TMP: Tiempo Medio por Partida'
                      : 'Pts: Puntos suizos · OMW%: Porcentaje de victorias en enfrentamientos de los rivales (mín. 33% por rival) · GW%: Porcentaje de partidas oficiales ganadas · DMV: Diferencial Medio de Vida · TMP: Tiempo Medio por Partida'
                  ).split(' · ')
              : [
                  ...(
                    turnTrackingEnabled
                      ? 'PG: Partidas Ganadas · PJ: Partidas Jugadas Completadas · EG: Enfrentamientos Ganados (BO3) · EC: Enfrentamientos Completados · DMVt: Diferencial Medio de Vida por turno (oficial) · TMP: Tiempo Medio por Partida'
                      : 'PG: Partidas Ganadas · PJ: Partidas Jugadas Completadas · EG: Enfrentamientos Ganados (BO3) · EC: Enfrentamientos Completados · DMV: Diferencial Medio de Vida · TMP: Tiempo Medio por Partida'
                  ).split(' · '),
                  'E_2-0: Porcentaje de Enfrentamientos definidos en 2 partidas',
                  'E_2-1: Porcentaje de Enfrentamientos definidos en 3 partidas',
                ]
            : 'VG: Venganzas Ganadas · VJ: Venganzas Jugadas Completadas · CV: Copas Venganza ganadas · SC: Súper Copas ganadas'.split(
                ' · '
              );
        return (
          <>
            <View style={styles.legendWrap}>
              {segments.map((segment, i) => (
                <Text key={i} style={styles.legendSegment}>
                  {tab === 'official' && competitionFormat === 'swiss'
                    ? `· ${segment}`
                    : i > 0
                      ? `· ${segment}`
                      : segment}
                </Text>
              ))}
            </View>
            {tab === 'official' ? <Text style={styles.legendFootnote}>{footnoteOfficial}</Text> : null}
          </>
        );
      })()}
      {tab === 'official' && swissTopcutBracketView ? (
        <SwissTopcutBracketBlock model={swissTopcutBracketView} />
      ) : null}
    </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screenRoot: { flex: 1, backgroundColor: '#fff' },
  swissChampionBanner: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
    alignItems: 'center',
  },
  swissChampionBannerText: { fontSize: 17, fontWeight: '800', color: '#111827', textAlign: 'center' },
  confettiOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 40,
    elevation: 12,
  },
  podiumSection: { marginBottom: 18 },
  podiumArena: {
    minHeight: 168,
    marginBottom: 4,
    justifyContent: 'flex-end',
  },
  podiumCenterRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 4,
  },
  podiumCol: {
    flexDirection: 'column',
    justifyContent: 'flex-end',
    alignItems: 'center',
    width: PODIUM_COL_WIDTH,
  },
  podiumAvatarArea: {
    width: '100%',
    justifyContent: 'flex-end',
    alignItems: 'stretch',
    minHeight: 112,
    marginBottom: 2,
  },
  podiumAvatarSpacer: { minHeight: 112 },
  podiumAvatarRow: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    justifyContent: 'center',
    alignItems: 'flex-end',
    gap: PODIUM_AVATAR_ROW_GAP,
    width: '100%',
  },
  podiumPlayerStack: { flexShrink: 0, alignItems: 'center' },
  podiumAvatarCol: { flexDirection: 'column', alignItems: 'center' },
  podiumCrownMark: { fontSize: 14, lineHeight: 16, marginBottom: 2 },
  podiumStoolMark: { fontSize: 12, lineHeight: 14, marginTop: 2 },
  podiumBaseBlock: {
    width: '100%',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.12)',
    marginTop: 2,
  },
  podiumBaseRank: {
    fontSize: 34,
    fontWeight: '900',
    color: 'rgba(0,0,0,0.45)',
  },
  podiumBaseRankLight: {
    color: '#FFFBEB',
    textShadowColor: 'rgba(0,0,0,0.35)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  container: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  scroll: { padding: 16, paddingBottom: 28 },
  tabsRow: {
    flexDirection: 'row',
    marginBottom: 12,
    marginTop: -4,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  tabBtn: { marginRight: 22, paddingBottom: 4 },
  tabLabel: { fontSize: 15, fontWeight: '600', color: '#6B7280' },
  tabLabelActive: { color: '#111827', fontWeight: '800' },
  tabUnderline: { height: 2, backgroundColor: '#3B82F6', borderRadius: 1, marginTop: 6 },
  tabUnderlineHidden: { backgroundColor: 'transparent' },
  header: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e5e7eb', paddingBottom: 8, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#eee' },
  rowLeftEvent: { opacity: 0.5 },
  cell: { textAlign: 'center', color: '#111', fontWeight: '700', fontSize: 12 },
  tmpCol: { width: 50, minWidth: 50, fontSize: 10 },
  playerCol: { flex: 1, width: 'auto', minWidth: 108, textAlign: 'left' },
  statCol: { width: 34, minWidth: 34, fontSize: 11 },
  swissPctCol: { width: 44, minWidth: 44, fontSize: 10 },
  dmvCol: { width: 40, minWidth: 40, fontSize: 11 },
  playerCell: { flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0 },
  standingsAvatar: { marginRight: 6 },
  playerNameRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  playerNameInner: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 4 },
  playerNameWithByeRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
    flexShrink: 1,
  },
  playerName: { flex: 1, flexShrink: 1, color: '#111', fontSize: 12, fontWeight: '600' },
  playerNameSwiss: { color: '#111', fontSize: 12, fontWeight: '600' },
  byeLMark: {
    fontSize: 9,
    fontWeight: '800',
    color: '#DC2626',
    marginLeft: 2,
    marginTop: -2,
  },
  liveDotWrap: { justifyContent: 'center' },
  liveDot: { color: '#3B82F6', fontWeight: '700', fontSize: 12 },
  tourneyMeta: {
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E5E7EB',
  },
  tourneyMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  tourneyMetaLine: { color: '#111827', fontSize: 11, fontWeight: '700' },
  tourneyMetaLeft: { flex: 1, flexGrow: 1, minWidth: 120, paddingRight: 6 },
  tourneyMetaLeftSpacer: { flex: 1, minWidth: 0 },
  tourneyMetaRight: { flexShrink: 1, textAlign: 'right', color: '#374151', fontSize: 11 },
  tourneyMetaBo3Norm: { color: '#374151', fontWeight: '400' },
  tourneyMetaBo3Bold: { color: '#374151', fontWeight: '700' },
  tourneyMetaBo3Sep: { color: '#374151', fontWeight: '400' },
  legendLiveRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  legendStaticDot: { color: '#3B82F6', fontWeight: '700', fontSize: 11 },
  legendLiveCaption: { color: '#6B7280', fontSize: 11 },
  legendWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    marginTop: 10,
  },
  legendSegment: { color: '#666', fontSize: 12, marginBottom: 4, marginRight: 4 },
  legendFootnote: { marginTop: 8, color: '#666', fontSize: 12 },
  tcSection: { marginTop: 22, marginBottom: 14, width: '100%', alignItems: 'center' },
  tcBracketOuter: { marginTop: 4 },
  tcHdrRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  tcHdrCol: { fontSize: 13, color: '#6B7280', fontWeight: '700', textAlign: 'center' },
  tcBodyWrap: { position: 'relative' },
  tcBodyRow: { flexDirection: 'row', alignItems: 'center', height: '100%', zIndex: 1 },
  tcMatchCard: {
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08,
        shadowRadius: 4,
      },
      android: { elevation: 2 },
      default: {},
    }),
  },
  tcMatchCardFinal: {
    backgroundColor: '#FAFAFA',
    borderWidth: 2,
    borderColor: '#9CA3AF',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 5,
      },
      android: { elevation: 3 },
      default: {},
    }),
  },
  tcMatchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: STC_ROW_H,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 8,
  },
  tcMatchRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  tcMatchRowWin: {
    backgroundColor: '#FEF3C7',
    borderLeftWidth: 4,
    borderLeftColor: '#D97706',
  },
  tcMatchRowLose: { opacity: 0.45 },
  tcMatchName: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    fontWeight: '600',
    color: '#111827',
  },
  tcMatchNamePh: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
  },
  tcPhAvatarSm: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#E5E7EB' },
});

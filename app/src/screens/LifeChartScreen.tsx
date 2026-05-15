import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
import Svg, { Line, Polyline, Circle, Text as SvgText, Rect } from 'react-native-svg';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import PlayerAvatar from '../components/PlayerAvatar';
import type { MtgColor } from '../lib/database.types';

type Props = NativeStackScreenProps<MainStackParamList, 'LifeChart'>;

type TurnRow = { turn_number: number; life_a_after: number; life_b_after: number };

const COLOR_HEX: Record<MtgColor, string> = {
  W: '#F8F0D8',
  U: '#3B82F6',
  B: '#374151',
  R: '#DC2626',
  G: '#16A34A',
  C: '#94A3B8',
};

function chooseColors(colorsA: MtgColor[], colorsB: MtgColor[]): { a: string; b: string } {
  let a = colorsA[0] ?? 'C';
  let b = colorsB[0] ?? 'C';
  if (a === b) {
    const altA = colorsA.find((c) => c !== b) ?? colorsA[0] ?? 'C';
    const altB = colorsB.find((c) => c !== altA) ?? colorsB[0] ?? 'C';
    a = altA;
    b = altB;
    if (a === b) {
      a = 'R';
      b = 'G';
    }
  }
  return { a: COLOR_HEX[a], b: COLOR_HEX[b] };
}

export default function LifeChartScreen({ route }: Props) {
  const { matchId } = route.params;
  const [loading, setLoading] = useState(true);
  const [turns, setTurns] = useState<TurnRow[]>([]);
  const [nameA, setNameA] = useState<string>('');
  const [nameB, setNameB] = useState<string>('');
  const [participantAId, setParticipantAId] = useState<string | null>(null);
  const [participantBId, setParticipantBId] = useState<string | null>(null);
  const [userAId, setUserAId] = useState<string | null>(null);
  const [userBId, setUserBId] = useState<string | null>(null);
  const [colorA, setColorA] = useState<string>('#16A34A');
  const [colorB, setColorB] = useState<string>('#DC2626');
  const [startLifeA, setStartLifeA] = useState(20);
  const [startLifeB, setStartLifeB] = useState(20);
  const [matchStatus, setMatchStatus] = useState<string | null>(null);
  const [winnerParticipantId, setWinnerParticipantId] = useState<string | null>(null);

  useEffect(() => {
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
    return () => {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    };
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const { data: matchRow } = await supabase
          .from('matches')
          .select('id, pairing_id, starting_life_a, starting_life_b, status, winner_participant_id')
          .eq('id', matchId)
          .maybeSingle();
        if (!matchRow) return;

        const row = matchRow as {
          starting_life_a?: number;
          starting_life_b?: number;
          status?: string;
          winner_participant_id?: string | null;
        };
        const sA = Number(row.starting_life_a ?? 20);
        const sB = Number(row.starting_life_b ?? 20);
        setStartLifeA(sA);
        setStartLifeB(sB);
        setMatchStatus(row.status ?? null);
        setWinnerParticipantId(row.winner_participant_id ?? null);

        const { data: turnsData } = await supabase
          .from('match_turns')
          .select('turn_number, life_a_after, life_b_after')
          .eq('match_id', matchId)
          .order('turn_number');
        const t = (turnsData ?? []) as TurnRow[];
        setTurns(t);

        const { data: pairing } = await supabase
          .from('pairings')
          .select('participant_a_id, participant_b_id')
          .eq('id', (matchRow as { pairing_id: string }).pairing_id)
          .maybeSingle();
        if (!pairing) return;

        const pidA = pairing.participant_a_id as string;
        const pidB = pairing.participant_b_id as string;
        setParticipantAId(pidA);
        setParticipantBId(pidB);

        const [partsRes, colorsRes] = await Promise.all([
          supabase
            .from('event_participants')
            .select(
              `
            id,
            user_id,
            users!event_participants_user_id_fkey (
              username,
              display_name
            )
          `
            )
            .in('id', [pidA, pidB]),
          supabase.from('participant_colors').select('participant_id, color').in('participant_id', [pidA, pidB]),
        ]);

        const parts = (partsRes.data ?? []) as {
          id: string;
          user_id: string;
          users:
            | { username?: string; display_name?: string | null }
            | { username?: string; display_name?: string | null }[]
            | null;
        }[];

        const partA = parts.find((p) => p.id === pidA);
        const partB = parts.find((p) => p.id === pidB);

        const userA = Array.isArray(partA?.users) ? partA?.users[0] : partA?.users;
        const userB = Array.isArray(partB?.users) ? partB?.users[0] : partB?.users;

        setNameA(userA?.display_name || userA?.username || '');
        setNameB(userB?.display_name || userB?.username || '');
        setUserAId(partA?.user_id ?? null);
        setUserBId(partB?.user_id ?? null);

        const colorsByPid: Record<string, MtgColor[]> = {};
        for (const row of colorsRes.data ?? []) {
          const pid = row.participant_id as string;
          if (!colorsByPid[pid]) colorsByPid[pid] = [];
          colorsByPid[pid]!.push(row.color as MtgColor);
        }
        const colorsA = colorsByPid[pidA] ?? [];
        const colorsB = colorsByPid[pidB] ?? [];
        const chosen = chooseColors(colorsA, colorsB);
        setColorA(chosen.a);
        setColorB(chosen.b);
      } finally {
        setLoading(false);
      }
    })();
  }, [matchId]);

  const firstChangeTurn = useMemo(() => {
    for (const t of turns) {
      if (t.life_a_after !== startLifeA || t.life_b_after !== startLifeB) return t.turn_number;
    }
    return turns[0]?.turn_number ?? 1;
  }, [turns, startLifeA, startLifeB]);

  const chartTurns = useMemo(() => {
    if (matchStatus !== 'aborted' || !winnerParticipantId) return turns;
    const pidA = participantAId;
    const pidB = participantBId;
    if (!pidA || !pidB) return turns;
    if (winnerParticipantId !== pidA && winnerParticipantId !== pidB) return turns;

    const abandonerId = winnerParticipantId === pidA ? pidB : pidA;
    const last = turns[turns.length - 1];
    const lastNum = last?.turn_number ?? 0;
    const la = last?.life_a_after ?? startLifeA;
    const lb = last?.life_b_after ?? startLifeB;
    const synthetic: TurnRow = {
      turn_number: lastNum + 1,
      life_a_after: abandonerId === pidA ? 0 : la,
      life_b_after: abandonerId === pidB ? 0 : lb,
    };
    return [...turns, synthetic];
  }, [turns, matchStatus, winnerParticipantId, participantAId, participantBId, startLifeA, startLifeB]);

  const lastChartTurn = chartTurns[chartTurns.length - 1]?.turn_number ?? 1;

  const maxLifeInMatch = useMemo(() => {
    let m = Math.max(startLifeA, startLifeB, 20);
    for (const t of chartTurns) {
      if (t.life_a_after > m) m = t.life_a_after;
      if (t.life_b_after > m) m = t.life_b_after;
    }
    return m;
  }, [chartTurns, startLifeA, startLifeB]);

  const effXMin = Math.max(0, firstChangeTurn - 1);
  let effXMax = lastChartTurn;
  if (effXMax <= effXMin) effXMax = effXMin + 1;
  const effYMin = 0;
  let effYMax = maxLifeInMatch;
  if (effYMax <= effYMin) effYMax = effYMin + 1;

  const SVG_WIDTH = 700;
  const SVG_HEIGHT = 340;
  const PADDING_LEFT = 50;
  const PADDING_RIGHT = 80;
  const PADDING_TOP = 20;
  const PADDING_BOTTOM = 40;
  const plotWidth = SVG_WIDTH - PADDING_LEFT - PADDING_RIGHT;
  const plotHeight = SVG_HEIGHT - PADDING_TOP - PADDING_BOTTOM;

  const xSpan = effXMax - effXMin;
  const ySpan = effYMax - effYMin;

  const xToPixel = (x: number) => PADDING_LEFT + ((x - effXMin) / xSpan) * plotWidth;
  const yToPixel = (y: number) => PADDING_TOP + ((effYMax - y) / ySpan) * plotHeight;
  /** Drift visual en Y para separar series cuando comparten vida (eje/ticks sin cambio). */
  const yToPixelA = (life: number) => yToPixel(life + 0.2);
  const yToPixelB = (life: number) => yToPixel(life - 0.2);

  const visibleTurns = chartTurns.filter((t) => t.turn_number >= effXMin && t.turn_number <= effXMax);

  const initialTurn = firstChangeTurn - 1;
  const includeInitial = initialTurn >= effXMin && initialTurn <= effXMax;
  const initialRow: TurnRow = {
    turn_number: initialTurn,
    life_a_after: startLifeA,
    life_b_after: startLifeB,
  };

  const seriesPoints = (includeInitial ? [initialRow] : []).concat(visibleTurns);
  const pointsA =
    seriesPoints.length > 0
      ? seriesPoints.map((t) => `${xToPixel(t.turn_number)},${yToPixelA(t.life_a_after)}`).join(' ')
      : '';
  const pointsB =
    seriesPoints.length > 0
      ? seriesPoints.map((t) => `${xToPixel(t.turn_number)},${yToPixelB(t.life_b_after)}`).join(' ')
      : '';

  const xTicks: number[] = [];
  for (let i = Math.ceil(effXMin); i <= effXMax; i += 1) xTicks.push(i);

  const yTicks: number[] = [];
  for (let i = Math.ceil(effYMin); i <= effYMax; i += 5) yTicks.push(i);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.legend}>
        <View style={styles.legendItem}>
          {userAId && participantAId ? (
            <PlayerAvatar userId={userAId} participantId={participantAId} size="tiny" />
          ) : null}
          <View style={[styles.legendColor, { backgroundColor: colorA }]} />
          <Text style={styles.legendText}>{nameA || 'A'}</Text>
        </View>
        <View style={styles.legendItem}>
          {userBId && participantBId ? (
            <PlayerAvatar userId={userBId} participantId={participantBId} size="tiny" />
          ) : null}
          <View style={[styles.legendColor, { backgroundColor: colorB }]} />
          <Text style={styles.legendText}>{nameB || 'B'}</Text>
        </View>
      </View>

      {chartTurns.length === 0 ? (
        <Text style={styles.empty}>No hay turnos registrados para esta partida.</Text>
      ) : (
        <View style={[styles.chartWrap, { width: SVG_WIDTH, height: SVG_HEIGHT }]}>
          <Svg width={SVG_WIDTH} height={SVG_HEIGHT}>
            <Rect x={0} y={0} width={SVG_WIDTH} height={SVG_HEIGHT} fill="#E5E7EB" />

            {yTicks.map((tick) => (
              <Line
                key={`yg-${tick}`}
                x1={PADDING_LEFT}
                y1={yToPixel(tick)}
                x2={PADDING_LEFT + plotWidth}
                y2={yToPixel(tick)}
                stroke="#D1D5DB"
                strokeWidth={1}
              />
            ))}

            <Line
              x1={PADDING_LEFT}
              y1={PADDING_TOP}
              x2={PADDING_LEFT}
              y2={PADDING_TOP + plotHeight}
              stroke="#111"
              strokeWidth={2}
            />
            <Line
              x1={PADDING_LEFT}
              y1={PADDING_TOP + plotHeight}
              x2={PADDING_LEFT + plotWidth}
              y2={PADDING_TOP + plotHeight}
              stroke="#111"
              strokeWidth={2}
            />

            {yTicks.map((tick) => (
              <SvgText
                key={`yt-${tick}`}
                x={PADDING_LEFT - 8}
                y={yToPixel(tick) + 4}
                fontSize="10"
                fill="#111"
                textAnchor="end"
              >
                {String(tick)}
              </SvgText>
            ))}

            {xTicks.map((tick) => (
              <SvgText
                key={`xt-${tick}`}
                x={xToPixel(tick)}
                y={PADDING_TOP + plotHeight + 16}
                fontSize="10"
                fill="#111"
                textAnchor="middle"
              >
                {String(tick)}
              </SvgText>
            ))}

            {pointsA.length > 0 ? (
              <Polyline points={pointsA} stroke={colorA} strokeWidth={3} fill="none" />
            ) : null}
            {pointsB.length > 0 ? (
              <Polyline points={pointsB} stroke={colorB} strokeWidth={3} fill="none" />
            ) : null}

            {seriesPoints.map((t, idx) => (
              <React.Fragment key={`pts-${idx}`}>
                <Circle cx={xToPixel(t.turn_number)} cy={yToPixelA(t.life_a_after)} r={3} fill={colorA} />
                <Circle cx={xToPixel(t.turn_number)} cy={yToPixelB(t.life_b_after)} r={3} fill={colorB} />
              </React.Fragment>
            ))}
          </Svg>
        </View>
      )}

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 12, alignItems: 'stretch' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  empty: { textAlign: 'center', color: '#6B7280', marginVertical: 16 },
  chartWrap: { position: 'relative', alignSelf: 'center' },
  legend: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginBottom: 12,
    columnGap: 20,
    rowGap: 8,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  legendColor: { width: 16, height: 16, borderRadius: 3 },
  legendText: { fontSize: 13, color: '#111', fontWeight: '600', marginLeft: 6 },
});

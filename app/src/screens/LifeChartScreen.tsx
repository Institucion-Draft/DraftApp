import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity } from 'react-native';
import { releaseLandscape, requestLandscape } from '../lib/screenOrientationPolicy';
import Svg, { Line, Polyline, Circle, Text as SvgText, Rect } from 'react-native-svg';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import PlayerAvatar from '../components/PlayerAvatar';

type Props = NativeStackScreenProps<MainStackParamList, 'LifeChart'>;

type LifeEventRow = { participant_id: string; delta: number; resulting_life: number; occurred_at: string };
type XMode = 'time' | 'events';
type Pt = { x: number; y: number };
type DeltaLabel = { key: string; x: number; y: number; text: string; color: string; anchor: 'start' | 'end' };

const MINUS = '−';
const BA_TZ = 'America/Argentina/Buenos_Aires';

/**
 * Par fijo para los dos jugadores, independiente del color del mazo. Contraste contra el fondo gris
 * (#E5E7EB): azul 3.9:1, naranja 4.0:1 (el naranja base #d95f02 daba 3.0:1, se oscureció).
 */
const COLOR_A = '#1f77b4';
const COLOR_B = '#bf4d00';

/**
 * GUARDA DE TEMA: esta pantalla queda SIEMPRE en su estilo claro, sin importar el modo global.
 * No importar `useTheme`/`useThemedStyles`/ThemeContext acá. El aislamiento del header, del fondo
 * del stack, de la barra de estado y del subárbol (p. ej. PlayerAvatar) está en `theme/lightLock.tsx`
 * y se aplica en MainNavigator.
 */
export default function LifeChartScreen({ route }: Props) {
  const { matchId } = route.params;
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<LifeEventRow[]>([]);
  const [eventName, setEventName] = useState<string>('');
  const [dateLabel, setDateLabel] = useState<string>('');
  const [xMode, setXMode] = useState<XMode>('time');
  const [nameA, setNameA] = useState<string>('');
  const [nameB, setNameB] = useState<string>('');
  const [participantAId, setParticipantAId] = useState<string | null>(null);
  const [participantBId, setParticipantBId] = useState<string | null>(null);
  const [userAId, setUserAId] = useState<string | null>(null);
  const [userBId, setUserBId] = useState<string | null>(null);
  const [startLifeA, setStartLifeA] = useState(20);
  const [startLifeB, setStartLifeB] = useState(20);

  useEffect(() => {
    // Se registra el pedido para que la guarda global no lo corrija; ambos pasos esperan al sistema.
    void requestLandscape();
    return () => {
      void releaseLandscape();
    };
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const { data: matchRow } = await supabase
          .from('matches')
          .select('id, pairing_id, starting_life_a, starting_life_b, started_at')
          .eq('id', matchId)
          .maybeSingle();
        if (!matchRow) return;

        const row = matchRow as {
          starting_life_a?: number;
          starting_life_b?: number;
          started_at?: string | null;
        };
        setStartLifeA(Number(row.starting_life_a ?? 20));
        setStartLifeB(Number(row.starting_life_b ?? 20));
        if (row.started_at) {
          // en-CA da aaaa-mm-dd en hora de Buenos Aires; se reordena a dd/mm/aaaa.
          const [yy, mm, dd] = new Date(row.started_at).toLocaleDateString('en-CA', { timeZone: BA_TZ }).split('-');
          setDateLabel(`${dd}/${mm}/${yy}`);
        }

        const { data: evData } = await supabase
          .from('life_events')
          .select('participant_id, delta, resulting_life, occurred_at')
          .eq('match_id', matchId)
          .order('occurred_at', { ascending: true });
        setEvents((evData ?? []) as LifeEventRow[]);

        const { data: pairing } = await supabase
          .from('pairings')
          .select('event_id, participant_a_id, participant_b_id')
          .eq('id', (matchRow as { pairing_id: string }).pairing_id)
          .maybeSingle();
        if (!pairing) return;

        const { data: evRow } = await supabase
          .from('draft_events')
          .select('name')
          .eq('id', (pairing as { event_id: string }).event_id)
          .maybeSingle();
        setEventName((evRow as { name?: string } | null)?.name ?? '');

        const pidA = pairing.participant_a_id as string;
        const pidB = pairing.participant_b_id as string;
        setParticipantAId(pidA);
        setParticipantBId(pidB);

        const [partsRes] = await Promise.all([
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
      } finally {
        setLoading(false);
      }
    })();
  }, [matchId]);

  const model = useMemo(() => {
    const evs = events.filter((e) => e.participant_id === participantAId || e.participant_id === participantBId);
    const t0 = evs.length > 0 ? new Date(evs[0]!.occurred_at).getTime() : 0;
    const minutes = (e: LifeEventRow) => (new Date(e.occurred_at).getTime() - t0) / 60000;
    const tMax = evs.length > 0 ? Math.max(minutes(evs[evs.length - 1]!), 0) : 0;
    const xMaxTime = tMax > 0 ? tMax : 1;
    const xMaxEvents = Math.max(evs.length, 1);

    // Modo tiempo: línea escalonada por jugador (la vida se mantiene hasta su próximo cambio).
    const stepA: Pt[] = [{ x: 0, y: startLifeA }];
    const stepB: Pt[] = [{ x: 0, y: startLifeB }];
    const dotsTimeA: Pt[] = [{ x: 0, y: startLifeA }];
    const dotsTimeB: Pt[] = [{ x: 0, y: startLifeB }];
    const jumps: { isA: boolean; x: number; from: number; to: number; delta: number }[] = [];
    // Modo eventos: un punto por evento; el jugador que no cambió mantiene su valor.
    const lineA: Pt[] = [{ x: 0, y: startLifeA }];
    const lineB: Pt[] = [{ x: 0, y: startLifeB }];
    let curA = startLifeA;
    let curB = startLifeB;
    evs.forEach((e, i) => {
      const x = minutes(e);
      const isA = e.participant_id === participantAId;
      const from = isA ? curA : curB;
      const to = e.resulting_life;
      (isA ? stepA : stepB).push({ x, y: from }, { x, y: to });
      (isA ? dotsTimeA : dotsTimeB).push({ x, y: to });
      jumps.push({ isA, x, from, to, delta: e.delta });
      if (isA) curA = to;
      else curB = to;
      lineA.push({ x: i + 1, y: curA });
      lineB.push({ x: i + 1, y: curB });
    });
    stepA.push({ x: xMaxTime, y: curA });
    stepB.push({ x: xMaxTime, y: curB });

    let minLife = Math.min(startLifeA, startLifeB);
    let maxLife = Math.max(startLifeA, startLifeB, 20);
    for (const e of evs) {
      if (e.resulting_life < minLife) minLife = e.resulting_life;
      if (e.resulting_life > maxLife) maxLife = e.resulting_life;
    }
    return { count: evs.length, xMaxTime, xMaxEvents, stepA, stepB, dotsTimeA, dotsTimeB, jumps, lineA, lineB, minLife, maxLife };
  }, [events, participantAId, participantBId, startLifeA, startLifeB]);

  const SVG_WIDTH = 700;
  const SVG_HEIGHT = 380;
  const PADDING_LEFT = 50;
  const PADDING_RIGHT = 30;
  const PADDING_TOP = 44;
  const PADDING_BOTTOM = 56;
  /** Margen interno en X para que las etiquetas junto al eje Y (x=0) no pisen los números del eje. */
  const X_INSET = 26;
  const plotWidth = SVG_WIDTH - PADDING_LEFT - PADDING_RIGHT;
  const plotHeight = SVG_HEIGHT - PADDING_TOP - PADDING_BOTTOM;

  const isTime = xMode === 'time';
  const effXMax = isTime ? model.xMaxTime : model.xMaxEvents;
  const effYMin = Math.min(0, model.minLife) - 2;
  const effYMax = model.maxLife;
  const ySpan = effYMax - effYMin;

  const xToPixel = (x: number) => PADDING_LEFT + X_INSET + (x / effXMax) * (plotWidth - 2 * X_INSET);
  const yToPixel = (y: number) => PADDING_TOP + ((effYMax - y) / ySpan) * plotHeight;
  /** Drift visual en Y para separar series cuando comparten vida (eje/ticks sin cambio). */
  const yToPixelA = (life: number) => yToPixel(life + 0.2);
  const yToPixelB = (life: number) => yToPixel(life - 0.2);

  const toPoints = (pts: Pt[], yFn: (v: number) => number) => pts.map((p) => `${xToPixel(p.x)},${yFn(p.y)}`).join(' ');

  const xTicks = useMemo(() => {
    const ticks: number[] = [];
    if (isTime) {
      const steps = [1, 2, 5, 10, 15, 30, 60, 120];
      const step = steps.find((s) => effXMax / s <= 10) ?? 240;
      for (let v = 0; v <= effXMax + 1e-9; v += step) ticks.push(v);
    } else {
      const step = Math.max(1, Math.ceil(effXMax / 15));
      for (let v = 0; v <= effXMax; v += step) ticks.push(v);
    }
    return ticks;
  }, [isTime, effXMax]);

  const yTicks: number[] = [];
  for (let i = Math.ceil(effYMin / 5) * 5; i <= effYMax; i += 5) yTicks.push(i);

  /** Deltas: A a la izquierda del salto, B a la derecha; si chocan, cambia de lado o se corre en vertical. */
  const deltaLabels = useMemo<DeltaLabel[]>(() => {
    if (!isTime) return [];
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const out: DeltaLabel[] = [];
    const dys = [0, -12, 12, -24, 24];
    const px = (x: number) => PADDING_LEFT + X_INSET + (x / effXMax) * (plotWidth - 2 * X_INSET);
    const py = (v: number) => PADDING_TOP + ((effYMax - v) / ySpan) * plotHeight;
    model.jumps.forEach((j, idx) => {
      const text = `${j.delta > 0 ? '+' : MINUS}${Math.abs(j.delta)}`;
      const w = text.length * 6.5;
      const x = px(j.x);
      const drift = j.isA ? 0.2 : -0.2;
      const yMid = (py(j.from + drift) + py(j.to + drift)) / 2;
      const prefs: ('left' | 'right')[] = j.isA ? ['left', 'right'] : ['right', 'left'];
      let chosen: { side: 'left' | 'right'; dy: number } | null = null;
      for (const dy of dys) {
        for (const side of prefs) {
          const x0 = side === 'left' ? x - 4 - w : x + 4;
          const hit = placed.some(
            (p) => x0 < p.x1 && x0 + w > p.x0 && yMid + dy - 6 < p.y1 && yMid + dy + 6 > p.y0
          );
          if (!hit) {
            chosen = { side, dy };
            break;
          }
        }
        if (chosen) break;
      }
      const c = chosen ?? { side: prefs[0]!, dy: 0 };
      const x0 = c.side === 'left' ? x - 4 - w : x + 4;
      placed.push({ x0, x1: x0 + w, y0: yMid + c.dy - 6, y1: yMid + c.dy + 6 });
      out.push({
        key: `dl-${idx}`,
        x: c.side === 'left' ? x - 4 : x + 4,
        y: yMid + c.dy + 3.5,
        text,
        color: j.isA ? COLOR_A : COLOR_B,
        anchor: c.side === 'left' ? 'end' : 'start',
      });
    });
    return out;
  }, [isTime, model.jumps, effXMax, effYMax, ySpan, plotWidth, plotHeight]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (model.count === 0) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.empty}>Esta partida no tiene cambios de vida registrados</Text>
      </ScrollView>
    );
  }

  const title = `${nameA || 'A'} vs ${nameB || 'B'} - ${eventName} - ${dateLabel}`;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{title}</Text>

      <View style={styles.segmented}>
        {(['time', 'events'] as XMode[]).map((m) => (
          <TouchableOpacity key={m} style={[styles.segment, xMode === m && styles.segmentActive]} onPress={() => setXMode(m)}>
            <Text style={[styles.segmentText, xMode === m && styles.segmentTextActive]}>
              {m === 'time' ? 'Tiempo' : 'Eventos'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

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
            y1={yToPixel(0)}
            x2={PADDING_LEFT + plotWidth}
            y2={yToPixel(0)}
            stroke="#111"
            strokeWidth={1.5}
            strokeDasharray="5 4"
          />

          <Line x1={PADDING_LEFT} y1={PADDING_TOP} x2={PADDING_LEFT} y2={PADDING_TOP + plotHeight} stroke="#111" strokeWidth={2} />
          <Line
            x1={PADDING_LEFT}
            y1={PADDING_TOP + plotHeight}
            x2={PADDING_LEFT + plotWidth}
            y2={PADDING_TOP + plotHeight}
            stroke="#111"
            strokeWidth={2}
          />

          {yTicks.map((tick) => (
            <SvgText key={`yt-${tick}`} x={PADDING_LEFT - 8} y={yToPixel(tick) + 4} fontSize="10" fill="#111" textAnchor="end">
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
              {String(Math.round(tick * 10) / 10)}
            </SvgText>
          ))}

          <SvgText x={PADDING_LEFT + plotWidth / 2} y={PADDING_TOP + plotHeight + 40} fontSize="12" fill="#111" textAnchor="middle">
            {isTime ? 'Minutos desde el primer cambio de vida registrado' : 'Evento de cambio de vida'}
          </SvgText>

          <Polyline points={toPoints(isTime ? model.stepA : model.lineA, yToPixelA)} stroke={COLOR_A} strokeWidth={3} fill="none" />
          <Polyline points={toPoints(isTime ? model.stepB : model.lineB, yToPixelB)} stroke={COLOR_B} strokeWidth={3} fill="none" />

          {(isTime ? model.dotsTimeA : model.lineA).map((p, idx) => (
            <Circle key={`da-${idx}`} cx={xToPixel(p.x)} cy={yToPixelA(p.y)} r={3} fill={COLOR_A} />
          ))}
          {(isTime ? model.dotsTimeB : model.lineB).map((p, idx) => (
            <Circle key={`db-${idx}`} cx={xToPixel(p.x)} cy={yToPixelB(p.y)} r={3} fill={COLOR_B} />
          ))}

          {deltaLabels.map((l) => (
            <SvgText key={l.key} x={l.x} y={l.y} fontSize="10" fontWeight="bold" fill={l.color} textAnchor={l.anchor}>
              {l.text}
            </SvgText>
          ))}
        </Svg>

        <View style={styles.legend} pointerEvents="none">
          <View style={styles.legendItem}>
            {userAId && participantAId ? <PlayerAvatar userId={userAId} participantId={participantAId} size="tiny" /> : null}
            <View style={[styles.legendColor, { backgroundColor: COLOR_A }]} />
            <Text style={styles.legendText}>{nameA || 'A'}</Text>
          </View>
          <View style={styles.legendItem}>
            {userBId && participantBId ? <PlayerAvatar userId={userBId} participantId={participantBId} size="tiny" /> : null}
            <View style={[styles.legendColor, { backgroundColor: COLOR_B }]} />
            <Text style={styles.legendText}>{nameB || 'B'}</Text>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 12, alignItems: 'stretch' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  empty: { textAlign: 'center', color: '#6B7280', marginVertical: 16 },
  chartWrap: { position: 'relative', alignSelf: 'center' },
  title: { textAlign: 'center', color: '#111', fontSize: 15, fontWeight: '700', marginBottom: 8 },
  segmented: {
    flexDirection: 'row',
    alignSelf: 'center',
    borderWidth: 1,
    borderColor: '#111',
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: 10,
  },
  segment: { paddingVertical: 6, paddingHorizontal: 18, backgroundColor: '#fff' },
  segmentActive: { backgroundColor: '#111' },
  segmentText: { fontSize: 13, color: '#111', fontWeight: '600' },
  segmentTextActive: { color: '#fff' },
  legend: {
    position: 'absolute',
    top: 8,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: 16,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  legendColor: { width: 16, height: 16, borderRadius: 3 },
  legendText: { fontSize: 13, color: '#111', fontWeight: '600', marginLeft: 6 },
});

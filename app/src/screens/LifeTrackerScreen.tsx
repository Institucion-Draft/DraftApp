import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NativeStackScreenProps, NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { useKeepAwake } from 'expo-keep-awake';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import {
  findConcurrentInProgressDetailsForPairParticipants,
  formatConcurrentMatchBlockMessage,
} from '../lib/participantConcurrentMatch';
import PlayerAvatar from '../components/PlayerAvatar';
import type { MtgColor } from '../lib/database.types';
import {
  buildSequentialEmojis,
  categorizeMove,
  getEffectiveAttackPattern,
  getSpecialBehavior,
  pickMove,
  pickRandomMoveFromAll,
  type MoveTarget,
} from '../lib/pokemonMovepool';

type Props = NativeStackScreenProps<MainStackParamList, 'LifeTracker'>;

type MatchRow = {
  id: string;
  pairing_id: string;
  winner_participant_id: string | null;
  match_type: string | null;
  starting_life_a: number;
  starting_life_b: number;
  life_tracker_user_id: string | null;
  status: 'in_progress' | 'completed' | 'aborted';
  who_started_participant_id: string | null;
};

type PairingRow = {
  id: string;
  event_id: string;
  participant_a_id: string;
  participant_b_id: string;
};

type ParticipantRow = {
  id: string;
  user_id: string;
  member_b_user_id?: string | null;
  giant_name?: string | null;
  is_shiny?: boolean;
  rotated_avatar_id: string | null;
  rotated_avatar:
    | { storage_path: string; storage_path_shiny?: string | null }
    | { storage_path: string; storage_path_shiny?: string | null }[]
    | null;
  users:
    | {
        username: string;
        display_name: string;
        custom_avatar_path: string | null;
        default_avatars: { storage_path: string } | { storage_path: string }[] | null;
      }
    | {
        username: string;
        display_name: string;
        custom_avatar_path: string | null;
        default_avatars: { storage_path: string } | { storage_path: string }[] | null;
      }[]
    | null;
};

type LifeSnapshot = { a: number; b: number };

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

function getPokemonNameFromAvatar(participant: ParticipantRow | null): string {
  if (!participant) return 'normal';
  const rotatedDa = relationOne(participant.rotated_avatar);
  const path =
    participant.is_shiny && rotatedDa?.storage_path_shiny
      ? rotatedDa.storage_path_shiny
      : rotatedDa?.storage_path;
  if (path) {
    const filename = path.split('/').pop() ?? '';
    const base = filename.replace(/\.[^.]+$/, '').toLowerCase();
    if (base) return base;
  }
  const user = relationOne(participant.users);
  if (!user) return 'normal';
  const customPath = user.custom_avatar_path;
  if (customPath) {
    const filename = customPath.split('/').pop() ?? '';
    return filename.replace(/\.[^.]+$/, '').toLowerCase();
  }
  const defaultAvatar = relationOne(user.default_avatars);
  if (!defaultAvatar) return 'normal';
  const filename = defaultAvatar.storage_path.split('/').pop() ?? '';
  return filename.replace(/\.[^.]+$/, '').toLowerCase();
}

function clampLife(value: number): number {
  return Math.max(0, value);
}

function bracketRowMatchesPairing(
  row: { pairing_id: string | null; participant_a_id: string; participant_b_id: string },
  pairing: { id: string; participant_a_id: string; participant_b_id: string }
): boolean {
  if (row.pairing_id === pairing.id) return true;
  return (
    (row.participant_a_id === pairing.participant_a_id && row.participant_b_id === pairing.participant_b_id) ||
    (row.participant_a_id === pairing.participant_b_id && row.participant_b_id === pairing.participant_a_id)
  );
}

function flushLayout(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/** ~10 s para que un punto recorra el ancho visible del banner (ajustable). */
const NEWS_TICKER_MS_PER_VIEWPORT_WIDTH = 10000;
const NEWS_TICKER_LIVE_INTERVAL_MS = 120_000;
const NEWS_TICKER_POLL_COMPLETED_MS = 30_000;
const NEWS_TICKER_MESSAGE_GAP_PX = 40;

function isDarkTickerAdjacentColor(colors: MtgColor[]): boolean {
  return (colors[0] ?? 'C') === 'B';
}

const newsTickerStyles = StyleSheet.create({
  strip: {
    width: '100%',
    height: 26,
    backgroundColor: 'rgba(31, 41, 55, 0.85)',
    overflow: 'hidden',
  },
  tickerTrack: { flexDirection: 'row', alignItems: 'center' },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pairRow: { flexDirection: 'row', alignItems: 'center' },
  rotated: { marginLeft: NEWS_TICKER_MESSAGE_GAP_PX, transform: [{ rotate: '180deg' }] },
  msgLive: { fontSize: 11, color: '#FFFFFF', fontWeight: '400' },
  msgPartial: { fontSize: 11, color: '#FBBF24', fontWeight: '400' },
  msgClosesBo3: { fontSize: 11, color: '#D8B4FE', fontWeight: '400' },
  bold: { fontWeight: '700' },
});

type TickerColorKey = 'live' | 'partial' | 'closes';

type TickerQueueItem = {
  key: string;
  colorKey: TickerColorKey;
  body: React.ReactNode;
};

type PendingFinishedTicker = {
  matchId: string;
  message: TickerQueueItem;
};

type EventTickerPairing = {
  id: string;
  participant_a_id: string;
  participant_b_id: string;
};

type EventTickerMatch = {
  id: string;
  pairing_id: string;
  status: string;
  match_type: string;
  winner_participant_id: string | null;
  started_at: string;
  ended_at: string | null;
  starting_life_a: number;
  starting_life_b: number;
};

type EventTickerContext = {
  eventId: string;
  currentMatchId: string;
  currentPairingId: string;
  turnTrackingEnabled: boolean;
  topcutFormat: string;
  nameByParticipantId: Map<string, string>;
  pairingById: Map<string, EventTickerPairing>;
  bracketPhaseByPairingId: Map<string, 'semi' | 'final' | 'third_place'>;
  bracketPairingIds: Set<string>;
  matches: EventTickerMatch[];
};

function topcutWinsNeededTicker(
  format: string | null | undefined,
  phase: 'semi' | 'final' | 'third_place'
): number {
  const f = format ?? 'bo3';
  if (f === 'bo1') return 1;
  if (f === 'sf_bo1_f_bo3') return phase === 'semi' ? 1 : 2;
  return 2;
}

function bracketPhaseTickerLabel(phase: 'semi' | 'final' | 'third_place'): string {
  if (phase === 'semi') return 'SEMIFINAL';
  if (phase === 'final') return 'FINAL';
  return '3ER PUESTO';
}

function formatTickerDuration(startedAt: string | null, endedAt?: string | null): string {
  if (!startedAt) return '';
  const a = new Date(startedAt).getTime();
  const b = endedAt ? new Date(endedAt).getTime() : Date.now();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '';
  const totalMin = Math.floor((b - a) / 60_000);
  if (totalMin <= 0) return '<1 min';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return m > 0 ? `${h}h ${m} min` : `${h}h`;
  return `${totalMin} min`;
}

/** Tiempo EN VIVO en el ticker: solo minutos enteros (hacia abajo), sin segundos. */
function formatTickerLiveElapsedMinutes(startedAt: string | null): string {
  if (!startedAt) return '';
  const a = new Date(startedAt).getTime();
  const b = Date.now();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '';
  const totalMin = Math.floor((b - a) / 60_000);
  if (totalMin <= 0) return '';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return m > 0 ? `${h}h ${m} min` : `${h}h`;
  return `${totalMin} min`;
}

function isTickerEligibleMatch(m: EventTickerMatch, bracketPairingIds: Set<string>): boolean {
  if (m.match_type === 'revenge') return false;
  if (m.match_type === 'draft' || m.match_type === 'final') return true;
  if (m.match_type === 'tiebreak') return bracketPairingIds.has(m.pairing_id);
  return false;
}

function resolveBracketPairingId(
  row: { pairing_id: string | null; participant_a_id: string; participant_b_id: string },
  pairingById: Map<string, EventTickerPairing>
): string | null {
  if (row.pairing_id) return row.pairing_id;
  for (const p of pairingById.values()) {
    if (
      (p.participant_a_id === row.participant_a_id && p.participant_b_id === row.participant_b_id) ||
      (p.participant_a_id === row.participant_b_id && p.participant_b_id === row.participant_a_id)
    ) {
      return p.id;
    }
  }
  return null;
}

function pairingWinsForTicker(
  ctx: EventTickerContext,
  pairingId: string
): { winsA: number; winsB: number } {
  const p = ctx.pairingById.get(pairingId);
  if (!p) return { winsA: 0, winsB: 0 };
  const types = ctx.bracketPairingIds.has(pairingId) ? ['tiebreak'] : ['draft', 'final'];
  const completed = ctx.matches.filter(
    (m) =>
      m.pairing_id === pairingId &&
      m.status === 'completed' &&
      m.winner_participant_id != null &&
      types.includes(m.match_type)
  );
  return {
    winsA: completed.filter((m) => m.winner_participant_id === p.participant_a_id).length,
    winsB: completed.filter((m) => m.winner_participant_id === p.participant_b_id).length,
  };
}

function matchClosesSeries(ctx: EventTickerContext, pairingId: string, winsA: number, winsB: number): boolean {
  if (ctx.bracketPairingIds.has(pairingId)) {
    const phase = ctx.bracketPhaseByPairingId.get(pairingId);
    if (!phase) return false;
    return Math.max(winsA, winsB) >= topcutWinsNeededTicker(ctx.topcutFormat, phase);
  }
  return winsA >= 2 || winsB >= 2;
}

function renderFinPartidaBody(
  nameA: string,
  nameB: string,
  winnerParticipantId: string,
  participantAId: string,
  durationLabel: string,
  seriesLabel: string,
  winsA: number,
  winsB: number,
  closesSeries: boolean
): React.ReactNode {
  const winnerIsA = winnerParticipantId === participantAId;
  const scoreA = String(winsA);
  const scoreB = String(winsB);
  return (
    <>
      Fin partida ·{' '}
      {winnerIsA ? (
        <>
          <Text style={newsTickerStyles.bold}>{nameA}</Text> vs {nameB}
        </>
      ) : (
        <>
          {nameA} vs <Text style={newsTickerStyles.bold}>{nameB}</Text>
        </>
      )}
      {' · '}
      {durationLabel}
      {' · '}
      {seriesLabel}{' '}
      {winnerIsA ? (
        closesSeries ? (
          <>
            <Text style={newsTickerStyles.bold}>{scoreA}</Text>-{scoreB}
          </>
        ) : (
          `${scoreA}-${scoreB}`
        )
      ) : closesSeries ? (
        <>
          {scoreA}-<Text style={newsTickerStyles.bold}>{scoreB}</Text>
        </>
      ) : (
        `${scoreA}-${scoreB}`
      )}
    </>
  );
}

async function fetchEventTickerContext(
  eventId: string,
  currentMatchId: string,
  currentPairingId: string
): Promise<EventTickerContext | null> {
  const [eventRes, pairingsRes, participantsRes, tgRes] = await Promise.all([
    supabase
      .from('draft_events')
      .select('turn_tracking_enabled, topcut_format, competition_format')
      .eq('id', eventId)
      .maybeSingle(),
    supabase.from('pairings').select('id, participant_a_id, participant_b_id, swiss_round').eq('event_id', eventId),
    supabase
      .from('event_participants')
      .select('id, users!event_participants_user_id_fkey (display_name, username)')
      .eq('event_id', eventId)
      .eq('role', 'player'),
    supabase
      .from('event_tiebreak_groups')
      .select('id')
      .eq('event_id', eventId)
      .eq('group_origin', 'swiss_topcut')
      .in('status', ['active', 'resolved'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (eventRes.error || pairingsRes.error || participantsRes.error) return null;

  const rawCompetitionFormat = (eventRes.data as { competition_format?: string | null } | null)?.competition_format;
  const competitionFormat =
    rawCompetitionFormat === 'swiss' || rawCompetitionFormat === 'swiss_bo2' ? 'swiss' : 'round_robin';
  const pairingRows = (pairingsRes.data ?? []) as {
    id: string;
    participant_a_id: string;
    participant_b_id: string;
    swiss_round: number | null;
  }[];
  const officialPairingIds = pairingRows
    .filter((p) => (competitionFormat === 'swiss' ? p.swiss_round != null : true))
    .map((p) => p.id);
  const pairingById = new Map<string, EventTickerPairing>();
  for (const p of pairingRows) {
    pairingById.set(p.id, {
      id: p.id,
      participant_a_id: p.participant_a_id,
      participant_b_id: p.participant_b_id,
    });
  }

  const nameByParticipantId = new Map<string, string>();
  for (const row of participantsRes.data ?? []) {
    const u = relationOne(
      (row as { users?: { display_name?: string | null; username?: string } | null }).users
    );
    nameByParticipantId.set(
      String((row as { id: string }).id),
      u?.display_name || u?.username || 'Jugador'
    );
  }

  const bracketPhaseByPairingId = new Map<string, 'semi' | 'final' | 'third_place'>();
  const bracketPairingIds = new Set<string>();
  const tgId = (tgRes.data as { id?: string } | null)?.id;
  if (tgId && !tgRes.error) {
    const bmRes = await supabase
      .from('event_tiebreak_bracket_matches')
      .select('pairing_id, participant_a_id, participant_b_id, bracket_phase')
      .eq('group_id', tgId);
    if (!bmRes.error) {
      for (const row of bmRes.data ?? []) {
        const pid = resolveBracketPairingId(
          row as { pairing_id: string | null; participant_a_id: string; participant_b_id: string },
          pairingById
        );
        if (!pid) continue;
        bracketPairingIds.add(pid);
        bracketPhaseByPairingId.set(pid, (row as { bracket_phase: 'semi' | 'final' | 'third_place' }).bracket_phase);
      }
    }
  }

  const matchesRes =
    officialPairingIds.length > 0
      ? await supabase
          .from('matches')
          .select(
            'id, pairing_id, status, match_type, winner_participant_id, started_at, ended_at, starting_life_a, starting_life_b'
          )
          .in('pairing_id', officialPairingIds)
      : { data: [], error: null };

  if (matchesRes.error) return null;

  const tfRaw = (eventRes.data as { topcut_format?: string | null } | null)?.topcut_format;
  const topcutFormat = tfRaw === 'bo1' || tfRaw === 'sf_bo1_f_bo3' || tfRaw === 'bo3' ? tfRaw : 'bo3';

  return {
    eventId,
    currentMatchId,
    currentPairingId,
    turnTrackingEnabled: !!(eventRes.data as { turn_tracking_enabled?: boolean | null } | null)
      ?.turn_tracking_enabled,
    topcutFormat,
    nameByParticipantId,
    pairingById,
    bracketPhaseByPairingId,
    bracketPairingIds,
    matches: (matchesRes.data ?? []) as EventTickerMatch[],
  };
}

async function fetchLiveLivesByMatch(
  matchIds: string[],
  turnTrackingEnabled: boolean,
  matches: EventTickerMatch[],
  pairingById: Map<string, EventTickerPairing>
): Promise<Record<string, { lifeA: number; lifeB: number }>> {
  const out: Record<string, { lifeA: number; lifeB: number }> = {};
  for (const m of matches) {
    if (!matchIds.includes(m.id)) continue;
    const p = pairingById.get(m.pairing_id);
    if (!p) continue;
    out[m.id] = {
      lifeA: clampLife(Number(m.starting_life_a ?? 20)),
      lifeB: clampLife(Number(m.starting_life_b ?? 20)),
    };
  }
  if (matchIds.length === 0) return out;

  const applyLifeEventsToOut = (
    rows: { match_id: string; participant_id: string; resulting_life: number; occurred_at: string }[]
  ) => {
    const latest: Record<string, Record<string, { life: number; at: string }>> = {};
    for (const row of rows) {
      const mid = String(row.match_id);
      const pid = String(row.participant_id);
      const at = String(row.occurred_at);
      if (!latest[mid]) latest[mid] = {};
      const cur = latest[mid][pid];
      if (!cur || cur.at < at) {
        latest[mid][pid] = { life: Number(row.resulting_life), at };
      }
    }
    for (const mid of matchIds) {
      const matchRow = matches.find((x) => x.id === mid);
      if (!matchRow) continue;
      const p = pairingById.get(matchRow.pairing_id);
      if (!p) continue;
      const la = latest[mid]?.[p.participant_a_id]?.life;
      const lb = latest[mid]?.[p.participant_b_id]?.life;
      if (la != null) out[mid]!.lifeA = clampLife(la);
      if (lb != null) out[mid]!.lifeB = clampLife(lb);
    }
  };

  if (turnTrackingEnabled) {
    const turnsRes = await supabase
      .from('match_turns')
      .select('match_id, turn_number, life_a_after, life_b_after')
      .in('match_id', matchIds);
    if (!turnsRes.error) {
      const bestTurnByMatch = new Map<string, { turn: number; lifeA: number; lifeB: number }>();
      for (const row of turnsRes.data ?? []) {
        const mid = String(row.match_id);
        const tn = Number(row.turn_number);
        const cur = bestTurnByMatch.get(mid);
        if (!cur || tn > cur.turn) {
          bestTurnByMatch.set(mid, {
            turn: tn,
            lifeA: clampLife(Number(row.life_a_after)),
            lifeB: clampLife(Number(row.life_b_after)),
          });
        }
      }
      for (const [mid, v] of bestTurnByMatch) {
        out[mid] = { lifeA: v.lifeA, lifeB: v.lifeB };
      }
    }
  }

  const livesRes = await supabase
    .from('life_events')
    .select('match_id, participant_id, resulting_life, occurred_at')
    .in('match_id', matchIds);
  if (!livesRes.error && livesRes.data) {
    applyLifeEventsToOut(
      livesRes.data as {
        match_id: string;
        participant_id: string;
        resulting_life: number;
        occurred_at: string;
      }[]
    );
  }
  return out;
}

function buildCompletedTickerItem(ctx: EventTickerContext, m: EventTickerMatch): TickerQueueItem | null {
  if (m.status !== 'completed' || !m.winner_participant_id || !m.ended_at) return null;
  if (!isTickerEligibleMatch(m, ctx.bracketPairingIds)) return null;
  if (m.id === ctx.currentMatchId) return null;

  const pairing = ctx.pairingById.get(m.pairing_id);
  if (!pairing) return null;

  const nameA = ctx.nameByParticipantId.get(pairing.participant_a_id) ?? 'Jugador A';
  const nameB = ctx.nameByParticipantId.get(pairing.participant_b_id) ?? 'Jugador B';
  const { winsA, winsB } = pairingWinsForTicker(ctx, m.pairing_id);
  const closes = matchClosesSeries(ctx, m.pairing_id, winsA, winsB);
  const isBracket = ctx.bracketPairingIds.has(m.pairing_id);
  const phase = ctx.bracketPhaseByPairingId.get(m.pairing_id);
  const seriesLabel = isBracket && phase ? bracketPhaseTickerLabel(phase) : 'BO3';
  const durationLabel = formatTickerDuration(m.started_at, m.ended_at);
  const colorKey: TickerColorKey = closes ? 'closes' : 'partial';

  return {
    key: `completed:${m.id}`,
    colorKey,
    body: renderFinPartidaBody(
      nameA,
      nameB,
      m.winner_participant_id,
      pairing.participant_a_id,
      durationLabel,
      seriesLabel,
      winsA,
      winsB,
      closes
    ),
  };
}

async function enqueueLiveTickerMessages(
  ctx: EventTickerContext,
  enqueue: (item: TickerQueueItem) => void,
  liveNonce: number
): Promise<void> {
  const inProgress = ctx.matches.filter(
    (m) =>
      m.status === 'in_progress' &&
      m.id !== ctx.currentMatchId &&
      isTickerEligibleMatch(m, ctx.bracketPairingIds)
  );
  if (inProgress.length === 0) return;

  const lives = await fetchLiveLivesByMatch(
    inProgress.map((m) => m.id),
    ctx.turnTrackingEnabled,
    ctx.matches,
    ctx.pairingById
  );
  for (const m of inProgress) {
    const pairing = ctx.pairingById.get(m.pairing_id);
    if (!pairing) continue;
    const nameA = ctx.nameByParticipantId.get(pairing.participant_a_id) ?? 'Jugador A';
    const nameB = ctx.nameByParticipantId.get(pairing.participant_b_id) ?? 'Jugador B';
    const life = lives[m.id] ?? {
      lifeA: clampLife(Number(m.starting_life_a ?? 20)),
      lifeB: clampLife(Number(m.starting_life_b ?? 20)),
    };
    const durationLabel = formatTickerLiveElapsedMinutes(m.started_at);
    enqueue({
      key: `live:${m.id}:${liveNonce}`,
      colorKey: 'live',
      body: (
        <>
          EN VIVO · {nameA} {life.lifeA} - {life.lifeB} {nameB}
          {durationLabel ? ` · ${durationLabel}` : ''}
        </>
      ),
    });
  }
}

const TICKER_COLOR_STYLE = {
  live: newsTickerStyles.msgLive,
  partial: newsTickerStyles.msgPartial,
  closes: newsTickerStyles.msgClosesBo3,
} as const;

function NewsTickerMessagePair({
  style,
  children,
}: {
  style: { fontSize: number; color: string; fontWeight: '400' | '700' };
  children: React.ReactNode;
}) {
  return (
    <View style={newsTickerStyles.pairRow}>
      <Text style={style}>{children}</Text>
      <View style={newsTickerStyles.rotated}>
        <Text style={style}>{children}</Text>
      </View>
    </View>
  );
}

const NewsTickerStrip = React.memo(function NewsTickerStrip({
  item,
  leadingGap,
  playbackKey,
  onCycleComplete,
}: {
  item: TickerQueueItem | null;
  leadingGap: boolean;
  playbackKey: number;
  onCycleComplete: () => void;
}) {
  const itemId = item?.key ?? null;
  const translateX = useRef(new Animated.Value(0)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const [contentLayoutEpoch, setContentLayoutEpoch] = useState(0);
  const onCycleCompleteRef = useRef(onCycleComplete);
  const animGenRef = useRef(0);
  onCycleCompleteRef.current = onCycleComplete;

  useLayoutEffect(() => {
    if (__DEV__) {
      console.log('[NewsTicker] anim effect run', {
        playbackKey,
        viewportWidth,
        contentWidth,
        contentLayoutEpoch,
        hasItem: !!item,
        itemId,
      });
    }
    if (!item || !itemId || contentLayoutEpoch <= 0 || contentWidth <= 0 || viewportWidth <= 0) return;

    const startX = viewportWidth + (leadingGap ? NEWS_TICKER_MESSAGE_GAP_PX : 0);
    const endX = -contentWidth;
    const travelPx = startX - endX;
    const duration = (travelPx / viewportWidth) * NEWS_TICKER_MS_PER_VIEWPORT_WIDTH;
    const gen = ++animGenRef.current;
    translateX.setValue(startX);
    if (__DEV__) {
      console.log('[NewsTicker] anim start', { startX, endX, duration, itemId, playbackKey, leadingGap });
    }

    animRef.current?.stop();
    const anim = Animated.timing(translateX, {
      toValue: endX,
      duration,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    animRef.current = anim;
    anim.start(({ finished }) => {
      if (__DEV__) {
        console.log('[NewsTicker] anim end', { finished, itemId, gen, curGen: animGenRef.current });
      }
      if (finished && gen === animGenRef.current) {
        animRef.current = null;
        onCycleCompleteRef.current();
      }
    });

    return () => {
      if (__DEV__) {
        console.log('[NewsTicker] anim cleanup', itemId);
      }
      anim.stop();
      if (animRef.current === anim) animRef.current = null;
    };
  }, [itemId, playbackKey, viewportWidth, contentWidth, contentLayoutEpoch, leadingGap, translateX]);

  const colorStyle = item ? TICKER_COLOR_STYLE[item.colorKey] : newsTickerStyles.msgLive;

  return (
    <View
      style={newsTickerStyles.strip}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        if (w > 0) setViewportWidth(w);
      }}
      pointerEvents="none"
      collapsable={false}
    >
      {item && itemId ? (
        <Animated.View
          key={`ticker-play-${itemId}-${playbackKey}`}
          style={[newsTickerStyles.tickerTrack, { transform: [{ translateX }] }]}
          collapsable={false}
        >
          <View
            collapsable={false}
            onLayout={(e) => {
              const w = e.nativeEvent.layout.width;
              if (w <= 0) return;
              setContentWidth(w);
              setContentLayoutEpoch((n) => n + 1);
            }}
          >
            <View style={newsTickerStyles.content}>
              <NewsTickerMessagePair style={colorStyle}>{item.body}</NewsTickerMessagePair>
            </View>
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
}, (prev, next) => {
  return (
    prev.item?.key === next.item?.key &&
    prev.playbackKey === next.playbackKey &&
    prev.leadingGap === next.leadingGap &&
    prev.onCycleComplete === next.onCycleComplete
  );
});

const computeSurroundPositions = (count: number, radius = 50) => {
  if (count === 3) {
    return [
      { x: -radius, y: 0 },
      { x: 0, y: -radius },
      { x: radius, y: 0 },
    ];
  }
  if (count === 4) {
    return [
      { x: 0, y: -radius },
      { x: 0, y: radius },
      { x: -radius, y: 0 },
      { x: radius, y: 0 },
    ];
  }
  return [];
};

function measureAvatarCenterInScroll(
  wrap: View | null,
  content: View | null
): Promise<{ cx: number; cy: number }> {
  return new Promise((resolve) => {
    if (!wrap || !content) {
      resolve({ cx: 180, cy: 220 });
      return;
    }
    wrap.measureInWindow((wx, wy, ww, wh) => {
      content.measureInWindow((cwx, cwy, _cww, _cwh) => {
        resolve({
          cx: wx - cwx + ww / 2,
          cy: wy - cwy + wh / 2,
        });
      });
    });
  });
}

async function navigateAfterMatchMaybeComplete(
  navigation: NativeStackNavigationProp<MainStackParamList, 'LifeTracker'>,
  eventId: string,
  matchId: string,
  previousEventStatus: string | null | undefined
): Promise<void> {
  if (previousEventStatus === 'completed') {
    navigation.replace('MatchResult', { matchId });
    return;
  }
  const delays = [1500, 700, 700];
  for (const ms of delays) {
    await new Promise((r) => setTimeout(r, ms));
    const { data, error } = await supabase.from('draft_events').select('status').eq('id', eventId).maybeSingle();
    if (!error && data?.status === 'completed') {
      navigation.replace('Standings', { eventId, showPodiumIntro: true });
      return;
    }
  }
  navigation.replace('MatchResult', { matchId });
}

const COLOR_BG: Record<MtgColor, string> = {
  W: '#F8FAFC',
  U: '#DBEAFE',
  B: '#374151',
  R: '#FEE2E2',
  G: '#DCFCE7',
  C: '#E5E7EB',
};

function hashSeedString(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function createSeededRandom(seed: string): () => number {
  let state = hashSeedString(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickCoordinatedBgColors(
  colorsA: MtgColor[],
  colorsB: MtgColor[],
  seed: string
): { bgA: MtgColor; bgB: MtgColor } {
  const poolA: MtgColor[] = colorsA.length > 0 ? colorsA : ['C'];
  const poolB: MtgColor[] = colorsB.length > 0 ? colorsB : ['C'];
  const rng = createSeededRandom(seed);

  let firstSide: 'a' | 'b';
  if (poolA.length < poolB.length) firstSide = 'a';
  else if (poolB.length < poolA.length) firstSide = 'b';
  else firstSide = rng() < 0.5 ? 'a' : 'b';

  const [firstPool, secondPool] = firstSide === 'a' ? [poolA, poolB] : [poolB, poolA];
  const firstPick = firstPool[Math.floor(rng() * firstPool.length)]!;
  const secondCandidates = secondPool.filter((c) => c !== firstPick);
  const secondPick =
    secondCandidates.length > 0
      ? secondCandidates[Math.floor(rng() * secondCandidates.length)]!
      : firstPick;

  if (firstSide === 'a') return { bgA: firstPick, bgB: secondPick };
  return { bgA: secondPick, bgB: firstPick };
}

export default function LifeTrackerScreen({ route, navigation }: Props) {
  useKeepAwake();
  const { matchId } = route.params;
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  /** Otro match in_progress del mismo jugador en otro pairing. */
  const [concurrentBlockMessage, setConcurrentBlockMessage] = useState<string | null>(null);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [turnTrackingEnabled, setTurnTrackingEnabled] = useState(false);
  const [whoStartedParticipantId, setWhoStartedParticipantId] = useState<string | null>(null);
  const [savingStarter, setSavingStarter] = useState(false);
  const [currentTurnParticipantId, setCurrentTurnParticipantId] = useState<string | null>(null);
  const [turnStartLifeA, setTurnStartLifeA] = useState(20);
  const [turnStartLifeB, setTurnStartLifeB] = useState(20);
  const [turnStartedAt, setTurnStartedAt] = useState<string | null>(null);
  const [lastTurnNumber, setLastTurnNumber] = useState(0);
  const [passingTurn, setPassingTurn] = useState(false);
  const [match, setMatch] = useState<MatchRow | null>(null);
  const [pairing, setPairing] = useState<PairingRow | null>(null);
  const [pa, setPa] = useState<ParticipantRow | null>(null);
  const [pb, setPb] = useState<ParticipantRow | null>(null);
  const [showShinyAnimA, setShowShinyAnimA] = useState(false);
  const [showShinyAnimB, setShowShinyAnimB] = useState(false);
  const [colorsA, setColorsA] = useState<MtgColor[]>([]);
  const [colorsB, setColorsB] = useState<MtgColor[]>([]);
  const [memberBColorsA, setMemberBColorsA] = useState<MtgColor[]>([]);
  const [memberBColorsB, setMemberBColorsB] = useState<MtgColor[]>([]);
  const [winsA, setWinsA] = useState(0);
  const [winsB, setWinsB] = useState(0);
  const [stableA, setStableA] = useState(20);
  const [stableB, setStableB] = useState(20);
  const [pendingA, setPendingA] = useState<number | null>(null);
  const [pendingB, setPendingB] = useState<number | null>(null);
  const stableARef = useRef(20);
  const stableBRef = useRef(20);
  const pendingARef = useRef<number | null>(null);
  const pendingBRef = useRef<number | null>(null);
  const [persistingA, setPersistingA] = useState(false);
  const [persistingB, setPersistingB] = useState(false);
  const historyRef = useRef<LifeSnapshot[]>([]);
  const timerARef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerBRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const myUserIdRef = useRef<string | null>(null);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [isGiantEvent, setIsGiantEvent] = useState(false);
  const pairingRef = useRef<PairingRow | null>(null);
  const lifeRealtimeChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const diffOpacityA = useRef(new Animated.Value(0)).current;
  const diffOpacityB = useRef(new Animated.Value(0)).current;
  const attackTravel = useRef(new Animated.Value(0)).current;
  const defenderShake = useRef(new Animated.Value(0)).current;
  const attackerShake = useRef(new Animated.Value(0)).current;
  const attackSelfOpacity = useRef(new Animated.Value(1)).current;
  const specialPreAnim = useRef(new Animated.Value(0)).current;
  const surroundFade = useRef(new Animated.Value(0)).current;
  const circularProgress = useRef(new Animated.Value(0)).current;
  const circularTx = useMemo(
    () =>
      circularProgress.interpolate({
        inputRange: [0, 0.25, 0.5, 0.75, 1],
        outputRange: [0, 60, 0, -60, 0],
      }),
    [circularProgress]
  );
  const circularTy = useMemo(
    () =>
      circularProgress.interpolate({
        inputRange: [0, 0.25, 0.5, 0.75, 1],
        outputRange: [-60, 0, 60, 0, -60],
      }),
    [circularProgress]
  );
  const [attackingFrom, setAttackingFrom] = useState<'a' | 'b' | null>(null);
  const [attackEmoji, setAttackEmoji] = useState<string | null>(null);
  const [attackMoveTarget, setAttackMoveTarget] = useState<MoveTarget | null>(null);
  type SurroundPayload = { cx: number; cy: number; items: { x: number; y: number; emoji: string }[] };
  type CircularPayload = { cx: number; cy: number; emoji: string };
  const [surroundPayload, setSurroundPayload] = useState<SurroundPayload | null>(null);
  const [circularPayload, setCircularPayload] = useState<CircularPayload | null>(null);
  const [specialEmoji, setSpecialEmoji] = useState<string | null>(null);
  const [specialType, setSpecialType] = useState<'ditto' | 'metronome' | null>(null);
  const [lifeDisplayedA, setLifeDisplayedA] = useState(20);
  const [lifeDisplayedB, setLifeDisplayedB] = useState(20);
  const scrollContentLayoutRef = useRef<View>(null);
  const avatarWrapMeasureRefA = useRef<View>(null);
  const avatarWrapMeasureRefB = useRef<View>(null);
  const avatarPositionA = useRef(0);
  const avatarPositionB = useRef(0);
  const [tickerPlay, setTickerPlay] = useState<{
    current: TickerQueueItem | null;
    leadingGap: boolean;
    playbackKey: number;
  }>({ current: null, leadingGap: false, playbackKey: 0 });
  const tickerQueueRef = useRef<TickerQueueItem[]>([]);
  const tickerDedupeRef = useRef(new Set<string>());
  const tickerCtxRef = useRef<EventTickerContext | null>(null);
  const finishedMatchesRef = useRef(new Set<string>());
  const pendingFinishedRef = useRef<PendingFinishedTicker[]>([]);
  const liveTickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const checkpointRef = useRef(0);
  const liveFireNonceRef = useRef(0);
  const lastTickerEventIdRef = useRef<string | null>(null);
  const processBannerIdleRef = useRef<() => void>(() => {});

  const aLife = pendingA ?? stableA;
  const bLife = pendingB ?? stableB;
  const deltaA = clampLife((pendingA ?? stableA)) - stableA;
  const deltaB = clampLife((pendingB ?? stableB)) - stableB;
  const canUndo = historyRef.current.length > 1;

  const clearPendingAdjustments = useCallback(() => {
    if (timerARef.current) clearTimeout(timerARef.current);
    if (timerBRef.current) clearTimeout(timerBRef.current);
    timerARef.current = null;
    timerBRef.current = null;
    pendingARef.current = null;
    pendingBRef.current = null;
    setPendingA(null);
    setPendingB(null);
  }, []);

  useEffect(() => {
    Animated.timing(diffOpacityA, {
      toValue: deltaA !== 0 ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [deltaA, diffOpacityA]);

  useEffect(() => {
    Animated.timing(diffOpacityB, {
      toValue: deltaB !== 0 ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [deltaB, diffOpacityB]);

  const enqueueTickerItem = useCallback((item: TickerQueueItem) => {
    if (tickerDedupeRef.current.has(item.key)) return;
    tickerDedupeRef.current.add(item.key);
    const wasEmpty = tickerQueueRef.current.length === 0;
    tickerQueueRef.current = [...tickerQueueRef.current, item];
    if (__DEV__) {
      console.log('[NewsTicker] enqueue', item.key, 'len', tickerQueueRef.current.length, 'wasEmpty', wasEmpty);
    }
    if (wasEmpty) {
      if (__DEV__) console.log('[NewsTicker] show', item.key);
      setTickerPlay((prev) => ({
        current: item,
        leadingGap: false,
        playbackKey: prev.playbackKey + 1,
      }));
    }
  }, []);

  const onTickerCycleComplete = useCallback(() => {
    const finishedKey = tickerQueueRef.current[0]?.key;
    tickerQueueRef.current = tickerQueueRef.current.slice(1);
    const next = tickerQueueRef.current[0] ?? null;
    if (__DEV__) {
      console.log('[NewsTicker] onCycleComplete', finishedKey, 'next', next?.key ?? '(empty)');
    }
    setTickerPlay((prev) => ({
      current: next,
      leadingGap: next != null,
      playbackKey: prev.playbackKey + 1,
    }));
    if (!next && __DEV__) {
      console.log('[NewsTicker] idle (cleared current)');
    }
    if (__DEV__ && next) {
      console.log('[NewsTicker] show', next.key, 'leadingGap', true);
    }
    if (!next) {
      processBannerIdleRef.current();
    }
  }, []);

  const reloadTickerContext = useCallback(async () => {
    if (!pairing?.event_id) return null;
    const ctx = await fetchEventTickerContext(pairing.event_id, matchId, pairing.id);
    tickerCtxRef.current = ctx;
    return ctx;
  }, [pairing?.event_id, pairing?.id, matchId]);

  useEffect(() => {
    if (!pairing || loading || blocked || concurrentBlockMessage) return;

    let cancelled = false;
    checkpointRef.current = Date.now();

    if (lastTickerEventIdRef.current !== pairing.event_id) {
      lastTickerEventIdRef.current = pairing.event_id;
      finishedMatchesRef.current.clear();
      pendingFinishedRef.current = [];
    }

    const scheduleLiveTickFromIdle = () => {
      if (cancelled) return;
      if (liveTickTimeoutRef.current) clearTimeout(liveTickTimeoutRef.current);
      if (__DEV__) {
        console.log('[NewsTicker] schedule EN VIVO in', NEWS_TICKER_LIVE_INTERVAL_MS / 1000, 's');
      }
      liveTickTimeoutRef.current = setTimeout(() => {
        liveTickTimeoutRef.current = null;
        void fireLiveTick();
      }, NEWS_TICKER_LIVE_INTERVAL_MS);
    };

    async function fireLiveTick() {
      if (cancelled) return;
      liveFireNonceRef.current += 1;
      const nonce = liveFireNonceRef.current;
      const ctx = await reloadTickerContext();
      const lenBefore = tickerQueueRef.current.length;
      if (ctx) {
        await enqueueLiveTickerMessages(ctx, enqueueTickerItem, nonce);
      }
      if (!cancelled && tickerQueueRef.current.length === lenBefore) {
        scheduleLiveTickFromIdle();
      }
    }

    const flushPendingFinishedToQueue = () => {
      const batch = [...pendingFinishedRef.current];
      if (batch.length === 0) return false;
      pendingFinishedRef.current = [];
      for (const row of batch) {
        finishedMatchesRef.current.add(row.matchId);
        enqueueTickerItem(row.message);
      }
      return true;
    };

    const processBannerIdle = () => {
      if (tickerQueueRef.current.length > 0) return;
      if (flushPendingFinishedToQueue()) return;
      scheduleLiveTickFromIdle();
    };
    processBannerIdleRef.current = processBannerIdle;

    const runCompletedPoll = async () => {
      if (cancelled) return;
      const chk = checkpointRef.current;
      const ctx = await reloadTickerContext();
      checkpointRef.current = Date.now();
      if (!ctx) return;

      const pendingIds = new Set(pendingFinishedRef.current.map((p) => p.matchId));

      let added = false;
      for (const m of ctx.matches) {
        if (m.status !== 'completed' || !m.ended_at) continue;
        if (new Date(m.ended_at).getTime() <= chk) continue;
        if (m.id === ctx.currentMatchId) continue;
        if (!isTickerEligibleMatch(m, ctx.bracketPairingIds)) continue;
        if (finishedMatchesRef.current.has(m.id)) continue;
        if (pendingIds.has(m.id)) continue;
        const item = buildCompletedTickerItem(ctx, m);
        if (!item) continue;
        pendingFinishedRef.current.push({ matchId: m.id, message: item });
        pendingIds.add(m.id);
        added = true;
      }

      if (added && !cancelled && tickerQueueRef.current.length === 0) {
        processBannerIdle();
      }
    };

    void reloadTickerContext();
    pollIntervalRef.current = setInterval(() => {
      void runCompletedPoll();
    }, NEWS_TICKER_POLL_COMPLETED_MS);
    void runCompletedPoll();
    scheduleLiveTickFromIdle();

    return () => {
      cancelled = true;
      processBannerIdleRef.current = () => {};
      if (liveTickTimeoutRef.current) {
        clearTimeout(liveTickTimeoutRef.current);
        liveTickTimeoutRef.current = null;
      }
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [pairing, loading, blocked, concurrentBlockMessage, reloadTickerContext, enqueueTickerItem]);

  useEffect(() => {
    if (loading) {
      setShowShinyAnimA(false);
      setShowShinyAnimB(false);
      return;
    }
    if (!pa || !pb) {
      setShowShinyAnimA(false);
      setShowShinyAnimB(false);
      return;
    }
    if (turnTrackingEnabled && whoStartedParticipantId == null) {
      setShowShinyAnimA(false);
      setShowShinyAnimB(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const key = `shiny_lt_anim_${matchId}`;
      const seen = await AsyncStorage.getItem(key);
      if (cancelled) return;
      if (seen) {
        setShowShinyAnimA(false);
        setShowShinyAnimB(false);
        return;
      }
      const aShiny = !!pa.is_shiny;
      const bShiny = !!pb.is_shiny;
      setShowShinyAnimA(aShiny);
      setShowShinyAnimB(bShiny);
      if (aShiny || bShiny) {
        await AsyncStorage.setItem(key, '1');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    loading,
    matchId,
    pa,
    pb,
    turnTrackingEnabled,
    whoStartedParticipantId,
  ]);

  const updateAvatarYInScrollContent = useCallback((slot: 'a' | 'b') => {
    const wrap = slot === 'a' ? avatarWrapMeasureRefA.current : avatarWrapMeasureRefB.current;
    const content = scrollContentLayoutRef.current;
    if (!wrap || !content) return;
    wrap.measureInWindow((_wx, wy, _ww, _wh) => {
      content.measureInWindow((_cx, cy, _cw, _ch) => {
        const relativeY = wy - cy;
        if (slot === 'a') avatarPositionA.current = relativeY;
        else avatarPositionB.current = relativeY;
      });
    });
  }, []);

  const load = useCallback(async () => {
    setConcurrentBlockMessage(null);
    const meRes = await supabase.auth.getUser();
    const uid = meRes.data.user?.id ?? null;
    myUserIdRef.current = uid;
    setSessionUserId(uid);

    const { data: mData, error: mErr } = await supabase
      .from('matches')
      .select(
        'id, pairing_id, winner_participant_id, match_type, starting_life_a, starting_life_b, life_tracker_user_id, status, who_started_participant_id'
      )
      .eq('id', matchId)
      .maybeSingle();
    if (mErr || !mData) {
      Alert.alert('Error', 'No se pudo cargar la partida.');
      setLoading(false);
      return;
    }
    const matchRow = mData as MatchRow;
    setMatch(matchRow);
    setWhoStartedParticipantId(matchRow.who_started_participant_id ?? null);

    const { data: pData, error: pErr } = await supabase
      .from('pairings')
      .select('id, event_id, participant_a_id, participant_b_id')
      .eq('id', matchRow.pairing_id)
      .maybeSingle();
    if (pErr || !pData) {
      Alert.alert('Error', 'No se pudo cargar el enfrentamiento.');
      setLoading(false);
      return;
    }
    const pairingRow = pData as PairingRow;
    setPairing(pairingRow);

    const [eventRes, participantsRes, colorsRes, lifeRes, winsRes, latestTgRes] = await Promise.all([
      supabase
        .from('draft_events')
        .select('workspace_id, turn_tracking_enabled, event_type')
        .eq('id', pairingRow.event_id)
        .maybeSingle(),
      supabase
        .from('event_participants')
        .select(
          `
          id,
          user_id,
          member_b_user_id,
          giant_name,
          is_shiny,
          rotated_avatar_id,
          rotated_avatar:default_avatars!rotated_avatar_id(storage_path, storage_path_shiny),
          users!event_participants_user_id_fkey (
            username,
            display_name,
            custom_avatar_path,
            default_avatars (storage_path)
          )
        `
        )
        .in('id', [pairingRow.participant_a_id, pairingRow.participant_b_id]),
      supabase
        .from('participant_colors')
        .select('participant_id, color, member')
        .in('participant_id', [pairingRow.participant_a_id, pairingRow.participant_b_id]),
      supabase.from('life_events').select('participant_id, resulting_life, occurred_at').eq('match_id', matchId),
      supabase
        .from('matches')
        .select('id, winner_participant_id, match_type, status')
        .eq('pairing_id', pairingRow.id)
        .eq('status', 'completed')
        .not('winner_participant_id', 'is', null),
      supabase
        .from('event_tiebreak_groups')
        .select('id, group_type, group_origin')
        .eq('event_id', pairingRow.event_id)
        .in('status', ['active', 'resolved'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (
      participantsRes.error ||
      colorsRes.error ||
      lifeRes.error ||
      winsRes.error ||
      eventRes.error ||
      latestTgRes.error
    ) {
      Alert.alert('Error', 'No se pudo cargar el estado del life tracker.');
      setLoading(false);
      return;
    }

    const pRowsPre = (participantsRes.data ?? []) as ParticipantRow[];
    const pMapPre = new Map(pRowsPre.map((x) => [x.id, x]));
    const rowA = pMapPre.get(pairingRow.participant_a_id);
    const rowB = pMapPre.get(pairingRow.participant_b_id);
    const uA = relationOne(rowA?.users);
    const uB = relationOne(rowB?.users);
    const preNameA = uA?.display_name || uA?.username || 'Jugador A';
    const preNameB = uB?.display_name || uB?.username || 'Jugador B';

    const wsId = eventRes.data?.workspace_id as string | undefined;
    const evFlags = eventRes.data as { turn_tracking_enabled?: boolean | null; event_type?: string | null } | null;
    setTurnTrackingEnabled(!!evFlags?.turn_tracking_enabled);
    setIsGiantEvent(evFlags?.event_type === 'two_headed_giant');
    const [roleRes, concurrentDetails] = await Promise.all([
      wsId && uid
        ? supabase
            .from('workspace_members')
            .select('role')
            .eq('workspace_id', wsId)
            .eq('user_id', uid)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      findConcurrentInProgressDetailsForPairParticipants({
        eventId: pairingRow.event_id,
        excludePairingId: pairingRow.id,
        participantAId: pairingRow.participant_a_id,
        participantBId: pairingRow.participant_b_id,
      }),
    ]);
    if (roleRes.error) {
      if (__DEV__) {
        console.error('Error cargando rol del workspace:', roleRes.error);
      }
    }
    const organizer = !roleRes.error && roleRes.data?.role === 'organizer';
    setIsOrganizer(organizer);

    const blockMsg = formatConcurrentMatchBlockMessage({
      nameA: preNameA,
      nameB: preNameB,
      participantAId: pairingRow.participant_a_id,
      participantBId: pairingRow.participant_b_id,
      userIdA: rowA?.user_id ?? '',
      userIdB: rowB?.user_id ?? '',
      myUserId: uid,
      isWorkspaceOrganizer: organizer,
      aInOtherMatchId: concurrentDetails.participantAInOtherMatchId,
      bInOtherMatchId: concurrentDetails.participantBInOtherMatchId,
    });
    if (blockMsg) {
      setConcurrentBlockMessage(blockMsg);
      setLoading(false);
      return;
    }

    const pRows = pRowsPre;
    const pMap = pMapPre;
    setPa(pMap.get(pairingRow.participant_a_id) ?? null);
    setPb(pMap.get(pairingRow.participant_b_id) ?? null);

    const colorMapA: Record<string, MtgColor[]> = {};
    const colorMapB: Record<string, MtgColor[]> = {};
    for (const c of colorsRes.data ?? []) {
      const pid = c.participant_id as string;
      const mem = (c as { member?: string | null }).member;
      if (mem == null || mem === 'a') {
        if (!colorMapA[pid]) colorMapA[pid] = [];
        colorMapA[pid].push(c.color as MtgColor);
      } else if (mem === 'b') {
        if (!colorMapB[pid]) colorMapB[pid] = [];
        colorMapB[pid].push(c.color as MtgColor);
      }
    }
    setColorsA(colorMapA[pairingRow.participant_a_id] ?? []);
    setColorsB(colorMapA[pairingRow.participant_b_id] ?? []);
    setMemberBColorsA(colorMapB[pairingRow.participant_a_id] ?? []);
    setMemberBColorsB(colorMapB[pairingRow.participant_b_id] ?? []);

    const latestByParticipant: Record<string, { life: number; at: string }> = {};
    for (const e of lifeRes.data ?? []) {
      const pid = e.participant_id as string;
      const at = String(e.occurred_at);
      if (!latestByParticipant[pid] || latestByParticipant[pid].at < at) {
        latestByParticipant[pid] = { life: Number(e.resulting_life), at };
      }
    }
    const initialA = clampLife(latestByParticipant[pairingRow.participant_a_id]?.life ?? matchRow.starting_life_a);
    const initialB = clampLife(latestByParticipant[pairingRow.participant_b_id]?.life ?? matchRow.starting_life_b);
    setStableA(initialA);
    setStableB(initialB);
    stableARef.current = initialA;
    stableBRef.current = initialB;
    setPendingA(null);
    setPendingB(null);
    pendingARef.current = null;
    pendingBRef.current = null;
    historyRef.current = [{ a: initialA, b: initialB }];

    const wins = (winsRes.data ?? []) as { id: string; winner_participant_id: string; match_type: string }[];
    let pillWinsA = 0;
    let pillWinsB = 0;
    const officialWins = wins.filter((w) => w.match_type === 'draft' || w.match_type === 'final');
    const tg = latestTgRes.data as { id: string; group_type: string; group_origin: string | null } | null;
    const isSwissTopcutBracketTiebreak =
      matchRow.match_type === 'tiebreak' &&
      tg?.group_type === 'bracket' &&
      tg.group_origin === 'swiss_topcut';
    if (isSwissTopcutBracketTiebreak) {
      const bmr = await supabase
        .from('event_tiebreak_bracket_matches')
        .select('pairing_id, participant_a_id, participant_b_id')
        .eq('group_id', tg.id);
      const rows = (bmr.data ?? []) as {
        pairing_id: string | null;
        participant_a_id: string;
        participant_b_id: string;
      }[];
      const inBracketLeg = !bmr.error && rows.some((r) => bracketRowMatchesPairing(r, pairingRow));
      if (inBracketLeg) {
        const priorTiebreak = wins.filter((w) => w.match_type === 'tiebreak' && w.id !== matchRow.id);
        pillWinsA = priorTiebreak.filter((w) => w.winner_participant_id === pairingRow.participant_a_id).length;
        pillWinsB = priorTiebreak.filter((w) => w.winner_participant_id === pairingRow.participant_b_id).length;
      } else {
        pillWinsA = officialWins.filter((w) => w.winner_participant_id === pairingRow.participant_a_id).length;
        pillWinsB = officialWins.filter((w) => w.winner_participant_id === pairingRow.participant_b_id).length;
      }
    } else {
      pillWinsA = officialWins.filter((w) => w.winner_participant_id === pairingRow.participant_a_id).length;
      pillWinsB = officialWins.filter((w) => w.winner_participant_id === pairingRow.participant_b_id).length;
    }
    setWinsA(pillWinsA);
    setWinsB(pillWinsB);

    let lifeDispA = clampLife(matchRow.starting_life_a);
    let lifeDispB = clampLife(matchRow.starting_life_b);

    const turnTrackOn = !!evFlags?.turn_tracking_enabled;
    if (turnTrackOn) {
      const turnsRes = await supabase
        .from('match_turns')
        .select('turn_number, attacker_participant_id, life_a_after, life_b_after, ended_at')
        .eq('match_id', matchId)
        .order('turn_number', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (turnsRes.error) {
        if (__DEV__) console.error('match_turns load:', turnsRes.error);
        setLastTurnNumber(0);
        setCurrentTurnParticipantId(matchRow.who_started_participant_id ?? null);
        setTurnStartLifeA(initialA);
        setTurnStartLifeB(initialB);
        setTurnStartedAt(new Date().toISOString());
      } else {
        const last = turnsRes.data as {
          turn_number: number;
          attacker_participant_id: string;
          life_a_after: number;
          life_b_after: number;
          ended_at: string | null;
        } | null;
        if (last) {
          setLastTurnNumber(last.turn_number);
          const nextPid =
            last.attacker_participant_id === pairingRow.participant_a_id
              ? pairingRow.participant_b_id
              : pairingRow.participant_a_id;
          setCurrentTurnParticipantId(nextPid);
          setTurnStartLifeA(clampLife(Number(last.life_a_after)));
          setTurnStartLifeB(clampLife(Number(last.life_b_after)));
          setTurnStartedAt(last.ended_at ?? new Date().toISOString());
          lifeDispA = clampLife(Number(last.life_a_after));
          lifeDispB = clampLife(Number(last.life_b_after));
        } else {
          setLastTurnNumber(0);
          setCurrentTurnParticipantId(matchRow.who_started_participant_id ?? null);
          setTurnStartLifeA(initialA);
          setTurnStartLifeB(initialB);
          setTurnStartedAt(new Date().toISOString());
        }
      }
    } else {
      setLastTurnNumber(0);
      setCurrentTurnParticipantId(null);
      setTurnStartLifeA(initialA);
      setTurnStartLifeB(initialB);
      setTurnStartedAt(null);
    }

    setLifeDisplayedA(lifeDispA);
    setLifeDisplayedB(lifeDispB);

    const trackerUserId = matchRow.life_tracker_user_id;
    if (!uid) {
      setBlocked(true);
      setLoading(false);
      return;
    }
    if (!trackerUserId) {
      const lockRes = await supabase
        .from('matches')
        .update({ life_tracker_user_id: uid })
        .eq('id', matchId);
      if (lockRes.error) {
        Alert.alert('Error', lockRes.error.message ?? 'No se pudo tomar control de la partida.');
      }
      setBlocked(false);
    } else if (trackerUserId === uid) {
      setBlocked(false);
    } else if (!organizer) {
      setBlocked(true);
    } else {
      setBlocked(true);
    }

    setLoading(false);
  }, [matchId]);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => {
        if (timerARef.current) clearTimeout(timerARef.current);
        if (timerBRef.current) clearTimeout(timerBRef.current);
      };
    }, [load])
  );

  useEffect(() => {
    pairingRef.current = pairing;
  }, [pairing]);

  useEffect(() => {
    if (lifeRealtimeChannelRef.current) return;
    const channel = supabase
      .channel(`match-life:${matchId}:${Date.now()}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'life_events', filter: `match_id=eq.${matchId}` },
        (payload) => {
          const row = payload.new as { participant_id?: string; resulting_life?: number } | null;
          const pr = pairingRef.current;
          if (!row?.participant_id || row.resulting_life == null || !pr) return;
          if (row.participant_id === pr.participant_a_id) {
            const v = clampLife(Number(row.resulting_life));
            stableARef.current = v;
            pendingARef.current = null;
            setStableA(v);
            setPendingA(null);
          } else if (row.participant_id === pr.participant_b_id) {
            const v = clampLife(Number(row.resulting_life));
            stableBRef.current = v;
            pendingBRef.current = null;
            setStableB(v);
            setPendingB(null);
          }
        }
      )
      .subscribe();
    lifeRealtimeChannelRef.current = channel;
    return () => {
      void channel.unsubscribe();
      void supabase.removeChannel(channel);
      lifeRealtimeChannelRef.current = null;
    };
  }, [matchId]);

  const pairingsFromTab = route.params.fromTab ?? 'official';

  useLayoutEffect(() => {
    if (!pairing) return;
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'PairingDetail', {
        pairingId: pairing.id,
        fromTab: pairingsFromTab,
      }),
    });
  }, [navigation, pairing?.id, pairingsFromTab]);

  const persistLife = useCallback(
    async (target: 'a' | 'b', overrideValue?: number, checkWin = true) => {
      if (!pairing) return;
      const participantId =
        target === 'a' ? pairing.participant_a_id : pairing.participant_b_id;
      const stable = clampLife(target === 'a' ? stableARef.current : stableBRef.current);
      const pending =
        overrideValue ?? (target === 'a' ? pendingARef.current : pendingBRef.current);
      if (pending == null) return;
      const normalizedPending = clampLife(pending);
      if (normalizedPending === stable) return;
      const delta = normalizedPending - stable;
      if (delta === 0) return;
      if (target === 'a') setPersistingA(true);
      else setPersistingB(true);

      const { data, error } = await supabase
        .from('life_events')
        .insert({
          match_id: matchId,
          participant_id: participantId,
          delta,
          resulting_life: normalizedPending,
        })
        .select('id, resulting_life')
        .maybeSingle();
      if (target === 'a') setPersistingA(false);
      else setPersistingB(false);

      if (error) {
        if (target === 'a') {
          pendingARef.current = null;
          setPendingA(null);
        } else {
          pendingBRef.current = null;
          setPendingB(null);
        }
        Alert.alert('Error', error.message ?? 'No se pudo guardar el cambio de vida.');
        return;
      }
      const persistedLife = clampLife(Number(data?.resulting_life ?? normalizedPending));
      const insertedLifeEventId = (data as { id?: string } | null)?.id ?? null;

      if (target === 'a') {
        stableARef.current = persistedLife;
        pendingARef.current = null;
        setStableA(persistedLife);
        setPendingA(null);
      } else {
        stableBRef.current = persistedLife;
        pendingBRef.current = null;
        setStableB(persistedLife);
        setPendingB(null);
      }
      historyRef.current = [
        ...historyRef.current.slice(-9),
        target === 'a'
          ? { a: persistedLife, b: stableBRef.current }
          : { a: stableARef.current, b: persistedLife },
      ];

      if (checkWin && persistedLife === 0) {
        const winnerParticipantId =
          target === 'a' ? pairing.participant_b_id : pairing.participant_a_id;
        const uA = relationOne(pa?.users);
        const uB = relationOne(pb?.users);
        const nmA = (isGiantEvent && pa?.giant_name) ? pa.giant_name : (uA?.display_name || uA?.username || 'Jugador A');
        const nmB = (isGiantEvent && pb?.giant_name) ? pb.giant_name : (uB?.display_name || uB?.username || 'Jugador B');
        const winnerName = target === 'a' ? nmB : nmA;
        const stableBeforeZero = stable;
        const participantIdForZero = participantId;
        Alert.alert('Fin de partida', '¿Confirmás el resultado?', [
          {
            text: 'Cancelar',
            style: 'cancel',
            onPress: () => {
              clearPendingAdjustments();
              void (async () => {
                let idToDelete = insertedLifeEventId;
                if (!idToDelete) {
                  const lastRes = await supabase
                    .from('life_events')
                    .select('id')
                    .eq('match_id', matchId)
                    .eq('participant_id', participantIdForZero)
                    .eq('resulting_life', 0)
                    .order('occurred_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();
                  if (lastRes.error || !lastRes.data?.id) {
                    Alert.alert(
                      'Error',
                      lastRes.error?.message ?? 'No se pudo deshacer el golpe de gracia.'
                    );
                    return;
                  }
                  idToDelete = lastRes.data.id as string;
                }
                const delRes = await supabase.from('life_events').delete().eq('id', idToDelete);
                if (delRes.error) {
                  Alert.alert('Error', delRes.error.message ?? 'No se pudo deshacer el golpe de gracia.');
                  return;
                }
                const prevLife = clampLife(stableBeforeZero);
                if (target === 'a') {
                  stableARef.current = prevLife;
                  pendingARef.current = null;
                  setStableA(prevLife);
                  setPendingA(null);
                } else {
                  stableBRef.current = prevLife;
                  pendingBRef.current = null;
                  setStableB(prevLife);
                  setPendingB(null);
                }
                if (historyRef.current.length > 1) {
                  historyRef.current = historyRef.current.slice(0, -1);
                }
              })();
            },
          },
          {
            text: `Confirmar: gana ${winnerName}`,
            onPress: async () => {
              if (!pairing) return;
              const eventBeforeRes = await supabase
                .from('draft_events')
                .select('status')
                .eq('id', pairing.event_id)
                .maybeSingle();
              const previousEventStatus = eventBeforeRes.data?.status;
              const endRes = await supabase
                .from('matches')
                .update({
                  winner_participant_id: winnerParticipantId,
                  ended_at: new Date().toISOString(),
                  status: 'completed',
                })
                .eq('id', matchId);
              if (endRes.error) {
                Alert.alert('Error', endRes.error.message ?? 'No se pudo cerrar la partida.');
                return;
              }
              if (pairing) {
                void navigateAfterMatchMaybeComplete(
                  navigation,
                  pairing.event_id,
                  matchId,
                  previousEventStatus
                );
              } else {
                navigation.replace('MatchResult', { matchId });
              }
            },
          },
        ]);
      }
    },
    [clearPendingAdjustments, matchId, navigation, pairing, pa, pb]
  );

  const queuePersist = useCallback(
    (target: 'a' | 'b') => {
      const ref = target === 'a' ? timerARef : timerBRef;
      if (ref.current) clearTimeout(ref.current);
      const delayMs = turnTrackingEnabled ? 1000 : 3500;
      ref.current = setTimeout(() => {
        void persistLife(target);
      }, delayMs);
    },
    [persistLife, turnTrackingEnabled]
  );

  const adjustLife = useCallback(
    (target: 'a' | 'b', delta: number) => {
      if (blocked) return;
      if (target === 'a') {
        const current = clampLife(pendingARef.current ?? stableARef.current);
        if (delta < 0 && current <= 0) return;
        const next = clampLife(current + delta);
        pendingARef.current = next;
        setPendingA(next);
      } else {
        const current = clampLife(pendingBRef.current ?? stableBRef.current);
        if (delta < 0 && current <= 0) return;
        const next = clampLife(current + delta);
        pendingBRef.current = next;
        setPendingB(next);
      }
      queuePersist(target);
    },
    [blocked, queuePersist]
  );

  const onUndo = async () => {
    clearPendingAdjustments();
    if (historyRef.current.length < 2 || !pairing) return;
    const nextHistory = [...historyRef.current];
    nextHistory.pop();
    const prev = nextHistory[nextHistory.length - 1];
    if (!prev) return;
    historyRef.current = nextHistory;
    if (prev.a !== stableARef.current) {
      await persistLife('a', prev.a);
    }
    if (prev.b !== stableBRef.current) {
      await persistLife('b', prev.b);
    }
  };

  const onSurrender = (target: 'a' | 'b') => {
    if (!pairing) return;
    const winner =
      target === 'a' ? pairing.participant_b_id : pairing.participant_a_id;
    Alert.alert('Rendición', '¿Rendirte?', [
      { text: 'Cancelar', style: 'cancel', onPress: () => clearPendingAdjustments() },
      {
        text: 'Sí, me rindo',
        style: 'destructive',
        onPress: async () => {
          const eventBeforeRes = await supabase
            .from('draft_events')
            .select('status')
            .eq('id', pairing.event_id)
            .maybeSingle();
          const previousEventStatus = eventBeforeRes.data?.status;
          const { error } = await supabase
            .from('matches')
            .update({
              winner_participant_id: winner,
              ended_at: new Date().toISOString(),
              ended_by_surrender: true,
              status: 'completed',
            })
            .eq('id', matchId);
          if (error) {
            Alert.alert('Error', error.message ?? 'No se pudo cerrar la partida.');
            return;
          }
          if (pairing) {
            void navigateAfterMatchMaybeComplete(
              navigation,
              pairing.event_id,
              matchId,
              previousEventStatus
            );
          } else {
            navigation.replace('MatchResult', { matchId });
          }
        },
      },
    ]);
  };

  const takeControl = async () => {
    const uid = myUserIdRef.current;
    if (!uid) return;
    const { error } = await supabase
      .from('matches')
      .update({ life_tracker_user_id: uid })
      .eq('id', matchId);
    if (error) {
      Alert.alert('Error', error.message ?? 'No se pudo tomar control.');
      return;
    }
    setBlocked(false);
  };

  const chooseStarter = useCallback(
    async (participantId: string) => {
      if (savingStarter) return;
      if (!match) return;
      setSavingStarter(true);
      const { error } = await supabase
        .from('matches')
        .update({ who_started_participant_id: participantId })
        .eq('id', match.id);
      setSavingStarter(false);
      if (error) {
        Alert.alert('Error', error.message ?? 'No se pudo guardar quién empieza.');
        return;
      }
      setWhoStartedParticipantId(participantId);
      setMatch((prev) => (prev ? { ...prev, who_started_participant_id: participantId } : prev));
      if (turnTrackingEnabled) {
        const a = clampLife(pendingARef.current ?? stableARef.current);
        const b = clampLife(pendingBRef.current ?? stableBRef.current);
        setCurrentTurnParticipantId(participantId);
        setTurnStartLifeA(a);
        setTurnStartLifeB(b);
        setTurnStartedAt(new Date().toISOString());
      }
    },
    [match, savingStarter, turnTrackingEnabled]
  );

  const passTurn = useCallback(async () => {
    if (!pairing || !match || !pa || !pb || passingTurn) return;
    if (!currentTurnParticipantId || !turnStartedAt) return;
    const uid = myUserIdRef.current;
    if (!uid) return;

    const attackerPid = currentTurnParticipantId;
    const isAttackerA = attackerPid === pairing.participant_a_id;
    const attackerUserId = isAttackerA ? pa.user_id : pb.user_id;
    const attackerSide: 'a' | 'b' = isAttackerA ? 'a' : 'b';
    const attackerParticipant = isAttackerA ? pa : pb;

    const lifeA = clampLife(aLife);
    const lifeB = clampLife(bLife);
    const atkLife = isAttackerA ? lifeA : lifeB;
    const defLife = isAttackerA ? lifeB : lifeA;
    const turnStartAtk = isAttackerA ? turnStartLifeA : turnStartLifeB;
    const turnStartDef = isAttackerA ? turnStartLifeB : turnStartLifeA;
    const myDelta = atkLife - turnStartAtk;
    const otherDelta = defLife - turnStartDef;
    const move_category = categorizeMove(myDelta, otherDelta);
    const pokemonName = getPokemonNameFromAvatar(attackerParticipant);
    const defenderParticipant = isAttackerA ? pb : pa;
    const defenderPokemonName = getPokemonNameFromAvatar(defenderParticipant);
    const attackerSpecial = getSpecialBehavior(pokemonName);

    let move;
    if (attackerSpecial === 'ditto') {
      move = pickMove(defenderPokemonName, move_category, otherDelta);
    } else if (attackerSpecial === 'metronome') {
      move = pickRandomMoveFromAll();
    } else {
      move = pickMove(pokemonName, move_category, otherDelta);
    }

    const nextNum = lastTurnNumber + 1;
    setPassingTurn(true);

    if (attackerSpecial === 'ditto') {
      const { count, error: dittoCountErr } = await supabase
        .from('match_turns')
        .select('id', { count: 'exact', head: true })
        .eq('match_id', match.id)
        .eq('attacker_user_id', attackerUserId);
      if (dittoCountErr && __DEV__) {
        console.error('match_turns ditto count:', dittoCountErr);
      }
      const isFirstDittoTurn = (count ?? 0) === 0;
      if (isFirstDittoTurn) {
        setAttackingFrom(attackerSide);
        setSpecialType('ditto');
        setSpecialEmoji('🌀');
        specialPreAnim.setValue(0);
        await new Promise<void>((resolve) => {
          Animated.timing(specialPreAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }).start(() => resolve());
        });
        setSpecialEmoji(null);
        setSpecialType(null);
        specialPreAnim.setValue(0);
      }
    } else if (attackerSpecial === 'metronome') {
      setAttackingFrom(attackerSide);
      setSpecialType('metronome');
      setSpecialEmoji('☝️');
      specialPreAnim.setValue(0);
      await new Promise<void>((resolve) => {
        Animated.timing(specialPreAnim, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }).start(() => resolve());
      });
      setSpecialEmoji(null);
      setSpecialType(null);
      specialPreAnim.setValue(0);
    }

    attackTravel.setValue(0);
    defenderShake.setValue(0);
    attackerShake.setValue(0);
    attackSelfOpacity.setValue(1);
    surroundFade.setValue(0);
    circularProgress.setValue(0);
    setSurroundPayload(null);
    setCircularPayload(null);
    setAttackingFrom(attackerSide);
    setAttackMoveTarget(move.target);
    setAttackEmoji(move.emoji);

    const effectivePattern = getEffectiveAttackPattern(move);
    const strikeCount = move.count ?? 1;

    const defenderShakeSteps = [
      Animated.timing(defenderShake, { toValue: 10, duration: 80, useNativeDriver: true }),
      Animated.timing(defenderShake, { toValue: -10, duration: 80, useNativeDriver: true }),
      Animated.timing(defenderShake, { toValue: 8, duration: 80, useNativeDriver: true }),
      Animated.timing(defenderShake, { toValue: -8, duration: 80, useNativeDriver: true }),
      Animated.timing(defenderShake, { toValue: 0, duration: 80, useNativeDriver: true }),
    ];

    const runDefenderShakeOnly = () =>
      new Promise<void>((resolve) => {
        Animated.sequence(defenderShakeSteps).start(() => resolve());
      });

    const runAttackerSoftShakeOnly = () =>
      new Promise<void>((resolve) => {
        Animated.sequence([
          Animated.timing(attackerShake, { toValue: -5, duration: 80, useNativeDriver: true }),
          Animated.timing(attackerShake, { toValue: 5, duration: 80, useNativeDriver: true }),
          Animated.timing(attackerShake, { toValue: -3, duration: 80, useNativeDriver: true }),
          Animated.timing(attackerShake, { toValue: 3, duration: 80, useNativeDriver: true }),
          Animated.timing(attackerShake, { toValue: 0, duration: 80, useNativeDriver: true }),
        ]).start(() => resolve());
      });

    const runTravelEnemy = () =>
      new Promise<void>((resolve) => {
        Animated.timing(attackTravel, { toValue: 1, duration: 800, useNativeDriver: true }).start(() =>
          resolve()
        );
      });

    const runTravelAbsorb = () =>
      new Promise<void>((resolve) => {
        Animated.timing(attackTravel, { toValue: 1, duration: 800, useNativeDriver: true }).start(() =>
          resolve()
        );
      });

    if (effectivePattern === 'sequential' && strikeCount > 1 && move.target === 'enemy') {
      const seq = buildSequentialEmojis(move);
      for (let i = 0; i < seq.length; i += 1) {
        attackTravel.setValue(0);
        setAttackEmoji(seq[i]!);
        await flushLayout();
        await runTravelEnemy();
        if (i < seq.length - 1) {
          await new Promise<void>((r) => setTimeout(r, 120));
        }
      }
      await runDefenderShakeOnly();
    } else if (
      effectivePattern === 'surround' &&
      (move.target === 'enemy' || move.target === 'absorb')
    ) {
      const defenderSlot: 'a' | 'b' = isAttackerA ? 'b' : 'a';
      updateAvatarYInScrollContent('a');
      updateAvatarYInScrollContent('b');
      await flushLayout();
      const defWrap = defenderSlot === 'a' ? avatarWrapMeasureRefA.current : avatarWrapMeasureRefB.current;
      const center = await measureAvatarCenterInScroll(defWrap, scrollContentLayoutRef.current);
      setAttackEmoji(null);
      await runDefenderShakeOnly();
      const offsets = computeSurroundPositions(strikeCount, 50);
      if (offsets.length > 0) {
        surroundFade.setValue(0);
        setSurroundPayload({
          cx: center.cx,
          cy: center.cy,
          items: offsets.map((o) => ({ x: o.x, y: o.y, emoji: move.emoji })),
        });
        await new Promise<void>((resolve) => {
          Animated.sequence([
            Animated.timing(surroundFade, { toValue: 1, duration: 200, useNativeDriver: true }),
            Animated.delay(600),
            Animated.timing(surroundFade, { toValue: 0, duration: 200, useNativeDriver: true }),
          ]).start(() => resolve());
        });
        setSurroundPayload(null);
        surroundFade.setValue(0);
      }
      if (move.target === 'absorb') {
        attackTravel.setValue(0);
        setAttackEmoji(move.emoji);
        await flushLayout();
        await runTravelAbsorb();
      }
    } else if (effectivePattern === 'circular') {
      const anchorSlot: 'a' | 'b' = move.target === 'self' ? attackerSide : isAttackerA ? 'b' : 'a';
      updateAvatarYInScrollContent('a');
      updateAvatarYInScrollContent('b');
      await flushLayout();
      const anchorWrap = anchorSlot === 'a' ? avatarWrapMeasureRefA.current : avatarWrapMeasureRefB.current;
      const center = await measureAvatarCenterInScroll(anchorWrap, scrollContentLayoutRef.current);
      setAttackEmoji(null);
      setCircularPayload({ cx: center.cx, cy: center.cy, emoji: move.emoji });
      circularProgress.setValue(0);
      await new Promise<void>((resolve) => {
        Animated.timing(circularProgress, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }).start(() => resolve());
      });
      setCircularPayload(null);
      circularProgress.setValue(0);
      if (move.target === 'enemy') {
        await runDefenderShakeOnly();
      } else {
        await runAttackerSoftShakeOnly();
      }
    } else if (move.target === 'enemy') {
      await new Promise<void>((resolve) => {
        Animated.timing(attackTravel, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }).start(() => {
          Animated.sequence(defenderShakeSteps).start(() => resolve());
        });
      });
    } else if (move.target === 'self') {
      attackSelfOpacity.setValue(0);
      await new Promise<void>((resolve) => {
        Animated.sequence([
          Animated.timing(attackSelfOpacity, { toValue: 1, duration: 100, useNativeDriver: true }),
          Animated.sequence([
            Animated.timing(attackerShake, { toValue: -5, duration: 80, useNativeDriver: true }),
            Animated.timing(attackerShake, { toValue: 5, duration: 80, useNativeDriver: true }),
            Animated.timing(attackerShake, { toValue: -3, duration: 80, useNativeDriver: true }),
            Animated.timing(attackerShake, { toValue: 3, duration: 80, useNativeDriver: true }),
            Animated.timing(attackerShake, { toValue: 0, duration: 80, useNativeDriver: true }),
          ]),
          Animated.timing(attackSelfOpacity, { toValue: 0, duration: 100, useNativeDriver: true }),
        ]).start(() => resolve());
      });
    } else {
      await new Promise<void>((resolve) => {
        Animated.sequence([
          Animated.sequence(defenderShakeSteps),
          Animated.timing(attackTravel, { toValue: 1, duration: 800, useNativeDriver: true }),
        ]).start(() => resolve());
      });
    }

    const { error } = await supabase.from('match_turns').insert({
      match_id: match.id,
      turn_number: nextNum,
      attacker_user_id: attackerUserId,
      attacker_participant_id: attackerPid,
      life_a_before: turnStartLifeA,
      life_b_before: turnStartLifeB,
      life_a_after: lifeA,
      life_b_after: lifeB,
      move_category,
      started_at: turnStartedAt,
      ended_at: new Date().toISOString(),
    });

    setAttackingFrom(null);
    setAttackEmoji(null);
    setAttackMoveTarget(null);
    setSurroundPayload(null);
    setCircularPayload(null);
    setSpecialEmoji(null);
    setSpecialType(null);
    attackTravel.setValue(0);
    defenderShake.setValue(0);
    attackerShake.setValue(0);
    attackSelfOpacity.setValue(1);
    specialPreAnim.setValue(0);
    surroundFade.setValue(0);
    circularProgress.setValue(0);
    setPassingTurn(false);

    if (error) {
      Alert.alert('Error', error.message ?? 'No se pudo pasar el turno.');
      return;
    }

    setLifeDisplayedA(clampLife(lifeA));
    setLifeDisplayedB(clampLife(lifeB));

    const otherPid =
      attackerPid === pairing.participant_a_id ? pairing.participant_b_id : pairing.participant_a_id;
    setLastTurnNumber(nextNum);
    setCurrentTurnParticipantId(otherPid);
    setTurnStartLifeA(lifeA);
    setTurnStartLifeB(lifeB);
    setTurnStartedAt(new Date().toISOString());
  }, [
    aLife,
    bLife,
    currentTurnParticipantId,
    lastTurnNumber,
    match,
    pairing,
    pa,
    pb,
    passingTurn,
    turnStartLifeA,
    turnStartLifeB,
    turnStartedAt,
    updateAvatarYInScrollContent,
  ]);

  const nameA = useMemo(() => {
    if (isGiantEvent && pa?.giant_name) return pa.giant_name;
    const u = relationOne(pa?.users);
    return u?.display_name || u?.username || 'Jugador A';
  }, [isGiantEvent, pa]);
  const nameB = useMemo(() => {
    if (isGiantEvent && pb?.giant_name) return pb.giant_name;
    const u = relationOne(pb?.users);
    return u?.display_name || u?.username || 'Jugador B';
  }, [isGiantEvent, pb]);
  const layoutAB = useMemo(() => {
    if (!pa || !pb) return { top: 'a' as const, bottom: 'b' as const };
    if (sessionUserId === pa.user_id || (isGiantEvent && pa.member_b_user_id != null && sessionUserId === pa.member_b_user_id)) return { top: 'b' as const, bottom: 'a' as const };
    if (sessionUserId === pb.user_id || (isGiantEvent && pb.member_b_user_id != null && sessionUserId === pb.member_b_user_id)) return { top: 'a' as const, bottom: 'b' as const };
    return { top: 'a' as const, bottom: 'b' as const };
  }, [sessionUserId, isGiantEvent, pa, pb]);
  const bgSeed = match?.id ?? pairing?.id ?? matchId;
  const { bgA: bgColorA, bgB: bgColorB } = useMemo(
    () => pickCoordinatedBgColors(colorsA, colorsB, bgSeed),
    [colorsA, colorsB, bgSeed]
  );
  const topPlayerColors = layoutAB.top === 'a' ? [bgColorA] : [bgColorB];
  const bottomPlayerColors = layoutAB.bottom === 'a' ? [bgColorA] : [bgColorB];
  const showTickerTopSeparator = isDarkTickerAdjacentColor(topPlayerColors);
  const showTickerBottomSeparator = isDarkTickerAdjacentColor(bottomPlayerColors);
  const canDecreaseA = aLife > 0;
  const canDecreaseB = bLife > 0;

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  if (concurrentBlockMessage) {
    return (
      <View style={styles.centered}>
        <Text style={styles.blockedText}>{concurrentBlockMessage}</Text>
        <TouchableOpacity
          style={[styles.linkBtn, styles.concurrentBackBtn]}
          onPress={() =>
            pairing
              ? navigation.navigate('PairingDetail', { pairingId: pairing.id, fromTab: pairingsFromTab })
              : navigation.goBack()
          }
        >
          <Text style={styles.linkTxt}>Volver</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!match || !pairing || !pa || !pb) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>No se encontró la partida.</Text>
      </View>
    );
  }

  if (blocked) {
    return (
      <View style={styles.centered}>
        <Text style={styles.blockedText}>Esta partida está siendo controlada desde otro celular.</Text>
        {isOrganizer ? (
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() =>
              Alert.alert('Tomar control', '¿Tomar control de la partida?', [
                { text: 'Cancelar', style: 'cancel', onPress: () => clearPendingAdjustments() },
                { text: 'Tomar control', onPress: () => void takeControl() },
              ])
            }
          >
            <Text style={styles.primaryTxt}>Tomar control de la partida</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={styles.linkBtn}
            onPress={() => navigation.navigate('PairingDetail', { pairingId: pairing.id, fromTab: pairingsFromTab })}
          >
            <Text style={styles.linkTxt}>Volver</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  const renderPlayerHalf = (
    slot: 'a' | 'b',
    rotated: boolean,
    deltaDisplay: number,
    diffOpacity: Animated.Value
  ) => {
    const isA = slot === 'a';
    const p = isA ? pa! : pb!;
    const name = isA ? nameA : nameB;
    const wins = isA ? winsA : winsB;
    const life = isA ? aLife : bLife;
    const lifeForHpBar = isA ? lifeDisplayedA : lifeDisplayedB;
    const canDec = isA ? canDecreaseA : canDecreaseB;
    const colors = isA ? colorsA : colorsB;
    const bgColor = isA ? bgColorA : bgColorB;
    const isDarkBg = bgColor === 'B';
    const t = isA ? ('a' as const) : ('b' as const);
    const startingLife = isA ? match?.starting_life_a ?? 20 : match?.starting_life_b ?? 20;
    const hpRatio =
      startingLife > 0 ? Math.max(0, Math.min(1, clampLife(lifeForHpBar) / startingLife)) : 0;
    const hpColor = hpRatio >= 0.5 ? '#16A34A' : hpRatio >= 0.25 ? '#EAB308' : '#DC2626';
    const passTurnBorder = colors.length > 1 ? COLOR_BG[colors[1]!] : '#6B7280';
    const isMyTurn =
      turnTrackingEnabled &&
      whoStartedParticipantId != null &&
      currentTurnParticipantId === p.id;
    const hasUnsettledLife =
      pendingA != null || pendingB != null || persistingA || persistingB;
    const passTurnDisabled = !isMyTurn || passingTurn || hasUnsettledLife;
    const isDefenderShake =
      turnTrackingEnabled &&
      attackingFrom != null &&
      attackMoveTarget != null &&
      attackMoveTarget !== 'self' &&
      ((attackingFrom === 'a' && slot === 'b') || (attackingFrom === 'b' && slot === 'a'));
    const isAttackerSoftShake =
      turnTrackingEnabled &&
      attackingFrom != null &&
      attackMoveTarget === 'self' &&
      ((attackingFrom === 'a' && slot === 'a') || (attackingFrom === 'b' && slot === 'b'));
    const diffColor =
      deltaDisplay > 0 ? '#16A34A' : deltaDisplay < 0 ? '#DC2626' : '#6B7280';
    const diffLabel =
      deltaDisplay > 0 ? `+${deltaDisplay}` : deltaDisplay < 0 ? String(deltaDisplay) : '\u00a0';
    const body = (
      <>
        <View style={[styles.topRow, turnTrackingEnabled && styles.topRowTurn]}>
          <View style={styles.bo3Wrap}>
            <View style={[styles.bo3Box, wins >= 1 && styles.bo3Filled]} />
            <View style={[styles.bo3Box, wins >= 2 && styles.bo3Filled]} />
          </View>
        </View>
        <View style={styles.lifeRow}>
          <View style={[styles.playerBlock, turnTrackingEnabled && styles.playerBlockTurn]}>
            {turnTrackingEnabled ? (
              <View style={styles.nameRowTurn}>
                {currentTurnParticipantId === p.id ? (
                  <Text style={[styles.turnArrow, isDarkBg && styles.turnArrowDark]}>▶</Text>
                ) : null}
                <Text style={[styles.playerNameAbove, isDarkBg && { color: '#fff' }]}>{name}</Text>
              </View>
            ) : null}
            <View
              ref={isA ? avatarWrapMeasureRefA : avatarWrapMeasureRefB}
              onLayout={() => updateAvatarYInScrollContent(t)}
              style={[styles.avatarWrap, turnTrackingEnabled && styles.avatarWrapTurn]}
            >
              {isDefenderShake ? (
                <Animated.View style={{ transform: [{ translateX: defenderShake }] }}>
                  <View style={styles.avatarInner}>
                    {isGiantEvent ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                        <PlayerAvatar userId={p.user_id} participantId={p.id} size="large" withColorBorder borderWidth={4} giantSide="left" showShinyAnimation={t === 'a' ? showShinyAnimA : showShinyAnimB} />
                        {p.member_b_user_id ? <PlayerAvatar userId={p.member_b_user_id} participantId={p.id} isMemberB size="large" withColorBorder borderWidth={4} giantSide="right" memberColors={isA ? memberBColorsA : memberBColorsB} style={{ marginLeft: -12 }} /> : null}
                      </View>
                    ) : (
                      <PlayerAvatar userId={p.user_id} participantId={p.id} size="xlarge" withColorBorder borderWidth={5} showShinyAnimation={t === 'a' ? showShinyAnimA : showShinyAnimB} />
                    )}
                  </View>
                </Animated.View>
              ) : isAttackerSoftShake ? (
                <Animated.View style={{ transform: [{ translateX: attackerShake }] }}>
                  <View style={styles.avatarInner}>
                    {isGiantEvent ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                        <PlayerAvatar userId={p.user_id} participantId={p.id} size="large" withColorBorder borderWidth={4} giantSide="left" showShinyAnimation={t === 'a' ? showShinyAnimA : showShinyAnimB} />
                        {p.member_b_user_id ? <PlayerAvatar userId={p.member_b_user_id} participantId={p.id} isMemberB size="large" withColorBorder borderWidth={4} giantSide="right" memberColors={isA ? memberBColorsA : memberBColorsB} style={{ marginLeft: -12 }} /> : null}
                      </View>
                    ) : (
                      <PlayerAvatar userId={p.user_id} participantId={p.id} size="xlarge" withColorBorder borderWidth={5} showShinyAnimation={t === 'a' ? showShinyAnimA : showShinyAnimB} />
                    )}
                  </View>
                </Animated.View>
              ) : (
                <View style={styles.avatarInner}>
                  {isGiantEvent ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                      <PlayerAvatar userId={p.user_id} participantId={p.id} size="large" withColorBorder borderWidth={4} giantSide="left" showShinyAnimation={t === 'a' ? showShinyAnimA : showShinyAnimB} />
                      {p.member_b_user_id ? <PlayerAvatar userId={p.member_b_user_id} size="large" withColorBorder borderWidth={4} giantSide="right" memberColors={isA ? memberBColorsA : memberBColorsB} style={{ marginLeft: -12 }} /> : null}
                    </View>
                  ) : (
                    <PlayerAvatar userId={p.user_id} participantId={p.id} size="xlarge" withColorBorder borderWidth={5} showShinyAnimation={t === 'a' ? showShinyAnimA : showShinyAnimB} />
                  )}
                </View>
              )}
              {specialEmoji != null && specialType != null && attackingFrom === t ? (
                <Animated.View
                  pointerEvents="none"
                  style={[StyleSheet.absoluteFillObject, styles.specialPreLayer]}
                >
                  <Animated.View
                    style={[
                      styles.specialPreInner,
                      {
                        transform:
                          specialType === 'ditto'
                            ? [
                                {
                                  rotate: specialPreAnim.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: ['0deg', '360deg'],
                                  }),
                                },
                                {
                                  scale: specialPreAnim.interpolate({
                                    inputRange: [0, 0.5, 1],
                                    outputRange: [0.5, 1.5, 0],
                                  }),
                                },
                              ]
                            : [
                                {
                                  translateX: specialPreAnim.interpolate({
                                    inputRange: [0, 0.2, 0.4, 0.6, 0.8, 1],
                                    outputRange: [-10, 10, -10, 10, -10, 0],
                                  }),
                                },
                              ],
                      },
                    ]}
                  >
                    <Text
                      style={
                        specialType === 'ditto' ? styles.specialDittoEmoji : styles.specialMetronomeEmoji
                      }
                    >
                      {specialEmoji}
                    </Text>
                  </Animated.View>
                </Animated.View>
              ) : null}
            </View>
            {turnTrackingEnabled ? (
              <>
                <View style={styles.hpBarRow}>
                  <Text style={[styles.hpBarLabel, isDarkBg && styles.hpBarLabelDark]}>HP</Text>
                  <View style={styles.hpBarTrack}>
                    <View
                      style={[
                        styles.hpBarFill,
                        { width: `${hpRatio * 100}%`, backgroundColor: hpColor },
                      ]}
                    />
                  </View>
                </View>
                <TouchableOpacity
                  style={[
                    styles.passTurnBtn,
                    { borderColor: passTurnBorder },
                    passTurnDisabled && styles.passTurnBtnDisabled,
                  ]}
                  activeOpacity={0.85}
                  disabled={passTurnDisabled}
                  onPress={() => void passTurn()}
                >
                  <Text style={styles.passTurnBtnTxt}>Pasar turno</Text>
                </TouchableOpacity>
              </>
            ) : (
              <Text style={[styles.playerName, isDarkBg && { color: '#fff' }]}>{name}</Text>
            )}
          </View>
          <View style={styles.lifeControlsVertical}>
            <TouchableOpacity
              style={[styles.lifeBtn, isDarkBg && { borderWidth: 1, borderColor: '#fff' }]}
              onPress={() => adjustLife(t, 1)}
            >
              <Text style={styles.lifeBtnTxt}>+1</Text>
            </TouchableOpacity>
            <View style={styles.lifeCenter}>
              <Animated.View style={[styles.lifeDiffWrap, { opacity: diffOpacity }]}>
                <Text style={[styles.lifeDiff, { color: diffColor }]}>{diffLabel}</Text>
              </Animated.View>
              <Text style={[styles.lifeNumber, isDarkBg && { color: '#fff' }]}>{clampLife(life)}</Text>
            </View>
            <TouchableOpacity
              style={[
                styles.lifeBtn,
                isDarkBg && { borderWidth: 1, borderColor: '#fff' },
                !canDec && styles.lifeBtnDisabled,
              ]}
              disabled={!canDec}
              onPress={() => adjustLife(t, -1)}
            >
              <Text style={styles.lifeBtnTxt}>-1</Text>
            </TouchableOpacity>
          </View>
        </View>
        <View style={styles.pendingReserveSlot} pointerEvents="none" />
      </>
    );
    return (
      <View
        style={[
          styles.half,
          turnTrackingEnabled && styles.halfTurnTrack,
          { backgroundColor: COLOR_BG[bgColor] },
        ]}
      >
        {rotated ? <View style={styles.rotated}>{body}</View> : body}
        <TouchableOpacity
          style={[
            styles.flagBtn,
            rotated ? styles.flagBtnTowardEquatorTop : styles.flagBtnTowardEquatorBottom,
            turnTrackingEnabled
              ? rotated
                ? styles.flagBtnTowardEquatorTopTurn
                : styles.flagBtnTowardEquatorBottomTurn
              : null,
            rotated ? styles.flagBtnAvatarSideRotated : styles.flagBtnAvatarSideNormal,
          ]}
          onPress={() => onSurrender(t)}
        >
          <Text style={styles.flag}>🏳️</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const showStarterModal =
    turnTrackingEnabled &&
    whoStartedParticipantId == null &&
    !!pa &&
    !!pb &&
    match?.status === 'in_progress';

  const ayFly = avatarPositionA.current;
  const byFly = avatarPositionB.current;
  const attackFlyMeasured = ayFly > 2 || byFly > 2;
  let attackFlyOutputRange: [number, number] | null = null;
  if (attackEmoji && attackingFrom && attackMoveTarget) {
    if (attackMoveTarget === 'self') {
      attackFlyOutputRange = attackFlyMeasured
        ? attackingFrom === 'a'
          ? [ayFly, ayFly]
          : [byFly, byFly]
        : [80, 80];
    } else if (attackMoveTarget === 'absorb') {
      attackFlyOutputRange = attackFlyMeasured
        ? attackingFrom === 'a'
          ? [byFly, ayFly]
          : [ayFly, byFly]
        : attackingFrom === 'a'
          ? [400, 80]
          : [80, 400];
    } else {
      attackFlyOutputRange = attackFlyMeasured
        ? attackingFrom === 'a'
          ? [ayFly, byFly]
          : [byFly, ayFly]
        : attackingFrom === 'a'
          ? [80, 400]
          : [400, 80];
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
        <View ref={scrollContentLayoutRef} style={styles.scrollInner} collapsable={false}>
          {renderPlayerHalf(
            layoutAB.top,
            true,
            layoutAB.top === 'a' ? deltaA : deltaB,
            layoutAB.top === 'a' ? diffOpacityA : diffOpacityB
          )}

          {showTickerTopSeparator ? <View style={styles.tickerZoneSeparator} /> : null}
          <View style={styles.undoWrap}>
            <View style={styles.undoTickerRow}>
              <NewsTickerStrip
                item={tickerPlay.current}
                leadingGap={tickerPlay.leadingGap}
                playbackKey={tickerPlay.playbackKey}
                onCycleComplete={onTickerCycleComplete}
              />
            </View>
            <View style={styles.undoBtnRow}>
              <TouchableOpacity
                style={[styles.undoBtn, !canUndo && styles.undoDisabled]}
                disabled={!canUndo}
                onPress={() => void onUndo()}
              >
                <Text style={styles.undoTxt}>Undo</Text>
              </TouchableOpacity>
            </View>
          </View>
          {showTickerBottomSeparator ? <View style={styles.tickerZoneSeparator} /> : null}

          {renderPlayerHalf(
            layoutAB.bottom,
            false,
            layoutAB.bottom === 'a' ? deltaA : deltaB,
            layoutAB.bottom === 'a' ? diffOpacityA : diffOpacityB
          )}
          {attackFlyOutputRange && attackEmoji ? (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.attackFlyWrap,
                {
                  opacity: attackSelfOpacity,
                  transform: [
                    {
                      translateY: attackTravel.interpolate({
                        inputRange: [0, 1],
                        outputRange: attackFlyOutputRange,
                      }),
                    },
                  ],
                },
              ]}
            >
              <Text style={styles.attackFlyEmoji}>{attackEmoji}</Text>
            </Animated.View>
          ) : null}
          {surroundPayload ? (
            <View
              pointerEvents="none"
              style={[
                styles.surroundAnchor,
                { left: surroundPayload.cx, top: surroundPayload.cy },
              ]}
            >
              <Animated.View style={{ opacity: surroundFade }}>
                {surroundPayload.items.map((it, idx) => (
                  <Text
                    key={`${it.emoji}-${idx}`}
                    style={[
                      styles.surroundEmoji,
                      { left: it.x - 28, top: it.y - 28 },
                    ]}
                  >
                    {it.emoji}
                  </Text>
                ))}
              </Animated.View>
            </View>
          ) : null}
          {circularPayload ? (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.circularWrap,
                {
                  left: circularPayload.cx - 28,
                  top: circularPayload.cy - 28,
                  transform: [{ translateX: circularTx }, { translateY: circularTy }],
                },
              ]}
            >
              <Text style={styles.attackFlyEmoji}>{circularPayload.emoji}</Text>
            </Animated.View>
          ) : null}
        </View>
      </ScrollView>
      {showStarterModal && pa && pb ? (
        <View style={styles.starterModalBackdrop}>
          <View style={styles.starterModalCard}>
            <Text style={styles.starterModalTitle}>¿Quién empieza?</Text>
            <TouchableOpacity
              style={[styles.starterOption, savingStarter && styles.starterOptionDisabled]}
              activeOpacity={0.8}
              disabled={savingStarter}
              onPress={() => void chooseStarter(pa.id)}
            >
              {isGiantEvent ? (
                <View style={{ flexDirection: 'row' }}>
                  <PlayerAvatar userId={pa.user_id} participantId={pa.id} size="small" withColorBorder borderWidth={3} giantSide="left" />
                  {pa.member_b_user_id ? <PlayerAvatar userId={pa.member_b_user_id} participantId={pa.id} isMemberB size="small" withColorBorder borderWidth={3} giantSide="right" memberColors={memberBColorsA} style={{ marginLeft: -8 }} /> : null}
                </View>
              ) : (
                <PlayerAvatar userId={pa.user_id} participantId={pa.id} size="small" withColorBorder borderWidth={3} />
              )}
              <Text style={styles.starterOptionName}>{nameA}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.starterOption, savingStarter && styles.starterOptionDisabled]}
              activeOpacity={0.8}
              disabled={savingStarter}
              onPress={() => void chooseStarter(pb.id)}
            >
              {isGiantEvent ? (
                <View style={{ flexDirection: 'row' }}>
                  <PlayerAvatar userId={pb.user_id} participantId={pb.id} size="small" withColorBorder borderWidth={3} giantSide="left" />
                  {pb.member_b_user_id ? <PlayerAvatar userId={pb.member_b_user_id} participantId={pb.id} isMemberB size="small" withColorBorder borderWidth={3} giantSide="right" memberColors={memberBColorsB} style={{ marginLeft: -8 }} /> : null}
                </View>
              ) : (
                <PlayerAvatar userId={pb.user_id} participantId={pb.id} size="small" withColorBorder borderWidth={3} />
              )}
              <Text style={styles.starterOptionName}>{nameB}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  scroll: { flexGrow: 1 },
  scrollInner: { flexGrow: 1, position: 'relative' },
  attackFlyWrap: {
    position: 'absolute',
    left: '50%',
    marginLeft: -28,
    top: 0,
    zIndex: 40,
  },
  surroundAnchor: {
    position: 'absolute',
    zIndex: 40,
    width: 0,
    height: 0,
  },
  surroundEmoji: {
    position: 'absolute',
    fontSize: 56,
  },
  circularWrap: {
    position: 'absolute',
    zIndex: 40,
  },
  attackFlyEmoji: { fontSize: 56 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#fff' },
  muted: { color: '#666' },
  blockedText: { color: '#111', fontSize: 16, textAlign: 'center', marginBottom: 14 },
  primaryBtn: { backgroundColor: '#3B82F6', borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16 },
  primaryTxt: { color: '#fff', fontWeight: '700' },
  linkBtn: { marginTop: 6 },
  concurrentBackBtn: { marginTop: 18 },
  linkTxt: { color: '#3B82F6', fontWeight: '700' },
  half: { flex: 1, minHeight: 272, padding: 16, justifyContent: 'center', position: 'relative' },
  halfTurnTrack: { paddingVertical: 10, paddingHorizontal: 12 },
  rotated: { transform: [{ rotate: '180deg' }] },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  topRowTurn: { marginBottom: 12 },
  bo3Wrap: { flexDirection: 'row', transform: [{ translateY: 12 }] },
  bo3Box: { width: 24, height: 10, borderRadius: 3, borderWidth: 1, borderColor: '#9CA3AF', marginRight: 6 },
  bo3Filled: { backgroundColor: '#22C55E', borderColor: '#22C55E' },
  flag: { fontSize: 18 },
  lifeBtn: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#111827', alignItems: 'center', justifyContent: 'center' },
  lifeBtnDisabled: { opacity: 0.4 },
  lifeBtnTxt: { color: '#fff', fontSize: 24, fontWeight: '700' },
  lifeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  playerBlock: { width: '50%', alignItems: 'center', justifyContent: 'center' },
  playerBlockTurn: { justifyContent: 'flex-start', paddingVertical: 0 },
  avatarWrap: {
    width: '96%',
    maxWidth: 220,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  avatarWrapTurn: {
    marginTop: 0,
    marginBottom: 0,
    width: 'auto',
    aspectRatio: undefined,
    maxWidth: undefined,
    alignSelf: 'center',
  },
  flagBtnTowardEquatorTopTurn: { bottom: 4 },
  flagBtnTowardEquatorBottomTurn: { top: 4 },
  avatarInner: { alignItems: 'center', justifyContent: 'center' },
  specialPreLayer: { zIndex: 15, justifyContent: 'center', alignItems: 'center' },
  specialPreInner: { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center' },
  specialDittoEmoji: { fontSize: 56 },
  specialMetronomeEmoji: { fontSize: 48 },
  flagBtn: {
    position: 'absolute',
    backgroundColor: '#00000030',
    borderRadius: 14,
    paddingHorizontal: 6,
    paddingVertical: 4,
    zIndex: 2,
  },
  /** Mitad superior (rotada): borde inferior hacia el ecuador / barra Undo. */
  flagBtnTowardEquatorTop: { bottom: 12 },
  /** Mitad inferior: borde superior hacia el ecuador. */
  flagBtnTowardEquatorBottom: { top: 12 },
  /** Contenido rotado 180°: el bloque del avatar queda a la derecha; misma orientación que antes. */
  flagBtnAvatarSideRotated: { right: 22 },
  flagBtnAvatarSideNormal: { left: 22 },
  playerName: { marginTop: 10, fontSize: 24, color: '#111', fontWeight: '700', textAlign: 'center' },
  nameRowTurn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 0,
    marginBottom: 0,
    flexWrap: 'wrap',
  },
  turnArrow: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111',
    marginRight: 4,
  },
  turnArrowDark: { color: '#fff' },
  playerNameAbove: {
    marginBottom: 0,
    fontSize: 24,
    color: '#111',
    fontWeight: '700',
    textAlign: 'center',
  },
  hpBarRow: {
    marginTop: 0,
    flexDirection: 'row',
    alignItems: 'center',
    width: 130,
    alignSelf: 'center',
    position: 'relative',
  },
  hpBarLabel: {
    position: 'absolute',
    right: '100%',
    marginRight: 6,
    fontSize: 10,
    fontWeight: '700',
    color: '#111',
  },
  hpBarLabelDark: { color: '#fff' },
  hpBarTrack: {
    width: 130,
    backgroundColor: '#1F2937',
    padding: 2,
    borderRadius: 4,
  },
  hpBarFill: {
    height: 8,
    borderRadius: 2,
  },
  passTurnBtn: {
    marginTop: 10,
    paddingVertical: 18,
    paddingHorizontal: 36,
    borderRadius: 10,
    borderWidth: 2,
    backgroundColor: '#FFFFFF',
    alignSelf: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  passTurnBtnDisabled: { opacity: 0.4 },
  passTurnBtnTxt: {
    color: '#111',
    fontWeight: '700',
    fontSize: 18,
    textAlign: 'center',
  },
  starterModalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#00000099',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    zIndex: 100,
  },
  starterModalCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 360,
    alignItems: 'center',
  },
  starterModalTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#111',
    marginBottom: 18,
    textAlign: 'center',
  },
  starterOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#F9FAFB',
    width: '100%',
    marginBottom: 10,
  },
  starterOptionDisabled: { opacity: 0.5 },
  starterOptionName: { fontSize: 18, fontWeight: '700', color: '#111', flex: 1 },
  lifeControlsVertical: { width: '50%', alignItems: 'center', justifyContent: 'space-between' },
  lifeCenter: { alignItems: 'center', flex: 1 },
  lifeDiffWrap: { minHeight: 48, justifyContent: 'flex-end', marginBottom: 2 },
  lifeDiff: { fontSize: 44, fontWeight: '800', lineHeight: 48 },
  lifeNumber: { fontSize: 72, color: '#111', fontWeight: '800', lineHeight: 80 },
  pendingReserveSlot: { marginTop: 6, height: 16 },
  tickerZoneSeparator: { width: '100%', height: 1, backgroundColor: '#E5E7EB' },
  undoWrap: { width: '100%', backgroundColor: '#fff' },
  undoTickerRow: { width: '100%', height: 26, justifyContent: 'center' },
  undoBtnRow: { alignItems: 'center', paddingVertical: 6 },
  undoBtn: {
    borderWidth: 1,
    borderColor: '#BFDBFE',
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 13,
  },
  undoDisabled: { opacity: 0.5 },
  undoTxt: { color: '#3B82F6', fontWeight: '700' },
});

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  Alert,
  Animated,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ActivityIndicator,
} from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { supabase } from '../lib/supabase';
import {
  DEFAULT_TIMER_PARAMS,
  computePickTimeline,
  type PickInfo,
} from '../lib/draftTimer';
import {
  saveTimerSession,
  getTimerSession,
  clearTimerSession,
} from '../lib/draftTimerStore';
import { generateEventPairings } from '../lib/generateEventPairings';

type Props = NativeStackScreenProps<MainStackParamList, 'DraftTimer'>;
type Phase = 'loading' | 'waiting' | 'counting' | 'done';

// Card dimensions
const CARD_W = 12;
const CARD_H = 18;
const CARD_GAP = 3;
const CARD_RADIUS = 2;
const CARD_EMPTY = '#E5E7EB';

const ACCENT_COLORS: Record<string, string> = {
  blue:   '#3B82F6',
  green:  '#10B981',
  orange: '#F97316',
  red:    '#EF4444',
  purple: '#8B5CF6',
  black:  '#1F2937',
};

function PackPanel({
  packs,
  currentPackIdx,
  completedInCurrentPack,
  accentColor,
}: {
  packs: number[];
  currentPackIdx: number;
  completedInCurrentPack: number;
  accentColor: string;
}) {
  return (
    <View style={panelStyles.container}>
      {packs.map((packSize, s) => {
        const isActive = s === currentPackIdx;
        const isDone = s < currentPackIdx;
        const completedCount = isDone ? packSize : isActive ? completedInCurrentPack : 0;

        return (
          <View
            key={s}
            style={[
              panelStyles.packRow,
              isActive && [panelStyles.packRowActive, { borderColor: accentColor }],
              isDone && panelStyles.packRowDone,
            ]}
          >
            <View style={panelStyles.packMeta}>
              <Text style={[panelStyles.packLabel, isDone && panelStyles.packLabelDone]}>
                {isDone ? '✓' : `S${s + 1}`}
              </Text>
              <Text style={[panelStyles.packCount, isDone && panelStyles.packCountDone]}>
                {completedCount}/{packSize}
              </Text>
            </View>
            <View style={panelStyles.cardsWrap}>
              {Array.from({ length: packSize }, (_, i) => {
                const filled = i < completedCount;
                return (
                  <View
                    key={i}
                    style={[
                      panelStyles.card,
                      filled
                        ? isDone
                          ? panelStyles.cardDone
                          : { backgroundColor: accentColor }
                        : panelStyles.cardEmpty,
                    ]}
                  />
                );
              })}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const panelStyles = StyleSheet.create({
  container: { gap: 6 },
  packRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    padding: 8,
    backgroundColor: '#FAFAFA',
    opacity: 0.5,
  },
  packRowActive: {
    borderColor: '#3B82F6',
    borderWidth: 2,
    backgroundColor: '#EFF6FF',
    opacity: 1,
  },
  packRowDone: {
    borderColor: '#D1D5DB',
    backgroundColor: '#F3F4F6',
    opacity: 0.7,
  },
  packMeta: { width: 36, alignItems: 'center', paddingTop: 2 },
  packLabel: { fontSize: 12, fontWeight: '700', color: '#374151' },
  packLabelDone: { color: '#059669' },
  packCount: { fontSize: 10, color: '#9CA3AF', marginTop: 2 },
  packCountDone: { color: '#6B7280' },
  cardsWrap: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: CARD_GAP },
  card: {
    width: CARD_W,
    height: CARD_H,
    borderRadius: CARD_RADIUS,
  },
  cardFilled: { backgroundColor: '#C8A96E' },
  cardDone: { backgroundColor: '#9CA3AF' },
  cardEmpty: { backgroundColor: CARD_EMPTY, borderWidth: 1, borderColor: '#D1D5DB' },
});

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 300) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s > 0 ? `${m}min ${s}s` : `${m}min`;
  }
  if (sec < 3600) return `${Math.floor(sec / 60)}min`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

export default function DraftTimerScreen({ route, navigation }: Props) {
  useKeepAwake();
  const { eventId } = route.params;

  const [phase, setPhase] = useState<Phase>('loading');
  const [timeline, setTimeline] = useState<PickInfo[]>([]);
  const [packs, setPacks] = useState<number[]>([]);
  const [pickIdx, setPickIdx] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [paused, setPaused] = useState(false);
  const [draftStartedAt, setDraftStartedAt] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [timerColor, setTimerColor] = useState('blue');

  const pausedRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStartRef = useRef(false);
  const flashAnim = useRef(new Animated.Value(0)).current;
  const roundStartRef = useRef<number | null>(null);
  const unloggedPickRef = useRef<number | null>(null);

  // Keep a ref with latest state for blur-save (avoids stale closure in useFocusEffect)
  const stateRef = useRef({ phase, pickIdx, secondsLeft, paused });
  useEffect(() => {
    stateRef.current = { phase, pickIdx, secondsLeft, paused };
  }, [phase, pickIdx, secondsLeft, paused]);

  useEffect(() => {
    void (async () => {
      const [eventRes, playersRes] = await Promise.all([
        supabase
          .from('draft_events')
          .select('draft_started_at, timer_color, timer_packs, timer_alpha, timer_beta, timer_gamma, timer_delta, timer_rho, timer_tmin, timer_tmax')
          .eq('id', eventId)
          .maybeSingle(),
        supabase
          .from('event_participants')
          .select('id', { count: 'exact', head: true })
          .eq('event_id', eventId)
          .eq('role', 'player'),
      ]);

      if (eventRes.error || !eventRes.data) {
        Alert.alert('Error', 'No se pudo cargar el evento.');
        navigation.goBack();
        return;
      }

      const row = eventRes.data as any;
      setDraftStartedAt(row.draft_started_at ?? null);
      setTimerColor(row.timer_color ?? 'blue');

      const timerPacks: number[] = Array.isArray(row.timer_packs) ? row.timer_packs : [15, 15, 15];
      const numPlayers = Math.max(playersRes.count ?? 1, 1);
      const params = {
        alpha: row.timer_alpha ?? DEFAULT_TIMER_PARAMS.alpha,
        beta:  row.timer_beta  ?? DEFAULT_TIMER_PARAMS.beta,
        gamma: row.timer_gamma ?? DEFAULT_TIMER_PARAMS.gamma,
        delta: row.timer_delta ?? DEFAULT_TIMER_PARAMS.delta,
        rho:   row.timer_rho   ?? DEFAULT_TIMER_PARAMS.rho,
        tMin:  row.timer_tmin  ?? DEFAULT_TIMER_PARAMS.tMin,
        tMax:  row.timer_tmax  ?? DEFAULT_TIMER_PARAMS.tMax,
      };
      const tl = computePickTimeline(timerPacks, numPlayers, params);
      setPacks(timerPacks);
      setTimeline(tl);

      const session = getTimerSession(eventId);
      if (session && session.pickIdx < tl.length) {
        let restoredSeconds = session.secondsLeft;
        if (session.phase === 'counting') {
          const elapsedSec = Math.floor((Date.now() - session.savedAt) / 1000);
          restoredSeconds = Math.max(0, session.secondsLeft - elapsedSec);
        }
        if (restoredSeconds <= 0 && session.phase === 'counting') {
          const nextIdx = session.pickIdx + 1;
          if (nextIdx >= tl.length) {
            setPhase('done');
          } else {
            setPickIdx(nextIdx);
            setSecondsLeft(tl[nextIdx]!.timeSeconds);
            setPhase('waiting');
          }
        } else {
          setPickIdx(session.pickIdx);
          setSecondsLeft(Math.max(restoredSeconds, 1));
          setPhase('waiting');
          if (session.phase === 'counting') {
            autoStartRef.current = true;
          }
        }
      } else {
        setPickIdx(0);
        setSecondsLeft(tl[0]?.timeSeconds ?? params.tMin);
        setPhase('waiting');
      }
    })();
  }, [eventId, navigation]);

  const stopInterval = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const flashRed = useCallback(() => {
    flashAnim.setValue(1);
    Animated.sequence([
      Animated.timing(flashAnim, { toValue: 0.7, duration: 120, useNativeDriver: true }),
      Animated.timing(flashAnim, { toValue: 1,   duration: 120, useNativeDriver: true }),
      Animated.timing(flashAnim, { toValue: 0.5, duration: 120, useNativeDriver: true }),
      Animated.timing(flashAnim, { toValue: 1,   duration: 120, useNativeDriver: true }),
      Animated.timing(flashAnim, { toValue: 0,   duration: 300, useNativeDriver: true }),
    ]).start();
  }, [flashAnim]);

  const advancePick = useCallback((nextIdx: number, tl: PickInfo[], _packsArr: number[]) => {
    if (nextIdx >= tl.length) {
      setPhase('done');
      return;
    }
    setPickIdx(nextIdx);
    setSecondsLeft(tl[nextIdx]!.timeSeconds);
    setPhase('waiting');
  }, []);

  const logPick = useCallback((tl: PickInfo[], idx: number, actualSec: number) => {
    const pick = tl[idx];
    if (!pick) return;
    const effectiveSec = pick.cardsPresent === 1 ? 0 : actualSec;
    console.log('[TimerLog]', { idx, global: pick.globalIndex + 1, pack: pick.packIndex, inPack: pick.pickInPack, estimated: pick.timeSeconds, actual: effectiveSec, eventId });
    void supabase.from('draft_timer_logs').insert({
      event_id: eventId,
      global_pick: pick.globalIndex + 1,
      pack_index: pick.packIndex,
      pick_in_pack: pick.pickInPack,
      estimated_seconds: pick.timeSeconds,
      actual_seconds: effectiveSec,
    }).then(({ error }) => {
      if (error) console.error('[TimerLog] insert error', error);
    });
  }, [eventId]);

  const startCountdown = useCallback((tl: PickInfo[], idx: number, packsArr: number[]) => {
    stopInterval();
    setPhase('counting');
    pausedRef.current = false;
    intervalRef.current = setInterval(() => {
      if (pausedRef.current) return;
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          stopInterval();
          flashRed();
          const isLast = idx + 1 >= tl.length;
          if (isLast) {
            const elapsed = roundStartRef.current !== null
              ? Math.round((Date.now() - roundStartRef.current) / 1000)
              : 0;
            logPick(tl, idx, elapsed);
            roundStartRef.current = null;
            unloggedPickRef.current = null;
          } else {
            // Mark as unlogged; roundStartRef stays set for next-iniciar timing.
            unloggedPickRef.current = idx;
          }
          setTimeout(() => advancePick(idx + 1, tl, packsArr), 600);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, [stopInterval, flashRed, advancePick, logPick]);

  useEffect(() => () => stopInterval(), [stopInterval]);

  // One-shot auto-start after restoring a 'counting' session
  useEffect(() => {
    if (phase !== 'waiting' || !autoStartRef.current) return;
    autoStartRef.current = false;
    startCountdown(timeline, pickIdx, packs);
  }, [phase, timeline, pickIdx, packs, startCountdown]);

  // Save state on blur so it can be restored if the user navigates back
  useFocusEffect(
    useCallback(() => {
      return () => {
        const { phase: p, pickIdx: pi, secondsLeft: sl, paused: pa } = stateRef.current;
        if (p !== 'done' && p !== 'loading') {
          saveTimerSession(eventId, {
            pickIdx: pi,
            secondsLeft: sl,
            phase: p === 'counting' && !pa ? 'counting' : 'waiting',
            savedAt: Date.now(),
          });
        } else {
          clearTimerSession(eventId);
        }
      };
    }, [eventId])
  );

  // Elapsed time counter (runs independently of the pick countdown)
  useEffect(() => {
    if (!draftStartedAt) return;
    const startMs = new Date(draftStartedAt).getTime();
    setElapsedSeconds(Math.floor((Date.now() - startMs) / 1000));
    const id = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startMs) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [draftStartedAt]);

  useEffect(() => {
    if (phase !== 'done') return;
    void (async () => {
      const toPlaying = await supabase
        .from('draft_events')
        .update({ draft_ended_at: new Date().toISOString(), status: 'playing' })
        .eq('id', eventId);
      if (toPlaying.error) {
        Alert.alert('Error', toPlaying.error.message ?? 'No se pudo marcar fin del draft.');
        navigation.goBack();
        return;
      }
      const gen = await generateEventPairings(eventId);
      if (!gen.ok) {
        await supabase
          .from('draft_events')
          .update({ status: 'drafting', draft_ended_at: null })
          .eq('id', eventId);
        Alert.alert('Error', gen.message);
      }
      navigation.goBack();
    })();
  }, [phase, eventId, navigation]);

  const handleBigBtn = () => {
    if (phase === 'waiting') {
      // Log the round that just ended and was waiting for this tap.
      if (unloggedPickRef.current !== null) {
        const elapsed = roundStartRef.current !== null
          ? Math.round((Date.now() - roundStartRef.current) / 1000)
          : 0;
        logPick(timeline, unloggedPickRef.current, elapsed);
        unloggedPickRef.current = null;
      }
      roundStartRef.current = Date.now();
      startCountdown(timeline, pickIdx, packs);
    } else if (phase === 'counting' && !paused) {
      pausedRef.current = true;
      setPaused(true);
    } else if (phase === 'counting' && paused) {
      pausedRef.current = false;
      setPaused(false);
    }
  };

  const handleSkipToNext = () => {
    if (phase === 'counting') {
      const isLast = pickIdx + 1 >= timeline.length;
      if (isLast) {
        const elapsed = roundStartRef.current !== null
          ? Math.round((Date.now() - roundStartRef.current) / 1000)
          : 0;
        logPick(timeline, pickIdx, elapsed);
        roundStartRef.current = null;
        unloggedPickRef.current = null;
      } else {
        // Not last: log will fire when next round's "iniciar" is pressed.
        unloggedPickRef.current = pickIdx;
      }
      stopInterval();
      setPaused(false);
      pausedRef.current = false;
      flashRed();
      setTimeout(() => advancePick(pickIdx + 1, timeline, packs), 300);
    } else if (phase === 'waiting') {
      const isLast = pickIdx + 1 >= timeline.length;
      if (isLast) {
        logPick(timeline, pickIdx, 0);
        roundStartRef.current = null;
        unloggedPickRef.current = null;
      } else {
        // Skipped without starting; elapsed = 0 when next iniciar fires.
        unloggedPickRef.current = pickIdx;
      }
      advancePick(pickIdx + 1, timeline, packs);
    }
  };

  const handleBack = () => {
    stopInterval();
    navigation.goBack();
  };

  if (phase === 'loading') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  const currentPick = timeline[pickIdx];
  const packIdx = currentPick?.packIndex ?? 0;
  const pickInPack = currentPick?.pickInPack ?? 1;
  const packSize = packs[packIdx] ?? 0;
  const cardsPresent = currentPick?.cardsPresent ?? packSize;
  const totalPicks = timeline.length;

  const completedInCurrentPack = phase === 'done' ? packSize : (pickInPack - 1);
  const displayPackIdx = phase === 'done' ? packs.length : packIdx;

  const accentColor = ACCENT_COLORS[timerColor] ?? '#3B82F6';

  const flashBg = flashAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['rgba(254,242,242,0)', 'rgba(239,68,68,0.35)'],
  });

  return (
    <Animated.View style={[styles.root, { backgroundColor: flashBg }]}>
      <View style={styles.topRow}>
        <TouchableOpacity onPress={handleBack} hitSlop={12}>
          <Text style={styles.backLink}>← Volver</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.titleBlock}>
        {draftStartedAt ? (
          <Text style={styles.elapsedTime}>{formatElapsed(elapsedSeconds)}</Text>
        ) : null}
        <Text style={styles.packTitle}>
          Ronda {pickInPack} — Sobre {packIdx + 1} ({cardsPresent} carta{cardsPresent !== 1 ? 's' : ''})
        </Text>
        <Text style={styles.globalPick}>Pick global {pickIdx + 1} / {totalPicks}</Text>
      </View>

      <TouchableOpacity
        style={[styles.bigBtn, { backgroundColor: accentColor }]}
        onPress={phase === 'done' ? () => navigation.goBack() : handleBigBtn}
        activeOpacity={0.8}
      >
        {phase === 'waiting' ? (
          <Text style={[styles.bigBtnTxt, styles.countdownTxt]}>{secondsLeft}s</Text>
        ) : phase === 'done' ? (
          <Text style={styles.bigBtnTxt}>Volver al evento</Text>
        ) : paused ? (
          <Text style={styles.bigBtnTxt}>Reanudar</Text>
        ) : (
          <Text style={[styles.bigBtnTxt, styles.countdownTxt]}>{secondsLeft}s</Text>
        )}
      </TouchableOpacity>

      {(phase === 'waiting' || phase === 'counting') ? (
        <TouchableOpacity style={styles.skipBtn} onPress={handleSkipToNext}>
          <Text style={styles.skipBtnTxt}>Siguiente ronda</Text>
        </TouchableOpacity>
      ) : null}

      <Text style={styles.progressCount}>{completedInCurrentPack}/{packSize}</Text>

      <ScrollView style={styles.panelScroll} showsVerticalScrollIndicator={false}>
        <PackPanel
          packs={packs}
          currentPackIdx={displayPackIdx}
          completedInCurrentPack={completedInCurrentPack}
          accentColor={accentColor}
        />
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 20, backgroundColor: '#fff' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff', padding: 24 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  backLink: { color: '#3B82F6', fontSize: 16, fontWeight: '600' },
  titleBlock: { alignItems: 'center', marginBottom: 20 },
  elapsedTime: { fontSize: 11, color: '#C0C8D8', marginBottom: 4 },
  packTitle: { fontSize: 22, fontWeight: '800', color: '#111', textAlign: 'center' },
  globalPick: { fontSize: 13, color: '#9CA3AF', marginTop: 4 },
  bigBtn: {
    alignSelf: 'center',
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: '#3B82F6',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 4,
  },
  bigBtnTxt: { color: '#fff', fontSize: 20, fontWeight: '800', textAlign: 'center' },
  countdownTxt: { fontSize: 48 },
  skipBtn: {
    alignSelf: 'center',
    backgroundColor: '#EFF6FF',
    borderWidth: 1.5,
    borderColor: '#BFDBFE',
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 32,
    marginBottom: 10,
  },
  skipBtnTxt: { color: '#1D4ED8', fontSize: 16, fontWeight: '700' },
  progressCount: { fontSize: 12, color: '#9CA3AF', textAlign: 'center', marginBottom: 10 },
  panelScroll: { flex: 1 },
});

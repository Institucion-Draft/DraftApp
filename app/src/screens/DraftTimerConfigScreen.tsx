import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { supabase } from '../lib/supabase';
import { computePickTimeline, DEFAULT_TIMER_PARAMS, type TimerParams } from '../lib/draftTimer';

type Props = NativeStackScreenProps<MainStackParamList, 'DraftTimerConfig'>;

export default function DraftTimerConfigScreen({ route, navigation }: Props) {
  const { mode, eventId, numPlayers: initPlayers, readOnly } = route.params;

  const [loading, setLoading] = useState(mode === 'event');
  const [numPacks, setNumPacks] = useState(3);
  const [equalCards, setEqualCards] = useState(true);
  const [cardsPerPack, setCardsPerPack] = useState(15);
  const [cardsPerPackArr, setCardsPerPackArr] = useState<number[]>([15, 15, 15]);
  const [cardsManuallySet, setCardsManuallySet] = useState(false);
  const [numPlayersForSim, setNumPlayersForSim] = useState(initPlayers ?? 8);
  const [eventTimerParams, setEventTimerParams] = useState<TimerParams>(DEFAULT_TIMER_PARAMS);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const savedPacksRef = useRef<number[] | null>(null);
  const firstFocusRef = useRef(true);

  useEffect(() => {
    if (mode !== 'event' || !eventId) return;
    void (async () => {
      const [eventRes, playersRes] = await Promise.all([
        supabase.from('draft_events').select('timer_packs, timer_alpha, timer_beta, timer_gamma, timer_delta, timer_rho, timer_tmin, timer_tmax').eq('id', eventId).maybeSingle(),
        supabase
          .from('event_participants')
          .select('id', { count: 'exact', head: true })
          .eq('event_id', eventId)
          .eq('role', 'player'),
      ]);
      if (eventRes.data) {
        const row = eventRes.data as any;
        const packs: number[] | null = Array.isArray(row.timer_packs) ? (row.timer_packs as number[]) : null;
        if (packs && packs.length > 0) {
          setNumPacks(packs.length);
          const allEqual = packs.every((p) => p === packs[0]);
          setEqualCards(allEqual);
          if (allEqual) setCardsPerPack(packs[0]!);
          setCardsPerPackArr(packs);
          setCardsManuallySet(true);
          savedPacksRef.current = packs;
        } else {
          savedPacksRef.current = [];
        }
        setEventTimerParams({
          alpha: row.timer_alpha ?? DEFAULT_TIMER_PARAMS.alpha,
          beta:  row.timer_beta  ?? DEFAULT_TIMER_PARAMS.beta,
          gamma: row.timer_gamma ?? DEFAULT_TIMER_PARAMS.gamma,
          delta: row.timer_delta ?? DEFAULT_TIMER_PARAMS.delta,
          rho:   row.timer_rho   ?? DEFAULT_TIMER_PARAMS.rho,
          tMin:  row.timer_tmin  ?? DEFAULT_TIMER_PARAMS.tMin,
          tMax:  row.timer_tmax  ?? DEFAULT_TIMER_PARAMS.tMax,
        });
      }
      if ((playersRes.count ?? 0) > 0) setNumPlayersForSim(playersRes.count!);
      setLoading(false);
    })();
  }, [mode, eventId]);

  // When numPacks changes, reset cards to defaults (if not manually set) or resize preserving values.
  useEffect(() => {
    const defaultCards = Math.round(45 / numPacks);
    if (!cardsManuallySet) {
      setCardsPerPack(defaultCards);
      setCardsPerPackArr(Array.from({ length: numPacks }, () => defaultCards));
    } else {
      setCardsPerPackArr((prev) =>
        Array.from({ length: numPacks }, (_, i) => prev[i] ?? defaultCards)
      );
    }
  }, [numPacks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload timer_packs from DB when returning from Advanced screen.
  useFocusEffect(
    useCallback(() => {
      if (firstFocusRef.current) {
        firstFocusRef.current = false;
        return;
      }
      if (mode !== 'event' || !eventId) return;
      void (async () => {
        const { data } = await supabase
          .from('draft_events')
          .select('timer_packs')
          .eq('id', eventId)
          .maybeSingle();
        if (!data) return;
        const row = data as any;
        const packs: number[] | null = Array.isArray(row.timer_packs) ? (row.timer_packs as number[]) : null;
        if (packs && packs.length > 0) {
          setCardsManuallySet(true);
          setNumPacks(packs.length);
          const allEqual = packs.every((p) => p === packs[0]);
          setEqualCards(allEqual);
          if (allEqual) setCardsPerPack(packs[0]!);
          setCardsPerPackArr(packs);
          savedPacksRef.current = packs;
        }
      })();
    }, [mode, eventId])
  );

  // Fixed back destination: always EventDetail.
  useEffect(() => {
    navigation.setOptions({
      gestureEnabled: false,
      headerLeft: () => (
        <TouchableOpacity
          hitSlop={12}
          onPress={() => {
            if (eventId) {
              navigation.navigate('EventDetail', { eventId });
            } else {
              navigation.goBack();
            }
          }}
        >
          <Text style={configStyles.backBtn}>Atrás</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, eventId]);

  const computeTimerPacks = (): number[] => {
    if (equalCards) return Array.from({ length: numPacks }, () => cardsPerPack);
    return cardsPerPackArr.slice(0, numPacks);
  };

  const isDirty = useMemo(() => {
    if (mode !== 'event') return true;
    if (savedPacksRef.current === null) return false;
    const current = equalCards
      ? Array.from({ length: numPacks }, () => cardsPerPack)
      : cardsPerPackArr.slice(0, numPacks);
    const saved = savedPacksRef.current;
    if (current.length !== saved.length) return true;
    return current.some((v, i) => v !== saved[i]);
  }, [mode, numPacks, equalCards, cardsPerPack, cardsPerPackArr]);

  const estimatedTimeStr = useMemo(() => {
    const packs = equalCards
      ? Array.from({ length: numPacks }, () => cardsPerPack)
      : cardsPerPackArr.slice(0, numPacks);
    if (packs.length === 0) return null;
    const tl = computePickTimeline(packs, numPlayersForSim, eventTimerParams);
    const totalSec = tl.reduce((a, p) => a + p.timeSeconds, 0);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return secs > 0 ? `${mins} min ${secs} seg` : `${mins} min`;
  }, [equalCards, numPacks, cardsPerPack, cardsPerPackArr, numPlayersForSim, eventTimerParams]);

  const onSave = async () => {
    const timerPacks = computeTimerPacks();
    if (mode === 'event') {
      if (!eventId) return;
      setSaving(true);
      const { error } = await supabase
        .from('draft_events')
        .update({ timer_packs: timerPacks })
        .eq('id', eventId);
      setSaving(false);
      if (error) {
        Alert.alert('Error', error.message ?? 'No se pudieron guardar los sobres.');
        return;
      }
      savedPacksRef.current = timerPacks;
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 1500);
    }
  };

  const onAdvanced = async () => {
    if (!eventId) return;
    if (mode === 'event' && isDirty) {
      const timerPacks = computeTimerPacks();
      const { error } = await supabase
        .from('draft_events')
        .update({ timer_packs: timerPacks })
        .eq('id', eventId);
      if (error) {
        Alert.alert('Error', error.message ?? 'No se pudieron guardar los sobres.');
        return;
      }
      savedPacksRef.current = timerPacks;
    }
    navigation.navigate('DraftTimerAdvanced', {
      eventId,
      numPlayers: numPlayersForSim,
      timerPacks: computeTimerPacks(),
      readOnly,
    });
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      {readOnly ? (
        <Text style={styles.readOnlyBanner}>Solo lectura — el draft ya inició</Text>
      ) : null}
      <Text style={styles.sectionTitle}>Sobres</Text>

      <Text style={styles.label}>Número de sobres</Text>
      <View style={[styles.segmented, readOnly && styles.disabledGroup]}>
        {[1, 2, 3, 4, 5, 6, 7].map((n) => (
          <TouchableOpacity
            key={n}
            disabled={readOnly}
            style={[styles.segment, numPacks === n && styles.segmentSelected]}
            onPress={() => { setNumPacks(n); setCardsManuallySet(false); }}
          >
            <Text style={[styles.segmentTxt, numPacks === n && styles.segmentTxtSelected]}>{n}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Número de cartas fijo por sobre</Text>
        <Switch
          value={equalCards}
          disabled={readOnly}
          onValueChange={(v) => {
            if (!v) {
              const defaultCards = Math.round(45 / numPacks);
              setCardsPerPackArr(Array.from({ length: numPacks }, () => defaultCards));
            }
            setEqualCards(v);
          }}
        />
      </View>

      {equalCards ? (
        <View style={styles.stepperRow}>
          <Text style={styles.stepLabel}>Cartas por sobre</Text>
          <View style={[styles.stepperCtrl, readOnly && styles.disabledGroup]}>
            <TouchableOpacity
              style={styles.stepBtn}
              disabled={readOnly}
              onPress={() => { setCardsPerPack((v) => Math.max(5, v - 1)); setCardsManuallySet(true); }}
            >
              <Text style={styles.stepBtnTxt}>−</Text>
            </TouchableOpacity>
            <Text style={styles.stepVal}>{cardsPerPack}</Text>
            <TouchableOpacity
              style={styles.stepBtn}
              disabled={readOnly}
              onPress={() => { setCardsPerPack((v) => Math.min(20, v + 1)); setCardsManuallySet(true); }}
            >
              <Text style={styles.stepBtnTxt}>+</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.multiPackWrap}>
          <Text style={styles.label}>Cartas por sobre</Text>
          <View style={[styles.multiPackRow, readOnly && styles.disabledGroup]}>
            {cardsPerPackArr.slice(0, numPacks).map((n, i) => (
              <View key={i} style={styles.packStepper}>
                <Text style={styles.packLabel}>S{i + 1}</Text>
                <TouchableOpacity
                  style={styles.stepBtnSm}
                  disabled={readOnly}
                  onPress={() =>
                    setCardsPerPackArr((prev) => {
                      const next = [...prev];
                      next[i] = Math.min(20, (next[i] ?? 15) + 1);
                      return next;
                    })
                  }
                >
                  <Text style={styles.stepBtnTxt}>+</Text>
                </TouchableOpacity>
                <Text style={styles.stepValSm}>{n}</Text>
                <TouchableOpacity
                  style={styles.stepBtnSm}
                  disabled={readOnly}
                  onPress={() =>
                    setCardsPerPackArr((prev) => {
                      const next = [...prev];
                      next[i] = Math.max(5, (next[i] ?? 15) - 1);
                      return next;
                    })
                  }
                >
                  <Text style={styles.stepBtnTxt}>−</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        </View>
      )}

      {estimatedTimeStr ? (
        <TouchableOpacity
          onPress={() =>
            navigation.navigate('DraftTimerPreview', {
              timerPacks: computeTimerPacks(),
              numPlayers: numPlayersForSim,
              ...eventTimerParams,
            })
          }
        >
          <Text style={styles.estimatedTime}>Tiempo estimado: {estimatedTimeStr} ›</Text>
        </TouchableOpacity>
      ) : null}

      {mode === 'event' ? (
        <TouchableOpacity style={styles.advancedBtn} onPress={() => void onAdvanced()}>
          <Text style={styles.advancedBtnTxt}>Configuración avanzada</Text>
        </TouchableOpacity>
      ) : null}

      {!readOnly ? (
        <TouchableOpacity
          style={[styles.saveBtn, (!isDirty || saving) && styles.saveBtnDisabled]}
          onPress={() => void onSave()}
          disabled={!isDirty || saving}
        >
          {saving
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.saveBtnTxt}>{justSaved ? '✓ Guardado' : 'Guardar'}</Text>}
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 24, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#111', marginBottom: 12 },
  label: { fontSize: 15, fontWeight: '600', color: '#111', marginBottom: 8 },
  segmented: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: 16,
  },
  segment: { flex: 1, paddingVertical: 12, alignItems: 'center', backgroundColor: '#fafafa' },
  segmentSelected: { backgroundColor: '#3B82F6' },
  segmentTxt: { fontSize: 15, color: '#111', fontWeight: '600' },
  segmentTxtSelected: { color: '#fff' },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 16,
  },
  switchLabel: { flex: 1, fontSize: 15, color: '#111', fontWeight: '500' },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  stepLabel: { fontSize: 15, color: '#111', fontWeight: '500' },
  stepperCtrl: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: '#DBEAFE',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnSm: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: '#DBEAFE',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnTxt: { fontSize: 20, fontWeight: '700', color: '#1E40AF' },
  stepVal: { fontSize: 20, fontWeight: '700', color: '#111', minWidth: 36, textAlign: 'center' },
  stepValSm: { fontSize: 14, fontWeight: '700', color: '#111', minWidth: 24, textAlign: 'center' },
  multiPackWrap: { marginBottom: 16 },
  multiPackRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  packStepper: { alignItems: 'center', gap: 2 },
  packLabel: { fontSize: 11, color: '#6B7280', fontWeight: '600' },
  advancedBtn: {
    borderWidth: 1,
    borderColor: '#BFDBFE',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 12,
    backgroundColor: '#EFF6FF',
  },
  advancedBtnTxt: { color: '#1D4ED8', fontSize: 15, fontWeight: '600' },
  saveBtn: {
    backgroundColor: '#3B82F6',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  saveBtnDisabled: { backgroundColor: '#9CA3AF' },
  saveBtnTxt: { color: '#fff', fontSize: 16, fontWeight: '600' },
  readOnlyBanner: { fontSize: 12, color: '#92400E', backgroundColor: '#FEF3C7', borderRadius: 6, padding: 8, marginBottom: 12, textAlign: 'center', fontWeight: '600' },
  disabledGroup: { opacity: 0.5 },
  estimatedTime: { fontSize: 14, fontWeight: '600', color: '#374151', textAlign: 'center', marginBottom: 16, paddingVertical: 10, backgroundColor: '#F0FDF4', borderRadius: 8, borderWidth: 1, borderColor: '#BBF7D0' },
});

const configStyles = StyleSheet.create({
  backBtn: { color: '#3B82F6', fontSize: 17, fontWeight: '400' },
});

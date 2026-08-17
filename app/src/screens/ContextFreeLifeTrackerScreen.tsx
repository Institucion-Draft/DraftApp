import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useKeepAwake } from 'expo-keep-awake';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import type { MtgColor } from '../lib/database.types';
import { defaultAvatarPublicUrl } from '../lib/avatarUrl';

type Props = NativeStackScreenProps<MainStackParamList, 'ContextFreeLifeTracker'>;

// ── color helpers ─────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────────────────

type MatchRow = {
  id: string;
  encounter_id: string;
  match_number: number;
  starting_life_a: number;
  starting_life_b: number;
  ended_at: string | null;
  winner_user_id: string | null;
};

type EncounterRow = {
  id: string;
  encounter_type: 'bo1' | 'bo3';
  user_a_id: string;
  user_b_id: string;
  colors_a: string[];
  colors_b: string[];
  ended_at: string | null;
};

type UserName = { id: string; display_name: string; username: string };

const PERSIST_DELAY_MS = 3500;

function clamp(value: number): number {
  return Math.max(0, value);
}

export default function ContextFreeLifeTrackerScreen({ navigation, route }: Props) {
  useKeepAwake();
  const { matchId, encounterId, workspaceId, starterUserId } = route.params;

  const [loading, setLoading] = useState(true);
  const [match, setMatch] = useState<MatchRow | null>(null);
  const [encounter, setEncounter] = useState<EncounterRow | null>(null);
  const [userA, setUserA] = useState<UserName | null>(null);
  const [userB, setUserB] = useState<UserName | null>(null);
  const [avatarUrlA, setAvatarUrlA] = useState<string | null>(null);
  const [avatarUrlB, setAvatarUrlB] = useState<string | null>(null);
  const [bgA, setBgA] = useState<MtgColor>('C');
  const [bgB, setBgB] = useState<MtgColor>('C');
  const [winsA, setWinsA] = useState(0);
  const [winsB, setWinsB] = useState(0);
  const [showStarterModal, setShowStarterModal] = useState(false);
  const [pickedStarterUserId, setPickedStarterUserId] = useState<string | null>(
    starterUserId ?? null
  );

  const stableA = useRef(20);
  const stableB = useRef(20);
  const pendingA = useRef(0);
  const pendingB = useRef(0);
  const [lifeA, setLifeA] = useState(20);
  const [lifeB, setLifeB] = useState(20);

  const timerA = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerB = useRef<ReturnType<typeof setTimeout> | null>(null);
  const concluding = useRef(false);

  const load = useCallback(async () => {
    const [matchRes, encRes] = await Promise.all([
      supabase
        .from('context_free_matches')
        .select('id, encounter_id, match_number, starting_life_a, starting_life_b, ended_at, winner_user_id')
        .eq('id', matchId)
        .single(),
      supabase
        .from('context_free_encounters')
        .select('id, encounter_type, user_a_id, user_b_id, colors_a, colors_b, ended_at')
        .eq('id', encounterId)
        .single(),
    ]);

    if (matchRes.error || encRes.error || !matchRes.data || !encRes.data) {
      if (__DEV__) console.error('CFLifeTracker load error:', matchRes.error ?? encRes.error);
      return;
    }

    const m = matchRes.data as unknown as MatchRow;
    const e = encRes.data as unknown as EncounterRow;
    setMatch(m);
    setEncounter(e);

    stableA.current = m.starting_life_a;
    stableB.current = m.starting_life_b;
    pendingA.current = 0;
    pendingB.current = 0;
    setLifeA(m.starting_life_a);
    setLifeB(m.starting_life_b);

    const colorsA = (e.colors_a ?? []) as MtgColor[];
    const colorsB = (e.colors_b ?? []) as MtgColor[];
    const seed = `${encounterId}-${m.match_number}`;
    const { bgA: bA, bgB: bB } = pickCoordinatedBgColors(colorsA, colorsB, seed);
    setBgA(bA);
    setBgB(bB);

    const [usersRes, presenceRes, winsRes] = await Promise.all([
      supabase
        .from('users')
        .select('id, display_name, username')
        .in('id', [e.user_a_id, e.user_b_id]),
      supabase
        .from('playground_presence')
        .select('user_id, is_shiny, default_avatars ( storage_path, storage_path_shiny )')
        .eq('workspace_id', workspaceId)
        .in('user_id', [e.user_a_id, e.user_b_id]),
      e.encounter_type === 'bo3'
        ? supabase
            .from('context_free_matches')
            .select('winner_user_id')
            .eq('encounter_id', encounterId)
            .not('ended_at', 'is', null)
        : Promise.resolve({ data: [], error: null }),
    ]);

    const rows = usersRes.data ?? [];
    setUserA(rows.find((r) => r.id === e.user_a_id) ?? null);
    setUserB(rows.find((r) => r.id === e.user_b_id) ?? null);

    const presRows = (presenceRes.data ?? []) as unknown as Array<{
      user_id: string;
      is_shiny: boolean;
      default_avatars: { storage_path: string; storage_path_shiny: string | null } | null;
    }>;
    const getAvatarUrl = (userId: string): string | null => {
      const p = presRows.find((r) => r.user_id === userId);
      if (!p?.default_avatars) return null;
      const path =
        p.is_shiny && p.default_avatars.storage_path_shiny
          ? p.default_avatars.storage_path_shiny
          : p.default_avatars.storage_path;
      return defaultAvatarPublicUrl(path);
    };
    setAvatarUrlA(getAvatarUrl(e.user_a_id));
    setAvatarUrlB(getAvatarUrl(e.user_b_id));

    if (e.encounter_type === 'bo3') {
      const winsData = winsRes.data ?? [];
      setWinsA(winsData.filter((w) => w.winner_user_id === e.user_a_id).length);
      setWinsB(winsData.filter((w) => w.winner_user_id === e.user_b_id).length);
    }

    if (m.match_number === 1) {
      setShowStarterModal(true);
    }
  }, [matchId, encounterId, workspaceId]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  const persistLife = async (side: 'a' | 'b', delta: number, userId: string) => {
    if (delta === 0) return;
    await supabase.from('context_free_life_events').insert({
      match_id: matchId,
      user_id: userId,
      delta,
    });
    if (side === 'a') {
      stableA.current += delta;
      pendingA.current = 0;
    } else {
      stableB.current += delta;
      pendingB.current = 0;
    }
  };

  const flushAndPersist = async (side: 'a' | 'b') => {
    if (!encounter) return;
    const userId = side === 'a' ? encounter.user_a_id : encounter.user_b_id;
    const delta = side === 'a' ? pendingA.current : pendingB.current;
    await persistLife(side, delta, userId);
  };

  const adjustLife = (side: 'a' | 'b', delta: number) => {
    if (!encounter) return;
    if (side === 'a') {
      const next = clamp(stableA.current + pendingA.current + delta);
      pendingA.current = next - stableA.current;
      setLifeA(next);
      if (timerA.current) clearTimeout(timerA.current);
      timerA.current = setTimeout(() => {
        void flushAndPersist('a').then(() => {
          if (!concluding.current && stableA.current === 0) {
            checkZeroLife('a');
          }
        });
      }, PERSIST_DELAY_MS);
    } else {
      const next = clamp(stableB.current + pendingB.current + delta);
      pendingB.current = next - stableB.current;
      setLifeB(next);
      if (timerB.current) clearTimeout(timerB.current);
      timerB.current = setTimeout(() => {
        void flushAndPersist('b').then(() => {
          if (!concluding.current && stableB.current === 0) {
            checkZeroLife('b');
          }
        });
      }, PERSIST_DELAY_MS);
    }
  };

  const checkZeroLife = (side: 'a' | 'b') => {
    if (!encounter || !match || concluding.current) return;
    const loserName =
      side === 'a'
        ? userA?.display_name || userA?.username || 'Jugador A'
        : userB?.display_name || userB?.username || 'Jugador B';
    const winnerUserId = side === 'a' ? encounter.user_b_id : encounter.user_a_id;

    Alert.alert(
      `${loserName} llegó a 0`,
      '¿Confirmar resultado de esta partida?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Confirmar',
          onPress: () => void concludeMatch(winnerUserId),
        },
      ]
    );
  };

  const concludeMatch = async (winnerUserId: string) => {
    if (!match || !encounter || concluding.current) return;
    concluding.current = true;

    if (timerA.current) { clearTimeout(timerA.current); timerA.current = null; }
    if (timerB.current) { clearTimeout(timerB.current); timerB.current = null; }

    await Promise.all([
      flushAndPersist('a'),
      flushAndPersist('b'),
    ]);

    const now = new Date().toISOString();

    await supabase
      .from('context_free_matches')
      .update({ winner_user_id: winnerUserId, ended_at: now })
      .eq('id', matchId);

    if (encounter.encounter_type === 'bo1') {
      await finishEncounter(winnerUserId, now);
      return;
    }

    const { data: matchesData } = await supabase
      .from('context_free_matches')
      .select('winner_user_id')
      .eq('encounter_id', encounterId)
      .not('ended_at', 'is', null);

    const matches = matchesData ?? [];
    const newWinsA = matches.filter((m) => m.winner_user_id === encounter.user_a_id).length;
    const newWinsB = matches.filter((m) => m.winner_user_id === encounter.user_b_id).length;

    if (newWinsA >= 2 || newWinsB >= 2) {
      const encounterWinner = newWinsA >= 2 ? encounter.user_a_id : encounter.user_b_id;
      await finishEncounter(encounterWinner, now);
      return;
    }

    const nextNumber = match.match_number + 1;
    const { data: nextMatchData } = await supabase
      .from('context_free_matches')
      .insert({
        encounter_id: encounterId,
        match_number: nextNumber,
        starting_life_a: 20,
        starting_life_b: 20,
      })
      .select('id')
      .single();

    if (!nextMatchData) {
      concluding.current = false;
      Alert.alert('Error', 'No se pudo crear la siguiente partida.');
      return;
    }

    navigation.replace('ContextFreeLifeTracker', {
      matchId: nextMatchData.id,
      encounterId,
      workspaceId,
    });
  };

  const finishEncounter = async (winnerUserId: string, now: string) => {
    await Promise.all([
      supabase
        .from('context_free_encounters')
        .update({ winner_user_id: winnerUserId, ended_at: now })
        .eq('id', encounterId),
      supabase
        .from('playground_presence')
        .update({ last_match_ended_at: now })
        .in('user_id', [encounter!.user_a_id, encounter!.user_b_id])
        .eq('workspace_id', workspaceId),
    ]);

    navigation.replace('ContextFreeEncounter', {
      workspaceId,
      userAId: encounter!.user_a_id,
      userBId: encounter!.user_b_id,
    });
  };

  const handleSurrender = (side: 'a' | 'b') => {
    if (!encounter || !match || concluding.current) return;
    const surrenderName =
      side === 'a'
        ? userA?.display_name || userA?.username || 'Jugador A'
        : userB?.display_name || userB?.username || 'Jugador B';
    const winnerUserId = side === 'a' ? encounter.user_b_id : encounter.user_a_id;

    Alert.alert(
      'Rendirse',
      `¿${surrenderName} se rinde?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Confirmar',
          style: 'destructive',
          onPress: () => void concludeMatch(winnerUserId),
        },
      ]
    );
  };

  const nameA = userA?.display_name || userA?.username || 'A';
  const nameB = userB?.display_name || userB?.username || 'B';

  if (loading || !match || !encounter) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  const isBo3 = encounter.encounter_type === 'bo3';
  const matchLabel = isBo3 ? `Partida ${match.match_number}` : '';
  const isDarkA = bgA === 'B';
  const isDarkB = bgB === 'B';

  const renderHalf = (slot: 'a' | 'b', rotated: boolean) => {
    const isA = slot === 'a';
    const life = isA ? lifeA : lifeB;
    const name = isA ? nameA : nameB;
    const avatarUrl = isA ? avatarUrlA : avatarUrlB;
    const bgColor = isA ? bgA : bgB;
    const isDark = isA ? isDarkA : isDarkB;
    const wins = isA ? winsA : winsB;

    const body = (
      <>
        {isBo3 ? (
          <View style={styles.topRow}>
            <View style={styles.bo3Wrap}>
              <View style={[styles.bo3Box, wins >= 1 && styles.bo3Filled]} />
              <View style={[styles.bo3Box, wins >= 2 && styles.bo3Filled]} />
            </View>
          </View>
        ) : null}
        <View style={styles.lifeRow}>
          <View style={styles.playerBlock}>
            {avatarUrl ? (
              <Image
                source={{ uri: avatarUrl }}
                style={styles.avatarImg}
                resizeMode="contain"
              />
            ) : (
              <View style={styles.avatarPlaceholder} />
            )}
            <Text style={[styles.playerName, isDark && styles.lightText]}>{name}</Text>
          </View>
          <View style={styles.lifeControlsVertical}>
            <TouchableOpacity
              style={[styles.lifeBtn, isDark && styles.lifeBtnDark]}
              onPress={() => adjustLife(slot, 1)}
            >
              <Text style={[styles.lifeBtnTxt, isDark && styles.lightText]}>+1</Text>
            </TouchableOpacity>
            <Text style={[styles.lifeNumber, isDark && styles.lightText]}>
              {clamp(life)}
            </Text>
            <TouchableOpacity
              style={[styles.lifeBtn, isDark && styles.lifeBtnDark]}
              onPress={() => adjustLife(slot, -1)}
            >
              <Text style={[styles.lifeBtnTxt, isDark && styles.lightText]}>-1</Text>
            </TouchableOpacity>
          </View>
        </View>
      </>
    );

    return (
      <View style={[styles.half, { backgroundColor: COLOR_BG[bgColor] }]}>
        {rotated ? <View style={styles.rotated}>{body}</View> : body}
        <TouchableOpacity
          style={[
            styles.flagBtn,
            rotated ? styles.flagBtnEquatorTop : styles.flagBtnEquatorBottom,
            rotated ? styles.flagBtnRight : styles.flagBtnLeft,
          ]}
          onPress={() => handleSurrender(slot)}
        >
          <Text style={styles.flagTxt}>🏳️</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const starterName = pickedStarterUserId === encounter.user_a_id
    ? nameA
    : pickedStarterUserId === encounter.user_b_id
    ? nameB
    : null;

  return (
    <View style={styles.root}>
      {renderHalf('b', true)}

      <View style={styles.midStrip}>
        {isBo3 ? (
          <>
            <View style={styles.bo3SideWrap}>
              <View style={[styles.bo3BoxMid, winsA >= 1 && styles.bo3FilledMid]} />
              <View style={[styles.bo3BoxMid, winsA >= 2 && styles.bo3FilledMid]} />
            </View>
            {matchLabel ? (
              <Text style={styles.midLabel}>{matchLabel}</Text>
            ) : null}
            <View style={styles.bo3SideWrap}>
              <View style={[styles.bo3BoxMid, winsB >= 1 && styles.bo3FilledMid]} />
              <View style={[styles.bo3BoxMid, winsB >= 2 && styles.bo3FilledMid]} />
            </View>
          </>
        ) : null}
      </View>

      {renderHalf('a', false)}

      <Modal
        transparent
        animationType="fade"
        visible={showStarterModal}
        onRequestClose={() => setShowStarterModal(false)}
      >
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>¿Quién empieza?</Text>
            <View style={styles.modalOptions}>
              {[
                { id: encounter.user_a_id, name: nameA, avatarUrl: avatarUrlA },
                { id: encounter.user_b_id, name: nameB, avatarUrl: avatarUrlB },
              ].map(({ id, name, avatarUrl }) => {
                const selected = pickedStarterUserId === id;
                return (
                  <TouchableOpacity
                    key={id}
                    style={[styles.modalOption, selected && styles.modalOptionSelected]}
                    onPress={() => setPickedStarterUserId(id)}
                    activeOpacity={0.7}
                  >
                    {avatarUrl ? (
                      <Image
                        source={{ uri: avatarUrl }}
                        style={styles.modalAvatar}
                        resizeMode="contain"
                      />
                    ) : (
                      <View style={styles.modalAvatarPh} />
                    )}
                    <Text style={[styles.modalOptionName, selected && styles.modalOptionNameSelected]}>
                      {name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TouchableOpacity
              style={styles.modalConfirmBtn}
              onPress={() => setShowStarterModal(false)}
            >
              <Text style={styles.modalConfirmTxt}>
                {starterName ? `${starterName} empieza` : 'Continuar'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const SCREEN_HEIGHT = Dimensions.get('window').height;
const MID_HEIGHT = 40;
const HALF_HEIGHT = (SCREEN_HEIGHT - MID_HEIGHT) / 2;
const AVATAR_SIZE = 64;

const styles = StyleSheet.create({
  root: { flex: 1 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  half: {
    height: HALF_HEIGHT,
    position: 'relative',
    overflow: 'hidden',
  },
  rotated: {
    transform: [{ rotate: '180deg' }],
    width: '100%',
    flex: 1,
    justifyContent: 'center',
  },
  topRow: {
    paddingTop: 8,
    paddingHorizontal: 16,
  },
  bo3Wrap: { flexDirection: 'row', gap: 6 },
  bo3Box: {
    width: 24,
    height: 10,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: '#9CA3AF',
  },
  bo3Filled: { backgroundColor: '#6B7280', borderColor: '#6B7280' },
  lifeRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  playerBlock: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  avatarImg: { width: AVATAR_SIZE, height: AVATAR_SIZE },
  avatarPlaceholder: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  playerName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111',
    textAlign: 'center',
  },
  lightText: { color: '#fff' },
  lifeControlsVertical: {
    width: '50%',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    gap: 8,
  },
  lifeBtn: {
    width: 64,
    height: 48,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lifeBtnDark: { backgroundColor: 'rgba(255,255,255,0.15)' },
  lifeBtnTxt: { fontSize: 22, fontWeight: '700', color: '#111' },
  lifeNumber: {
    fontSize: 72,
    fontWeight: '800',
    color: '#111',
    textAlign: 'center',
    lineHeight: 80,
  },
  flagBtn: {
    position: 'absolute',
    padding: 10,
  },
  flagBtnEquatorTop: { bottom: 12 },
  flagBtnEquatorBottom: { top: 12 },
  flagBtnRight: { right: 22 },
  flagBtnLeft: { left: 22 },
  flagTxt: { fontSize: 22 },
  midStrip: {
    height: MID_HEIGHT,
    backgroundColor: '#1F2937',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    gap: 8,
  },
  midLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#D1D5DB',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  bo3SideWrap: { flexDirection: 'row', gap: 4 },
  bo3BoxMid: {
    width: 20,
    height: 8,
    borderRadius: 2,
    borderWidth: 1,
    borderColor: '#6B7280',
  },
  bo3FilledMid: { backgroundColor: '#9CA3AF', borderColor: '#9CA3AF' },
  // ── who-starts modal ───────────────────────────────────────────────────────
  modalBg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#111',
    marginBottom: 20,
  },
  modalOptions: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 20,
    width: '100%',
  },
  modalOption: {
    flex: 1,
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#E5E7EB',
    paddingVertical: 14,
    paddingHorizontal: 8,
    backgroundColor: '#F9FAFB',
  },
  modalOptionSelected: {
    borderColor: '#3B82F6',
    backgroundColor: '#EFF6FF',
  },
  modalAvatar: { width: 56, height: 56, marginBottom: 8 },
  modalAvatarPh: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#E5E7EB',
    marginBottom: 8,
  },
  modalOptionName: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
    textAlign: 'center',
  },
  modalOptionNameSelected: { color: '#1D4ED8' },
  modalConfirmBtn: {
    backgroundColor: '#3B82F6',
    borderRadius: 10,
    paddingVertical: 13,
    paddingHorizontal: 32,
    width: '100%',
    alignItems: 'center',
  },
  modalConfirmTxt: { color: '#fff', fontSize: 16, fontWeight: '700' },
});

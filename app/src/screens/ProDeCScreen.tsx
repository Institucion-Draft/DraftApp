import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  Dimensions,
  RefreshControl,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ConfettiCannon from 'react-native-confetti-cannon';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import { useAuth } from '../contexts/AuthContext';
import type { MtgColor } from '../lib/database.types';
import { MTG_COLOR_HEX } from '../components/ColorFlag';
import ProDeCManaC from '../components/ProDeCManaC';
import ProDeCFrequencyChart from '../components/ProDeCFrequencyChart';
import PlayerAvatar, { type PlayerAvatarSize } from '../components/PlayerAvatar';
import {
  buildFrequencyTiers,
  countDeclaredColors,
  groupVotersByTier,
  type FrequencyTier,
  type ProDeCVoter,
} from '../lib/prodecDisplay';

type Props = NativeStackScreenProps<MainStackParamList, 'ProDeC'>;

/** Mismo ancho útil que Standings para alinear podio de campeón. */
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

const ASYNC_COMPACT = (userId: string, eventId: string) => `prodec_detail_compact_${userId}_${eventId}`;
const ASYNC_CONFETTI = (userId: string, eventId: string) => `prodec_confetti_${userId}_${eventId}`;

export default function ProDeCScreen({ route, navigation }: Props) {
  const { eventId } = route.params;
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [counts, setCounts] = useState(() => countDeclaredColors([]));
  const [tiers, setTiers] = useState<FrequencyTier[]>([]);
  const [votersByTier, setVotersByTier] = useState<Map<number, ProDeCVoter[]>>(new Map());
  const [showConfetti, setShowConfetti] = useState(false);

  const winW = Dimensions.get('window').width;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <View style={styles.headerTitleRow}>
          <Text style={styles.headerTitleText}>ProDe</Text>
          <ProDeCManaC size={26} />
        </View>
      ),
      headerLeft: hierarchicalHeaderBack(navigation, 'EventDetail', { eventId }),
    });
  }, [navigation, eventId]);

  const load = useCallback(async () => {
    const partsRes = await supabase
      .from('event_participants')
      .select('id, user_id')
      .eq('event_id', eventId)
      .eq('role', 'player');

    if (partsRes.error) {
      Alert.alert('Error', partsRes.error.message ?? 'No se pudieron cargar los participantes.');
      setLoading(false);
      return;
    }

    const participants = (partsRes.data ?? []) as { id: string; user_id: string }[];
    const ids = participants.map((p) => p.id);
    const userToParticipant = new Map(participants.map((p) => [p.user_id, p.id]));

    const [colorsRes, predRes] = await Promise.all([
      ids.length > 0
        ? supabase.from('participant_colors').select('participant_id, color').in('participant_id', ids)
        : Promise.resolve({ data: [] as { participant_id: string; color: string }[], error: null }),
      supabase.from('event_color_predictions').select('user_id, predicted_color').eq('event_id', eventId),
    ]);

    if (colorsRes.error) {
      Alert.alert('Error', colorsRes.error.message ?? 'No se pudieron cargar los colores.');
      setLoading(false);
      return;
    }

    const colorRows = (colorsRes.data ?? []) as { color: MtgColor }[];
    const nextCounts = countDeclaredColors(colorRows);
    const nextTiers = buildFrequencyTiers(nextCounts);

    if (predRes.error) {
      Alert.alert('Error', predRes.error.message ?? 'No se pudieron cargar las predicciones.');
      setLoading(false);
      return;
    }

    const preds = (predRes.data ?? []) as { user_id: string; predicted_color: string }[];
    const nextVoters = groupVotersByTier(nextTiers, preds, userToParticipant);

    setCounts(nextCounts);
    setTiers(nextTiers);
    setVotersByTier(nextVoters);
    setLoading(false);
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!user?.id) return;
    void AsyncStorage.setItem(ASYNC_COMPACT(user.id, eventId), '1');
  }, [user?.id, eventId]);

  useEffect(() => {
    if (!user?.id || loading) return;
    void (async () => {
      const k = ASYNC_CONFETTI(user.id, eventId);
      const seen = await AsyncStorage.getItem(k);
      if (!seen) {
        setShowConfetti(true);
        await AsyncStorage.setItem(k, '1');
      }
    })();
  }, [user?.id, eventId, loading]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  const idxCenter = tiers.length > 0 ? 0 : null;
  const idxLeft = tiers.length > 1 ? 1 : null;
  const idxRight = tiers.length > 2 ? 2 : null;

  const renderPedestalColumn = (
    rank: 1 | 2 | 3,
    tierIdx: number | null,
    baseH: number,
    defaultBaseBg: string
  ) => {
    const tier = tierIdx != null ? tiers[tierIdx] ?? null : null;
    const voters = tierIdx != null ? (votersByTier.get(tierIdx) ?? []) : [];
    const cnt = voters.length;
    const avatarSize = cnt > 0 ? podiumStepAvatarSize(cnt) : ('large' as PlayerAvatarSize);
    const avatarBorder = cnt <= 1 ? 3 : 2;
    const showNadie = rank === 1 && tierIdx === 0 && cnt === 0;

    const renderOneAvatar = (v: ProDeCVoter) => (
      <TouchableOpacity
        key={v.userId}
        activeOpacity={0.75}
        style={styles.podiumPlayerStack}
        onPress={() =>
          navigation.navigate('PlayerProfileInEvent', {
            eventId,
            participantId: v.participantId,
            from: 'EventDetail',
          })
        }
      >
        <PlayerAvatar
          userId={v.userId}
          participantId={v.participantId}
          size={avatarSize}
          withColorBorder
          borderWidth={avatarBorder}
        />
      </TouchableOpacity>
    );

    return (
      <View style={styles.podiumCol}>
        <View style={styles.podiumAvatarArea}>
          {showNadie ? (
            <View style={styles.nadieBox}>
              <Text style={styles.nadieTxt}>NADIE</Text>
            </View>
          ) : cnt === 0 ? (
            <View style={styles.podiumAvatarSpacer} />
          ) : (
            <View style={styles.podiumAvatarRow}>{voters.map(renderOneAvatar)}</View>
          )}
        </View>
        <View style={[styles.podiumBaseWrap, { height: baseH }]}>
          {tier && tier.colors.length > 0 ? (
            <View style={styles.podiumBaseSplit}>
              {tier.colors.map((col) => (
                <View key={col} style={[styles.podiumBaseSlice, { flex: 1, backgroundColor: MTG_COLOR_HEX[col] }]} />
              ))}
            </View>
          ) : (
            <View style={[styles.podiumBaseSolid, { backgroundColor: defaultBaseBg }]} />
          )}
        </View>
      </View>
    );
  };

  const podiumBlock =
    tiers.length > 0 ? (
      <View style={styles.podiumSection}>
        <View style={styles.podiumArena}>
          <View style={styles.podiumCenterRow}>
            {renderPedestalColumn(2, idxLeft, 90, '#D1D5DB')}
            {renderPedestalColumn(1, idxCenter, 124, '#E5E7EB')}
            {renderPedestalColumn(3, idxRight, 70, '#B45309')}
          </View>
        </View>
      </View>
    ) : null;

  return (
    <View style={styles.root}>
      {showConfetti ? (
        <View pointerEvents="none" style={styles.confettiOverlay}>
          <ConfettiCannon count={150} origin={{ x: Math.max(80, winW / 2), y: -6 }} fadeOut />
        </View>
      ) : null}
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <View style={styles.titleRow}>
          <Text style={styles.screenTitle}>ProDe</Text>
          <ProDeCManaC size={42} />
        </View>
        <Text style={styles.screenSubtitle}>Pronóstico De Colores</Text>

        {podiumBlock}

        <ProDeCFrequencyChart counts={counts} width={winW - 48} />
        <Text style={styles.chartFootnote}>Frecuencia de colores declarados</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  container: { flex: 1 },
  scroll: { padding: 24, paddingBottom: 40 },
  confettiOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 50,
  },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 0 },
  headerTitleText: { fontSize: 17, fontWeight: '700', color: '#111' },
  titleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  screenTitle: { fontSize: 26, fontWeight: '800', color: '#111' },
  screenSubtitle: { fontSize: 15, color: '#666', marginBottom: 20 },
  podiumSection: { marginBottom: 22 },
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
    alignItems: 'center',
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
  nadieBox: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#D1D5DB',
    backgroundColor: '#F9FAFB',
  },
  nadieTxt: { fontSize: 15, fontWeight: '800', color: '#6B7280', letterSpacing: 1 },
  podiumBaseWrap: {
    width: '100%',
    borderRadius: 8,
    marginTop: 2,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.12)',
  },
  podiumBaseSplit: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
  },
  podiumBaseSlice: { minWidth: 6 },
  podiumBaseSolid: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  chartFootnote: {
    marginTop: 12,
    fontSize: 12,
    color: '#6B7280',
    lineHeight: 17,
  },
});

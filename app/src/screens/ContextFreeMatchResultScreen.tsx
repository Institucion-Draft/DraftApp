import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import ConfettiCannon from 'react-native-confetti-cannon';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import { defaultAvatarPublicUrl } from '../lib/avatarUrl';

type Props = NativeStackScreenProps<MainStackParamList, 'ContextFreeMatchResult'>;

type UserRow = { id: string; username: string; display_name: string };
type PresenceRow = {
  user_id: string;
  is_shiny: boolean;
  default_avatars: { storage_path: string; storage_path_shiny: string | null } | null;
};

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

export default function ContextFreeMatchResultScreen({ route, navigation }: Props) {
  const { winnerId, encounterType, winsA, winsB, userAId, userBId, workspaceId, encounterId } =
    route.params;

  const [loading, setLoading] = useState(true);
  const [ua, setUa] = useState<UserRow | null>(null);
  const [ub, setUb] = useState<UserRow | null>(null);
  const [winnerAvatarUri, setWinnerAvatarUri] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const [usersRes, presenceRes] = await Promise.all([
      supabase.from('users').select('id, username, display_name').in('id', [userAId, userBId]),
      supabase
        .from('playground_presence')
        .select('user_id, is_shiny, default_avatars ( storage_path, storage_path_shiny )')
        .eq('workspace_id', workspaceId)
        .in('user_id', [userAId, userBId]),
    ]);

    if (usersRes.error) {
      setLoading(false);
      return;
    }

    const usersData = (usersRes.data ?? []) as UserRow[];
    setUa(usersData.find((u) => u.id === userAId) ?? null);
    setUb(usersData.find((u) => u.id === userBId) ?? null);

    const presenceData = (presenceRes.data ?? []) as unknown as PresenceRow[];
    const winnerPresence = presenceData.find((p) => p.user_id === winnerId);
    if (winnerPresence) {
      const da = relationOne(
        winnerPresence.default_avatars as
          | { storage_path: string; storage_path_shiny: string | null }
          | { storage_path: string; storage_path_shiny: string | null }[]
          | null
      );
      if (da) {
        const path =
          winnerPresence.is_shiny && da.storage_path_shiny
            ? da.storage_path_shiny
            : da.storage_path;
        setWinnerAvatarUri(defaultAvatarPublicUrl(path));
      }
    }

    setLoading(false);
  }, [userAId, userBId, workspaceId, winnerId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'ContextFreeEncounter', {
        workspaceId,
        userAId,
        userBId,
      }),
    });
  }, [navigation, workspaceId, userAId, userBId]);

  const nameA = ua?.display_name || ua?.username || 'Jugador A';
  const nameB = ub?.display_name || ub?.username || 'Jugador B';
  const winnerName = winnerId === userAId ? nameA : nameB;

  const encounterDone =
    encounterType === 'bo1' || winsA >= 2 || winsB >= 2;

  const primaryLabel = (() => {
    if (encounterType === 'bo1') return 'Jugar otra partida';
    if (winsA >= 2 || winsB >= 2) return 'Otro enfrentamiento';
    if (winsA === 1 && winsB === 1) return 'Jugar el bueno';
    return 'Jugar la vuelta';
  })();

  const goToNextMatch = async () => {
    if (creating) return;
    setCreating(true);
    const nextNumber = winsA + winsB + 1;
    const { data: nextMatchData, error } = await supabase
      .from('context_free_matches')
      .insert({
        encounter_id: encounterId,
        match_number: nextNumber,
        starting_life_a: 20,
        starting_life_b: 20,
      })
      .select('id')
      .single();
    if (error || !nextMatchData) {
      setCreating(false);
      Alert.alert('Error', 'No se pudo crear la siguiente partida.');
      return;
    }
    navigation.replace('ContextFreeLifeTracker', {
      matchId: (nextMatchData as { id: string }).id,
      encounterId,
      workspaceId,
    });
  };

  const onPrimary = () => {
    if (encounterDone) {
      navigation.replace('ContextFreeColorPick', {
        workspaceId,
        userAId,
        userBId,
        encounterType,
      });
    } else {
      void goToNextMatch();
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ConfettiCannon count={100} origin={{ x: 200, y: 0 }} fadeOut />
      <View style={styles.hero}>
        <Text style={styles.winText}>Gana {winnerName}</Text>
        {winnerAvatarUri ? (
          <Image
            source={{ uri: winnerAvatarUri }}
            style={styles.winnerAvatar}
            resizeMode="contain"
          />
        ) : null}
        {encounterType === 'bo3' ? (
          <Text style={styles.score}>
            {nameA}: {winsA} · {nameB}: {winsB}
          </Text>
        ) : null}
      </View>

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.primaryBtn, creating && styles.btnDisabled]}
          disabled={creating}
          onPress={onPrimary}
        >
          <Text style={styles.primaryTxt}>{primaryLabel}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.secondaryBtn}
          onPress={() =>
            navigation.navigate('ContextFreeEncounter', { workspaceId, userAId, userBId })
          }
        >
          <Text style={styles.secondaryTxt}>Volver</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.secondaryBtn}
          onPress={() => navigation.navigate('ContextFreeMatches', { workspaceId })}
        >
          <Text style={styles.secondaryTxt}>Volver a partidas sin contexto</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', padding: 24 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  hero: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  winText: { fontSize: 30, fontWeight: '900', color: '#111', textAlign: 'center', marginBottom: 16 },
  winnerAvatar: { width: 140, height: 140, borderRadius: 70, marginBottom: 16 },
  score: { fontSize: 16, color: '#374151', marginTop: 4 },
  actions: { gap: 10 },
  primaryBtn: {
    backgroundColor: '#3B82F6',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryTxt: { color: '#fff', fontWeight: '700', fontSize: 16 },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondaryTxt: { color: '#374151', fontWeight: '700' },
  btnDisabled: { opacity: 0.5 },
});

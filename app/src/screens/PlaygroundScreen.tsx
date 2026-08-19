import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { defaultAvatarPublicUrl } from '../lib/avatarUrl';
import PlayerAvatar from '../components/PlayerAvatar';

type Props = NativeStackScreenProps<MainStackParamList, 'Playground'>;

const COOLDOWN_HOURS = 4;
const AVATAR_REUSE_HOURS = 24;

type PresenceRow = {
  id: string;
  user_id: string;
  is_shiny: boolean;
  avatar_assigned_at: string | null;
  last_match_ended_at: string | null;
  joined_at: string;
  avatar_id: string | null;
  default_avatars: {
    storage_path: string;
    storage_path_shiny: string | null;
    name: string;
  } | null;
  users: {
    username: string;
    display_name: string;
  } | null;
};

function isOnCooldown(row: PresenceRow): boolean {
  if (!row.last_match_ended_at) return false;
  const ended = new Date(row.last_match_ended_at).getTime();
  return Date.now() - ended < COOLDOWN_HOURS * 60 * 60 * 1000;
}

function cooldownRemainingLabel(row: PresenceRow): string {
  if (!row.last_match_ended_at) return '';
  const ended = new Date(row.last_match_ended_at).getTime();
  const remainMs = COOLDOWN_HOURS * 60 * 60 * 1000 - (Date.now() - ended);
  if (remainMs <= 0) return '';
  const totalMin = Math.ceil(remainMs / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function pickRandomAvatar(): Promise<{ avatarId: string | null; isShiny: boolean }> {
  const { data } = await supabase
    .from('default_avatars')
    .select('id')
    .eq('is_active', true)
    .order('id');
  if (!data || data.length === 0) return { avatarId: null, isShiny: false };
  const idx = Math.floor(Math.random() * data.length);
  return { avatarId: data[idx]!.id, isShiny: Math.random() < 1 / 4096 };
}

export default function PlaygroundScreen({ navigation, route }: Props) {
  const { workspaceId } = route.params;
  const { user } = useAuth();
  const [presence, setPresence] = useState<PresenceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const initialFocusRef = useRef(true);

  const autoJoin = useCallback(async () => {
    if (!user?.id) return;
    const now = new Date().toISOString();

    const { data: ownData } = await supabase
      .from('playground_presence')
      .select('avatar_id, is_shiny, avatar_assigned_at')
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    const existingRow = ownData as {
      avatar_id: string | null;
      is_shiny: boolean;
      avatar_assigned_at: string | null;
    } | null;

    const reuseAvatar =
      existingRow?.avatar_id != null &&
      existingRow.avatar_assigned_at != null &&
      Date.now() - new Date(existingRow.avatar_assigned_at).getTime() <
        AVATAR_REUSE_HOURS * 60 * 60 * 1000;

    let avatarId: string | null;
    let isShiny: boolean;
    let avatarAssignedAt: string;

    if (reuseAvatar) {
      avatarId = existingRow!.avatar_id;
      isShiny = existingRow!.is_shiny;
      avatarAssignedAt = existingRow!.avatar_assigned_at!;
    } else {
      const picked = await pickRandomAvatar();
      avatarId = picked.avatarId;
      isShiny = picked.isShiny;
      avatarAssignedAt = now;
    }

    await supabase.from('playground_presence').upsert(
      {
        user_id: user.id,
        workspace_id: workspaceId,
        avatar_id: avatarId,
        is_shiny: isShiny,
        avatar_assigned_at: avatarAssignedAt,
        is_active: true,
        left_at: null,
      },
      { onConflict: 'user_id,workspace_id' }
    );
  }, [workspaceId, user?.id]);

  const load = useCallback(async () => {
    if (!user?.id) return;

    const { data, error } = await supabase
      .from('playground_presence')
      .select(
        `
        id, user_id, is_shiny, avatar_assigned_at, last_match_ended_at, joined_at, avatar_id,
        default_avatars ( storage_path, storage_path_shiny, name ),
        users!playground_presence_user_id_fkey ( username, display_name )
      `
      )
      .eq('workspace_id', workspaceId)
      .eq('is_active', true)
      .order('joined_at', { ascending: true });

    if (error) {
      if (__DEV__) console.error('playground_presence load error:', error);
      return;
    }

    const rows = (data ?? []) as unknown as PresenceRow[];
    const cutoffMs = COOLDOWN_HOURS * 60 * 60 * 1000;
    const now = Date.now();

    const activeRows = rows.filter((r) => {
      const ref = r.last_match_ended_at ?? r.joined_at;
      return now - new Date(ref).getTime() < cutoffMs;
    });

    setPresence(activeRows);
    return activeRows;
  }, [workspaceId, user?.id]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const first = initialFocusRef.current;
        if (first) {
          setLoading(true);
          initialFocusRef.current = false;
        }
        await load();
        if (!cancelled) {
          await autoJoin();
          await load();
        }
        if (!cancelled && first) setLoading(false);
      })();
      return () => { cancelled = true; };
    }, [load, autoJoin, user?.id])
  );

  useLayoutEffect(() => {
    if (!user?.id) return;
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          onPress={() =>
            navigation.navigate('MyProfile', { from: 'Playground', workspaceId })
          }
          hitSlop={12}
          style={{ marginRight: 4, justifyContent: 'center', alignItems: 'center' }}
          accessibilityRole="button"
          accessibilityLabel="Mi perfil"
        >
          <PlayerAvatar userId={user.id} size="small" withColorBorder={false} outsideEvent />
        </Pressable>
      ),
    });
  }, [navigation, user?.id, workspaceId]);

  const handleLeave = () => {
    if (!user?.id) return;
    Alert.alert('Salir de la sala', '¿Querés salir de la sala de partidas sin contexto?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Salir',
        style: 'destructive',
        onPress: async () => {
          setLeaving(true);
          const { error } = await supabase
            .from('playground_presence')
            .update({ is_active: false, left_at: new Date().toISOString() })
            .eq('user_id', user.id)
            .eq('workspace_id', workspaceId);
          if (error) {
            setLeaving(false);
            Alert.alert('Error', 'No se pudo salir de la sala.');
            return;
          }
          navigation.goBack();
        },
      },
    ]);
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const renderAvatarImg = (row: PresenceRow, size: number) => {
    const da = row.default_avatars;
    if (!da) return null;
    const path =
      row.is_shiny && da.storage_path_shiny ? da.storage_path_shiny : da.storage_path;
    const url = defaultAvatarPublicUrl(path);
    if (!url) return null;
    return (
      <Image
        source={{ uri: url }}
        style={{ width: size, height: size }}
        resizeMode="contain"
      />
    );
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  const totalPresent = presence.length;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <Text style={styles.title}>Juego libre</Text>
        <Text style={styles.subtitle}>
          Jugadores presentes: {totalPresent}
        </Text>
      </View>

      <View style={styles.block}>
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={() => navigation.navigate('ContextFreeMatches', { workspaceId })}
        >
          <Text style={styles.primaryBtnTxt}>Enfrentamientos</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.dangerBtn, leaving && styles.disabledBtn]}
          onPress={handleLeave}
          disabled={leaving}
        >
          {leaving ? (
            <ActivityIndicator color="#DC2626" />
          ) : (
            <Text style={styles.dangerTxt}>Salir de la sala</Text>
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.block}>
        <Text style={styles.blockTitle}>Participantes</Text>
        {presence.length === 0 ? (
          <Text style={styles.muted}>No hay nadie en la sala todavía.</Text>
        ) : null}
        {presence.map((row) => {
          const isSelf = row.user_id === user?.id;
          const cooldown = !isSelf && isOnCooldown(row);
          const displayName =
            row.users?.display_name || row.users?.username || 'Jugador';

          const onPress = () => {
            if (isSelf) {
              navigation.navigate('MyProfile', { from: 'Playground', workspaceId });
            } else {
              navigation.navigate('MemberProfile', { userId: row.user_id, workspaceId, from: 'Playground' });
            }
          };

          return (
            <TouchableOpacity
              key={row.user_id}
              style={styles.participantRow}
              onPress={onPress}
              activeOpacity={0.7}
            >
              <View style={styles.avatarWrap}>
                {renderAvatarImg(row, 44)}
              </View>
              <View style={styles.participantBody}>
                <View style={styles.participantNameRow}>
                  <Text style={styles.participantName}>{displayName}</Text>
                </View>
                {row.default_avatars ? (
                  <Text style={styles.pokemonName}>
                    {row.default_avatars.name}
                    {row.is_shiny ? ' ✨' : ''}
                  </Text>
                ) : null}
                {cooldown ? (
                  <Text style={styles.cooldownText}>
                    Cooldown: disponible en {cooldownRemainingLabel(row)}
                  </Text>
                ) : null}
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#fff' },
  content: { paddingBottom: 32 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  header: {
    alignItems: 'center',
    paddingVertical: 24,
    paddingHorizontal: 24,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  title: { fontSize: 22, fontWeight: '700', color: '#111', marginBottom: 6, textAlign: 'center' },
  subtitle: { fontSize: 14, color: '#666' },
  block: { paddingHorizontal: 24, paddingTop: 18 },
  blockTitle: { fontSize: 16, fontWeight: '700', color: '#111', marginBottom: 10 },
  muted: { color: '#666', fontSize: 14 },
  primaryBtn: {
    backgroundColor: '#3B82F6',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  primaryBtnTxt: { color: '#fff', fontSize: 15, fontWeight: '600' },
  dangerBtn: {
    backgroundColor: '#FEE2E2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 4,
  },
  dangerTxt: { color: '#DC2626', fontSize: 15, fontWeight: '600' },
  disabledBtn: { opacity: 0.5 },
  participantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    backgroundColor: '#fafafa',
  },
  avatarWrap: {
    width: 44,
    height: 44,
    marginRight: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  participantBody: { flex: 1, minWidth: 0 },
  participantNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  participantName: { fontSize: 15, fontWeight: '700', color: '#111' },
  pokemonName: { fontSize: 13, color: '#6B7280', marginTop: 2 },
  cooldownText: { fontSize: 12, color: '#EF4444', marginTop: 2 },
});

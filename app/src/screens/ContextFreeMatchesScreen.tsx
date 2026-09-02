import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  RefreshControl,
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
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import { defaultAvatarPublicUrl } from '../lib/avatarUrl';
import { expireStalePresence, splitPresenceByCooldown } from '../lib/playgroundPresence';

type Props = NativeStackScreenProps<MainStackParamList, 'ContextFreeMatches'>;

type PresenceRow = {
  user_id: string;
  is_shiny: boolean;
  last_match_ended_at: string | null;
  joined_at: string;
  default_avatars: {
    storage_path: string;
    storage_path_shiny: string | null;
  } | null;
  users: {
    username: string;
    display_name: string;
  } | null;
};

type Pair = { a: PresenceRow; b: PresenceRow };

function userName(row: PresenceRow): string {
  return row.users?.display_name || row.users?.username || 'Jugador';
}

function avatarUrl(row: PresenceRow): string | null {
  const da = row.default_avatars;
  if (!da) return null;
  const path = row.is_shiny && da.storage_path_shiny ? da.storage_path_shiny : da.storage_path;
  return defaultAvatarPublicUrl(path);
}

function buildPairs(rows: PresenceRow[], currentUserId: string | undefined): Pair[] {
  const pairs: Pair[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const rowI = rows[i]!;
      const rowJ = rows[j]!;
      if (currentUserId && rowJ.user_id === currentUserId) {
        pairs.push({ a: rowJ, b: rowI });
      } else {
        pairs.push({ a: rowI, b: rowJ });
      }
    }
  }
  return pairs;
}

export default function ContextFreeMatchesScreen({ navigation, route }: Props) {
  const { workspaceId } = route.params;
  const { user } = useAuth();
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const initialFocusRef = useRef(true);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'Playground', { workspaceId }),
    });
  }, [navigation, workspaceId]);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('playground_presence')
      .select(
        `
        user_id, is_shiny, last_match_ended_at, joined_at,
        default_avatars ( storage_path, storage_path_shiny ),
        users!playground_presence_user_id_fkey ( username, display_name )
      `
      )
      .eq('workspace_id', workspaceId)
      .eq('is_active', true)
      .order('joined_at', { ascending: true });

    if (error) {
      if (__DEV__) console.error('ContextFreeMatches load error:', error);
      return;
    }

    const rows = (data ?? []) as unknown as PresenceRow[];
    const { active: activeRows, stale } = splitPresenceByCooldown(rows);

    setPairs(buildPairs(activeRows, user?.id));

    if (stale.length > 0) {
      void expireStalePresence(workspaceId, stale.map((r) => r.user_id));
    }
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
        if (!cancelled && first) setLoading(false);
      })();
      return () => { cancelled = true; };
    }, [load])
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.listContent}
      data={pairs}
      keyExtractor={(item) => `${item.a.user_id}-${item.b.user_id}`}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
      ListEmptyComponent={
        <Text style={styles.empty}>
          No hay suficientes jugadores presentes para generar pares.
        </Text>
      }
      renderItem={({ item }) => {
        const urlA = avatarUrl(item.a);
        const urlB = avatarUrl(item.b);
        return (
          <TouchableOpacity
            style={styles.card}
            activeOpacity={0.7}
            onPress={() =>
              navigation.navigate('ContextFreeEncounter', {
                workspaceId,
                userAId: item.a.user_id,
                userBId: item.b.user_id,
              })
            }
          >
            <View style={styles.compactRow}>
              <View style={styles.inlinePlayer}>
                {urlA ? (
                  <Image source={{ uri: urlA }} style={styles.avatar} resizeMode="contain" />
                ) : (
                  <View style={styles.avatarPh} />
                )}
                <Text style={styles.name} numberOfLines={1}>{userName(item.a)}</Text>
              </View>
              <View style={styles.vsWrap}>
                <Text style={styles.vs}>vs</Text>
              </View>
              <View style={[styles.inlinePlayer, styles.inlinePlayerRight]}>
                <Text style={styles.nameRight} numberOfLines={1}>{userName(item.b)}</Text>
                {urlB ? (
                  <Image source={{ uri: urlB }} style={styles.avatar} resizeMode="contain" />
                ) : (
                  <View style={styles.avatarPh} />
                )}
              </View>
            </View>
          </TouchableOpacity>
        );
      }}
    />
  );
}

const AVATAR_SIZE = 36;

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: '#fff' },
  listContent: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 32 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  empty: {
    fontSize: 15,
    color: '#9CA3AF',
    textAlign: 'center',
    paddingTop: 40,
    paddingHorizontal: 32,
  },
  card: {
    backgroundColor: '#fafafa',
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 8,
  },
  compactRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  inlinePlayer: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 8 },
  inlinePlayerRight: { justifyContent: 'flex-end' },
  avatar: { width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: AVATAR_SIZE / 2 },
  avatarPh: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: '#E5E7EB',
  },
  name: { fontSize: 12, color: '#111', fontWeight: '700', flexShrink: 1 },
  nameRight: { fontSize: 12, color: '#111', fontWeight: '700', textAlign: 'right', flexShrink: 1 },
  vsWrap: { minWidth: 40, alignItems: 'center' },
  vs: { color: '#6B7280', fontWeight: '700', fontSize: 13 },
});

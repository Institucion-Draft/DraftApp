import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  RefreshControl,
  TouchableOpacity,
  Pressable,
  ActivityIndicator,
  Alert,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import { avatarPublicUrl } from '../lib/avatarUrl';
import PlayerAvatar from '../components/PlayerAvatar';

type Props = NativeStackScreenProps<MainStackParamList, 'WorkspaceDetail'>;

type WorkspaceRow = {
  id: string;
  name: string;
  description: string | null;
  avatar_path: string | null;
};

type UserEmbed = {
  username: string;
  display_name: string;
  custom_avatar_path: string | null;
  default_avatars: { storage_path: string } | { storage_path: string }[] | null;
};

type MemberRow = {
  role: 'organizer' | 'member';
  user_id: string;
  users: UserEmbed | UserEmbed[] | null;
};

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

export default function WorkspaceDetailScreen({ navigation, route }: Props) {
  const { workspaceId } = route.params;
  const { user } = useAuth();
  const [workspace, setWorkspace] = useState<WorkspaceRow | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [pendingJoinCount, setPendingJoinCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const initialFocusRef = useRef(true);

  const load = useCallback(async () => {
    if (!user?.id) return;

    const { data: ws, error: wsError } = await supabase
      .from('workspaces')
      .select('id, name, description, avatar_path')
      .eq('id', workspaceId)
      .maybeSingle();

    if (wsError) {
      Alert.alert('Error', 'No se pudo cargar el grupo de Draft.');
      setWorkspace(null);
      setMembers([]);
      setPendingJoinCount(0);
      return;
    }
    setWorkspace(ws);

    const { data: myRow } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .maybeSingle();

    const organizer = myRow?.role === 'organizer';
    setIsOrganizer(organizer);

    const pendingPromise = organizer
      ? supabase
          .from('workspace_join_requests')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId)
          .eq('status', 'pending')
      : Promise.resolve({ count: 0 as number | null, error: null });

    const { data: memData, error: memError } = await supabase
      .from('workspace_members')
      .select(
        `
        role,
        user_id,
        users!workspace_members_user_id_fkey (
          username,
          display_name,
          custom_avatar_path,
          default_avatars (storage_path)
        )
      `
      )
      .eq('workspace_id', workspaceId)
      .order('joined_at', { ascending: true });

    const pendingRes = await pendingPromise;
    if (!pendingRes.error) {
      setPendingJoinCount(pendingRes.count ?? 0);
    } else {
      setPendingJoinCount(0);
    }

    if (memError) {
      if (__DEV__) {
        console.error('Error cargando miembros del workspace:', memError);
      }
      Alert.alert(
        'Error',
        memError.message ?? 'No se pudieron cargar los miembros.'
      );
      setMembers([]);
      return;
    }

    setMembers((memData ?? []) as MemberRow[]);
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
      return () => {
        cancelled = true;
      };
    }, [load])
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      title: workspace?.name ?? 'Detalle del grupo',
      headerLeft: hierarchicalHeaderBack(navigation, 'WorkspacesList'),
      headerRight:
        user?.id != null
          ? () => (
              <Pressable
                onPress={() =>
                  navigation.navigate('MyProfile', {
                    from: 'WorkspaceDetail',
                    workspaceId,
                  })
                }
                hitSlop={12}
                style={styles.headerAvatarBtn}
                accessibilityRole="button"
                accessibilityLabel="Mi perfil"
              >
                <PlayerAvatar
                  userId={user.id}
                  size="small"
                  withColorBorder={false}
                  outsideEvent
                />
              </Pressable>
            )
          : undefined,
    });
  }, [navigation, workspace?.name, user?.id, workspaceId]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const placeholder = (label: string) => {
    Alert.alert('Próximamente', `${label} estará disponible pronto.`);
  };

  const wsAvatar = workspace ? avatarPublicUrl(workspace.avatar_path) : null;

  if (loading && !workspace) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  if (!workspace) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>No se encontró el grupo.</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      <View style={styles.hero}>
        {wsAvatar ? (
          <Image source={{ uri: wsAvatar }} style={styles.heroAvatar} />
        ) : (
          <View style={[styles.heroAvatar, styles.heroAvatarPh]}>
            <Text style={styles.heroAvatarLetter}>
              {workspace.name.slice(0, 1).toUpperCase()}
            </Text>
          </View>
        )}
        <Text style={styles.heroTitle}>{workspace.name}</Text>
        {workspace.description?.trim() ? (
          <Text style={styles.heroDesc}>{workspace.description.trim()}</Text>
        ) : (
          <Text style={styles.muted}>Sin descripción.</Text>
        )}
      </View>

      <View style={styles.memberActions}>
        <TouchableOpacity
          style={styles.memberBtn}
          onPress={() => navigation.navigate('EventsList', { workspaceId })}
        >
          <Text style={styles.memberBtnText}>Ver eventos</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.memberBtn}
          onPress={() => navigation.navigate('CubesList', { workspaceId })}
        >
          <Text style={styles.memberBtnText}>Ver cubos</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.memberBtn}
          onPress={() => navigation.navigate('VenuesList', { workspaceId })}
        >
          <Text style={styles.memberBtnText}>Ver sedes</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.memberBtn}
          onPress={() => navigation.navigate('Playground', { workspaceId })}
        >
          <Text style={styles.memberBtnText}>Partidas sin contexto</Text>
        </TouchableOpacity>
      </View>

      {isOrganizer ? (
        <View style={styles.orgSection}>
          <Text style={styles.sectionTitle}>Acciones de organizador</Text>
          <TouchableOpacity
            style={styles.orgBtn}
            onPress={() =>
              navigation.navigate('GenerateInvite', { workspaceId })
            }
          >
            <Text style={styles.orgBtnText}>Generar link de invitación</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.orgBtn}
            onPress={() =>
              navigation.navigate('IncomingJoinRequests', { workspaceId })
            }
          >
            <View style={styles.orgBtnRow}>
              <Text style={styles.orgBtnText}>Ver solicitudes pendientes</Text>
              {pendingJoinCount > 0 ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{pendingJoinCount}</Text>
                </View>
              ) : null}
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.orgBtn}
            onPress={() => navigation.navigate('CreateEvent', { workspaceId })}
          >
            <Text style={styles.orgBtnText}>Crear evento</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <Text style={styles.sectionTitle}>Miembros ({members.length})</Text>
      {members.map((m) => {
        const u = relationOne(m.users);
        const label = u?.display_name || u?.username || 'Sin nombre';
        const isSelf = user?.id != null && m.user_id === user.id;
        const rowInner = (
          <>
            <PlayerAvatar
              userId={m.user_id}
              size="small"
              withColorBorder={false}
              outsideEvent
              style={{ marginRight: 12 }}
            />
            <View style={styles.memberBody}>
              <Text style={styles.memberName}>{label}</Text>
              <Text style={styles.memberRole}>
                {m.role === 'organizer' ? 'Organizador' : 'Miembro'}
              </Text>
            </View>
          </>
        );
        if (isSelf) {
          return (
            <TouchableOpacity
              key={m.user_id}
              style={styles.memberRow}
              activeOpacity={0.7}
              onPress={() =>
                navigation.navigate('MyProfile', {
                  from: 'WorkspaceDetail',
                  workspaceId,
                })
              }
              accessibilityRole="button"
              accessibilityLabel="Mi perfil"
            >
              {rowInner}
            </TouchableOpacity>
          );
        }
        return (
          <TouchableOpacity
            key={m.user_id}
            style={styles.memberRow}
            activeOpacity={0.7}
            onPress={() =>
              navigation.navigate('MemberProfile', { userId: m.user_id, workspaceId })
            }
            accessibilityRole="button"
            accessibilityLabel={`Perfil de ${label}`}
          >
            {rowInner}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  headerAvatarBtn: {
    marginRight: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scroll: {
    flex: 1,
    backgroundColor: '#fff',
  },
  scrollContent: {
    paddingBottom: 32,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  hero: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 20,
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  heroAvatar: {
    width: 88,
    height: 88,
    borderRadius: 16,
    marginBottom: 12,
    backgroundColor: '#f3f4f6',
  },
  heroAvatarPh: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E0E7FF',
  },
  heroAvatarLetter: {
    fontSize: 36,
    fontWeight: '700',
    color: '#4338CA',
  },
  heroTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111',
    textAlign: 'center',
    marginBottom: 8,
  },
  heroDesc: {
    fontSize: 15,
    color: '#666',
    textAlign: 'center',
    lineHeight: 22,
  },
  memberActions: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 8,
  },
  memberBtn: {
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
  memberBtnText: {
    color: '#374151',
    fontSize: 15,
    fontWeight: '600',
  },
  muted: {
    fontSize: 15,
    color: '#666',
    textAlign: 'center',
  },
  orgSection: {
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111',
    marginBottom: 12,
    paddingHorizontal: 24,
    marginTop: 20,
  },
  orgBtn: {
    backgroundColor: '#EFF6FF',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  orgBtnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  orgBtnText: {
    color: '#3B82F6',
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  badge: {
    marginLeft: 10,
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#DC2626',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f0f0f0',
  },
  memberBody: {
    flex: 1,
    minWidth: 0,
  },
  memberName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111',
  },
  memberRole: {
    fontSize: 13,
    color: '#666',
    marginTop: 2,
  },
});

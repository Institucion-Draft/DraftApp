import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Image,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { avatarPublicUrl } from '../lib/avatarUrl';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';

type Props = NativeStackScreenProps<MainStackParamList, 'IncomingJoinRequests'>;

type UserEmbed = {
  username: string;
  display_name: string;
  custom_avatar_path: string | null;
  default_avatars: { storage_path: string } | { storage_path: string }[] | null;
};

type RequestRow = {
  id: string;
  user_id: string;
  message: string | null;
  created_at: string;
  applicant: UserEmbed | UserEmbed[] | null;
};

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

function applicantAvatarUri(applicant: UserEmbed | null): string | null {
  if (!applicant) return null;
  const da = relationOne(applicant.default_avatars);
  return (
    avatarPublicUrl(applicant.custom_avatar_path) ??
    avatarPublicUrl(da?.storage_path ?? null)
  );
}

export default function IncomingJoinRequestsScreen({ route, navigation }: Props) {
  const { workspaceId } = route.params;
  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'WorkspaceDetail', { workspaceId }),
    });
  }, [navigation, workspaceId]);
  const { user } = useAuth();
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const initialFocusRef = useRef(true);

  const load = useCallback(async () => {
    if (!user?.id) {
      setRows([]);
      return;
    }

    const { data, error } = await supabase
      .from('workspace_join_requests')
      .select(
        `
        id,
        user_id,
        message,
        created_at,
        applicant:users!workspace_join_requests_user_id_fkey (
          username,
          display_name,
          custom_avatar_path,
          default_avatars (storage_path)
        )
      `
      )
      .eq('workspace_id', workspaceId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });

    if (error) {
      Alert.alert('Error', 'No se pudieron cargar las solicitudes.');
      setRows([]);
      return;
    }

    setRows((data ?? []) as RequestRow[]);
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

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('es-AR', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  const updateStatus = async (id: string, status: 'approved' | 'rejected') => {
    if (!user?.id) return;
    setActingId(id);
    const { error } = await supabase
      .from('workspace_join_requests')
      .update({
        status,
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id);
    setActingId(null);

    if (error) {
      Alert.alert('Error', error.message ?? 'No se pudo actualizar la solicitud.');
      return;
    }

    await load();
  };

  const renderItem = ({ item }: { item: RequestRow }) => {
    const applicant = relationOne(item.applicant);
    const label = applicant?.username ?? applicant?.display_name ?? 'Usuario';
    const uri = applicantAvatarUri(applicant);
    const busy = actingId === item.id;

    return (
      <View style={styles.card}>
        <View style={styles.cardTop}>
          {uri ? (
            <Image source={{ uri }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarPh]}>
              <Text style={styles.avatarTxt}>{label.slice(0, 1).toUpperCase()}</Text>
            </View>
          )}
          <View style={styles.cardBody}>
            <Text style={styles.username}>{label}</Text>
            <Text style={styles.date}>{formatDate(item.created_at)}</Text>
            {item.message?.trim() ? (
              <Text style={styles.msg}>“{item.message.trim()}”</Text>
            ) : (
              <Text style={styles.noMsg}>Sin mensaje</Text>
            )}
          </View>
        </View>
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.btn, styles.btnReject]}
            disabled={busy}
            onPress={() => {
              void updateStatus(item.id, 'rejected');
            }}
          >
            <Text style={styles.btnRejectText}>
              {busy ? '…' : 'Rechazar'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, styles.btnApprove]}
            disabled={busy}
            onPress={() => {
              void updateStatus(item.id, 'approved');
            }}
          >
            <Text style={styles.btnApproveText}>
              {busy ? '…' : 'Aprobar'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  return (
    <FlatList
      data={rows}
      keyExtractor={(it) => it.id}
      renderItem={renderItem}
      contentContainerStyle={
        rows.length === 0 ? styles.listEmpty : styles.listContent
      }
      ListEmptyComponent={
        <Text style={styles.empty}>No hay solicitudes pendientes.</Text>
      }
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    />
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  listContent: {
    padding: 16,
    paddingBottom: 32,
  },
  listEmpty: {
    flexGrow: 1,
    padding: 24,
  },
  empty: {
    textAlign: 'center',
    color: '#666',
    fontSize: 15,
    marginTop: 48,
  },
  card: {
    backgroundColor: '#fafafa',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#eee',
    padding: 14,
    marginBottom: 12,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 10,
    marginRight: 12,
    backgroundColor: '#f3f4f6',
  },
  avatarPh: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E5E7EB',
  },
  avatarTxt: {
    fontSize: 20,
    fontWeight: '700',
    color: '#374151',
  },
  cardBody: {
    flex: 1,
    minWidth: 0,
  },
  username: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111',
  },
  date: {
    fontSize: 13,
    color: '#666',
    marginTop: 4,
  },
  msg: {
    fontSize: 14,
    color: '#444',
    marginTop: 8,
    lineHeight: 20,
    fontStyle: 'italic',
  },
  noMsg: {
    fontSize: 13,
    color: '#999',
    marginTop: 8,
  },
  actions: {
    flexDirection: 'row',
    marginTop: 14,
    justifyContent: 'flex-end',
  },
  btn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginLeft: 10,
    minWidth: 100,
    alignItems: 'center',
  },
  btnReject: {
    backgroundColor: '#FEE2E2',
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  btnRejectText: {
    color: '#DC2626',
    fontWeight: '600',
    fontSize: 14,
  },
  btnApprove: {
    backgroundColor: '#3B82F6',
  },
  btnApproveText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
});

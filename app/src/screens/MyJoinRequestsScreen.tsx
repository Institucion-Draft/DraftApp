import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { MainStackParamList } from '../navigation/mainStackParams';
import type { WorkspaceJoinRequestStatus } from '../lib/database.types';

type Props = NativeStackScreenProps<MainStackParamList, 'MyJoinRequests'>;

type Row = {
  id: string;
  workspace_id: string;
  message: string | null;
  status: WorkspaceJoinRequestStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  workspaces: { name: string } | { name: string }[] | null;
  reviewer:
    | {
        username: string;
        display_name: string;
      }
    | {
        username: string;
        display_name: string;
      }[]
    | null;
};

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

function statusLabel(s: WorkspaceJoinRequestStatus): string {
  switch (s) {
    case 'pending':
      return 'Pendiente';
    case 'approved':
      return 'Aprobada';
    case 'rejected':
      return 'Rechazada';
    default:
      return s;
  }
}

function statusColors(s: WorkspaceJoinRequestStatus): {
  bg: string;
  text: string;
} {
  switch (s) {
    case 'pending':
      return { bg: '#FEF9C3', text: '#CA8A04' };
    case 'approved':
      return { bg: '#DCFCE7', text: '#15803D' };
    case 'rejected':
      return { bg: '#FEE2E2', text: '#DC2626' };
    default:
      return { bg: '#F3F4F6', text: '#666' };
  }
}

export default function MyJoinRequestsScreen(_props: Props) {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
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
        workspace_id,
        message,
        status,
        reviewed_by,
        reviewed_at,
        created_at,
        workspaces (name),
        reviewer:users!workspace_join_requests_reviewed_by_fkey (
          username,
          display_name
        )
      `
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      Alert.alert('Error', 'No se pudieron cargar tus solicitudes enviadas.');
      setRows([]);
      return;
    }

    setRows((data ?? []) as Row[]);
  }, [user?.id]);

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
      const d = new Date(iso);
      return d.toLocaleString('es-AR', {
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

  const renderItem = ({ item }: { item: Row }) => {
    const ws = relationOne(item.workspaces);
    const rev = relationOne(item.reviewer);
    const revLabel = rev
      ? rev.username || rev.display_name
      : item.reviewed_by
        ? 'Organizador'
        : null;
    const colors = statusColors(item.status);

    return (
      <View style={styles.card}>
        <Text style={styles.wsName}>{ws?.name ?? 'Grupo'}</Text>
        <Text style={styles.date}>Solicitud: {formatDate(item.created_at)}</Text>
        <View style={[styles.statusPill, { backgroundColor: colors.bg }]}>
          <Text style={[styles.statusText, { color: colors.text }]}>
            {statusLabel(item.status)}
          </Text>
        </View>
        {item.message?.trim() ? (
          <Text style={styles.message}>
            Tu mensaje: {item.message.trim()}
          </Text>
        ) : null}
        {item.reviewed_at && revLabel ? (
          <Text style={styles.reviewer}>
            Revisado por {revLabel} · {formatDate(item.reviewed_at)}
          </Text>
        ) : item.status !== 'pending' && item.reviewed_at ? (
          <Text style={styles.reviewer}>
            Revisado · {formatDate(item.reviewed_at)}
          </Text>
        ) : null}
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
        <Text style={styles.empty}>No enviaste solicitudes todavía.</Text>
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
    padding: 16,
    marginBottom: 12,
  },
  wsName: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111',
    marginBottom: 6,
  },
  date: {
    fontSize: 13,
    color: '#666',
    marginBottom: 8,
  },
  statusPill: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    marginBottom: 8,
  },
  statusText: {
    fontSize: 13,
    fontWeight: '700',
  },
  message: {
    fontSize: 14,
    color: '#444',
    lineHeight: 20,
    marginTop: 4,
  },
  reviewer: {
    fontSize: 13,
    color: '#666',
    marginTop: 8,
  },
});

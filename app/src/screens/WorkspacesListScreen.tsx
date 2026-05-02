import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  RefreshControl,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { avatarPublicUrl } from '../lib/avatarUrl';
import PlayerAvatar from '../components/PlayerAvatar';

type Props = NativeStackScreenProps<MainStackParamList, 'WorkspacesList'>;

type WorkspaceListItem = {
  role: 'organizer' | 'member';
  workspace: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    avatar_path: string | null;
  };
};

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

export default function WorkspacesListScreen({ navigation }: Props) {
  const { user, signOut } = useAuth();
  const [items, setItems] = useState<WorkspaceListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const initialLoadRef = useRef(true);

  const loadWorkspaces = useCallback(async () => {
    if (!user?.id) {
      setItems([]);
      return;
    }

    const { data, error } = await supabase
      .from('workspace_members')
      .select(
        `
        role,
        workspaces!inner (
          id,
          name,
          slug,
          description,
          avatar_path
        )
      `
      )
      .eq('user_id', user.id)
      .order('joined_at', { ascending: false });

    if (error) {
      Alert.alert('Error', 'No se pudieron cargar los grupos de Draft.');
      setItems([]);
      return;
    }

    type Row = {
      role: 'organizer' | 'member';
      workspaces:
        | WorkspaceListItem['workspace']
        | WorkspaceListItem['workspace'][]
        | null;
    };

    const rows = (data ?? []) as Row[];

    setItems(
      rows
        .map((r) => {
          const ws = relationOne(r.workspaces);
          return ws ? { role: r.role, workspace: ws } : null;
        })
        .filter((x): x is WorkspaceListItem => x != null)
    );
  }, [user?.id]);

  const loadAll = useCallback(async () => {
    await loadWorkspaces();
  }, [loadWorkspaces]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const isFirst = initialLoadRef.current;
        if (isFirst) {
          setLoading(true);
          initialLoadRef.current = false;
        }
        await loadAll();
        if (!cancelled && isFirst) setLoading(false);
      })();
      return () => {
        cancelled = true;
      };
    }, [loadAll])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  }, [loadAll]);

  const openMenu = () => {
    Alert.alert('Cuenta', undefined, [
      {
        text: 'Cerrar sesión',
        style: 'destructive',
        onPress: () => {
          void signOut();
        },
      },
      { text: 'Cancelar', style: 'cancel' },
    ]);
  };

  const renderHeader = () => (
    <View style={styles.topBar}>
      <View style={styles.avatarWrap}>
        {user?.id ? (
          <PlayerAvatar
            userId={user.id}
            size="medium"
            withColorBorder={false}
            outsideEvent
          />
        ) : null}
      </View>
      <Text style={styles.screenTitle}>Tus grupos de Draft</Text>
      <TouchableOpacity
        onPress={() => navigation.navigate('SearchWorkspaces')}
        style={styles.searchButton}
        accessibilityRole="button"
        accessibilityLabel="Buscar grupos de Draft"
      >
        <Text style={styles.searchIcon}>🔍</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => navigation.navigate('JoinByCode')}
        style={styles.codeButton}
        accessibilityRole="button"
        accessibilityLabel="Unirme con código"
      >
        <Text style={styles.codeIcon}>🔑</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={openMenu}
        style={styles.menuButton}
        accessibilityRole="button"
        accessibilityLabel="Menú de cuenta"
      >
        <Text style={styles.menuIcon}>⋯</Text>
      </TouchableOpacity>
    </View>
  );

  const renderItem = ({ item }: { item: WorkspaceListItem }) => {
    const { workspace, role } = item;
    const desc = workspace.description?.trim();
    const shortDesc =
      desc && desc.length > 100 ? `${desc.slice(0, 100)}…` : desc ?? '';
    const wsAvatar = avatarPublicUrl(workspace.avatar_path);

    return (
      <TouchableOpacity
        style={styles.card}
        activeOpacity={0.7}
        onPress={() =>
          navigation.navigate('WorkspaceDetail', { workspaceId: workspace.id })
        }
      >
        <View style={styles.cardRow}>
          {wsAvatar ? (
            <Image source={{ uri: wsAvatar }} style={styles.cardAvatar} />
          ) : (
            <View style={[styles.cardAvatar, styles.cardAvatarPlaceholder]}>
              <Text style={styles.cardAvatarLetter}>
                {workspace.name.slice(0, 1).toUpperCase()}
              </Text>
            </View>
          )}
          <View style={styles.cardBody}>
            <Text style={styles.cardTitle}>{workspace.name}</Text>
            {shortDesc ? (
              <Text style={styles.cardDesc} numberOfLines={2}>
                {shortDesc}
              </Text>
            ) : null}
            <View style={styles.rolePill}>
              <Text style={styles.rolePillText}>
                {role === 'organizer' ? 'Organizador' : 'Miembro'}
              </Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmpty = () => (
    <View style={styles.emptyWrap}>
      <Text style={styles.emptyTitle}>Todavía no tenés grupos de Draft</Text>
      <Text style={styles.emptySubtitle}>
        Creá uno para tu grupo o unite a uno que ya exista.
      </Text>
      <TouchableOpacity
        style={styles.primaryBtn}
        onPress={() => navigation.navigate('CreateWorkspace')}
      >
        <Text style={styles.primaryBtnText}>Crear grupo de Draft</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.secondaryBtn}
        onPress={() => navigation.navigate('SearchWorkspaces')}
      >
        <Text style={styles.secondaryBtnText}>Buscar grupo de Draft</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.outlineAltBtn}
        onPress={() => navigation.navigate('JoinByCode')}
      >
        <Text style={styles.outlineAltBtnText}>Unirme con código</Text>
      </TouchableOpacity>
    </View>
  );

  const renderFooter = () =>
    items.length > 0 ? (
      <TouchableOpacity
        style={styles.footerBtn}
        onPress={() => navigation.navigate('CreateWorkspace')}
      >
        <Text style={styles.footerBtnText}>+ Nuevo grupo de Draft</Text>
      </TouchableOpacity>
    ) : null;

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        {renderHeader()}
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color="#3B82F6" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {renderHeader()}
      <FlatList
        data={items}
        keyExtractor={(it) => it.workspace.id}
        renderItem={renderItem}
        contentContainerStyle={
          items.length === 0 ? styles.listEmptyContainer : styles.listContent
        }
        ListEmptyComponent={renderEmpty}
        ListFooterComponent={renderFooter}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#fff',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  avatarWrap: {
    width: 48,
    height: 48,
    marginRight: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  screenTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    color: '#111',
  },
  searchButton: {
    padding: 8,
    marginRight: 0,
  },
  searchIcon: {
    fontSize: 20,
  },
  codeButton: {
    padding: 8,
    marginRight: 0,
  },
  codeIcon: {
    fontSize: 20,
  },
  menuButton: {
    padding: 8,
    marginRight: -4,
  },
  menuIcon: {
    fontSize: 22,
    color: '#374151',
    fontWeight: '700',
  },
  loadingBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 32,
  },
  listEmptyContainer: {
    flexGrow: 1,
    paddingHorizontal: 24,
  },
  card: {
    backgroundColor: '#fafafa',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#eee',
    padding: 14,
    marginBottom: 12,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  cardAvatar: {
    width: 48,
    height: 48,
    borderRadius: 10,
    marginRight: 12,
    backgroundColor: '#f3f4f6',
  },
  cardAvatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E0E7FF',
  },
  cardAvatarLetter: {
    fontSize: 20,
    fontWeight: '700',
    color: '#4338CA',
  },
  cardBody: {
    flex: 1,
    minWidth: 0,
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#111',
    marginBottom: 4,
  },
  cardDesc: {
    fontSize: 14,
    color: '#666',
    lineHeight: 20,
    marginBottom: 8,
  },
  rolePill: {
    alignSelf: 'flex-start',
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  rolePillText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#3B82F6',
  },
  emptyWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 48,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111',
    textAlign: 'center',
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 15,
    color: '#666',
    textAlign: 'center',
    marginBottom: 28,
    lineHeight: 22,
  },
  primaryBtn: {
    backgroundColor: '#3B82F6',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 8,
    width: '100%',
    alignItems: 'center',
    marginBottom: 12,
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: '#3B82F6',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 8,
    width: '100%',
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: '#3B82F6',
    fontSize: 16,
    fontWeight: '600',
  },
  outlineAltBtn: {
    borderWidth: 1,
    borderColor: '#9CA3AF',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 8,
    width: '100%',
    alignItems: 'center',
    marginTop: 12,
  },
  outlineAltBtnText: {
    color: '#374151',
    fontSize: 16,
    fontWeight: '600',
  },
  footerBtn: {
    marginTop: 8,
    paddingVertical: 16,
    alignItems: 'center',
  },
  footerBtnText: {
    color: '#3B82F6',
    fontSize: 16,
    fontWeight: '600',
  },
});

import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  FlatList,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  Modal,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import { avatarPublicUrl } from '../lib/avatarUrl';

type Props = NativeStackScreenProps<MainStackParamList, 'SearchWorkspaces'>;

type SearchWorkspaceRow = {
  id: string;
  name: string;
  description: string | null;
  avatar_path: string | null;
};

type ResultItem = SearchWorkspaceRow & {
  isMember: boolean;
  hasPendingRequest: boolean;
};

const JOIN_MSG_MAX = 500;
const SEARCH_DEBOUNCE_MS = 350;

function escapeIlikePattern(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export default function SearchWorkspacesScreen({ navigation }: Props) {
  const { user } = useAuth();
  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'WorkspacesList'),
    });
  }, [navigation]);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [results, setResults] = useState<ResultItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [joinModalVisible, setJoinModalVisible] = useState(false);
  const [joinWorkspace, setJoinWorkspace] = useState<SearchWorkspaceRow | null>(
    null
  );
  const [joinMessage, setJoinMessage] = useState('');
  const [joinSubmitting, setJoinSubmitting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const runSearch = useCallback(async () => {
    const q = debounced;
    if (!user?.id) {
      setResults([]);
      return;
    }
    if (q.length < 1) {
      setResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    const pattern = `%${escapeIlikePattern(q)}%`;

    const { data: rows, error } = await supabase
      .from('workspaces')
      .select('id, name, description, avatar_path')
      .eq('is_public', true)
      .ilike('name', pattern)
      .order('name', { ascending: true })
      .limit(50);

    if (error) {
      setSearching(false);
      Alert.alert('Error', 'No se pudo buscar grupos de Draft.');
      setResults([]);
      return;
    }

    const list = (rows ?? []) as SearchWorkspaceRow[];
    const ids = list.map((w) => w.id);
    if (ids.length === 0) {
      setResults([]);
      setSearching(false);
      return;
    }

    const [memRes, reqRes] = await Promise.all([
      supabase
        .from('workspace_members')
        .select('workspace_id')
        .eq('user_id', user.id)
        .in('workspace_id', ids),
      supabase
        .from('workspace_join_requests')
        .select('workspace_id')
        .eq('user_id', user.id)
        .eq('status', 'pending')
        .in('workspace_id', ids),
    ]);

    if (memRes.error || reqRes.error) {
      setSearching(false);
      Alert.alert('Error', 'No se pudo cargar tu estado en los grupos de Draft.');
      setResults([]);
      return;
    }

    const memberSet = new Set(
      (memRes.data ?? []).map((r) => r.workspace_id as string)
    );
    const pendingSet = new Set(
      (reqRes.data ?? []).map((r) => r.workspace_id as string)
    );

    setResults(
      list.map((w) => ({
        ...w,
        isMember: memberSet.has(w.id),
        hasPendingRequest: pendingSet.has(w.id),
      }))
    );
    setSearching(false);
  }, [debounced, user?.id]);

  useEffect(() => {
    void runSearch();
  }, [runSearch]);

  const openJoinModal = (w: SearchWorkspaceRow) => {
    setJoinWorkspace(w);
    setJoinMessage('');
    setJoinModalVisible(true);
  };

  const closeJoinModal = () => {
    setJoinModalVisible(false);
    setJoinWorkspace(null);
    setJoinMessage('');
  };

  const confirmJoin = async () => {
    if (!user?.id || !joinWorkspace) return;
    if (joinMessage.length > JOIN_MSG_MAX) {
      Alert.alert(
        'Mensaje muy largo',
        `El mensaje no puede superar ${JOIN_MSG_MAX} caracteres.`
      );
      return;
    }

    setJoinSubmitting(true);
    const { error } = await supabase.from('workspace_join_requests').insert({
      workspace_id: joinWorkspace.id,
      user_id: user.id,
      message: joinMessage.trim() || null,
      status: 'pending',
    });
    setJoinSubmitting(false);

    if (error) {
      const msg = error.message?.toLowerCase() ?? '';
      const dup =
        error.code === '23505' ||
        msg.includes('duplicate') ||
        msg.includes('unique');
      if (dup) {
        Alert.alert(
          'Solicitud existente',
          'Ya tenés una solicitud pendiente para este grupo.'
        );
        closeJoinModal();
        void runSearch();
        return;
      }
      Alert.alert('Error', error.message ?? 'No se pudo enviar la solicitud.');
      return;
    }

    closeJoinModal();
    Alert.alert('Listo', 'Tu solicitud fue enviada.');
    void runSearch();
  };

  const renderItem = ({ item }: { item: ResultItem }) => {
    const uri = avatarPublicUrl(item.avatar_path);
    const desc = item.description?.trim();
    const short =
      desc && desc.length > 120 ? `${desc.slice(0, 120)}…` : desc ?? '';

    return (
      <View style={styles.card}>
        <View style={styles.cardRow}>
          {uri ? (
            <Image source={{ uri }} style={styles.cardAvatar} />
          ) : (
            <View style={[styles.cardAvatar, styles.cardAvatarPh]}>
              <Text style={styles.cardAvatarLetter}>
                {item.name.slice(0, 1).toUpperCase()}
              </Text>
            </View>
          )}
          <View style={styles.cardBody}>
            <Text style={styles.cardTitle}>{item.name}</Text>
            {short ? (
              <Text style={styles.cardDesc} numberOfLines={2}>
                {short}
              </Text>
            ) : null}
            {item.isMember ? (
              <View style={[styles.tag, styles.tagMember]}>
                <Text style={styles.tagMemberText}>Ya sos miembro</Text>
              </View>
            ) : item.hasPendingRequest ? (
              <View style={[styles.tag, styles.tagPending]}>
                <Text style={styles.tagPendingText}>Solicitud pendiente</Text>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.joinBtn}
                onPress={() => openJoinModal(item)}
              >
                <Text style={styles.joinBtnText}>Pedir unirse</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    );
  };

  const showHint = debounced.length === 0;

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.search}
        placeholder="Buscar por nombre…"
        placeholderTextColor="#999"
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
      />

      {searching ? (
        <View style={styles.searchingBox}>
          <ActivityIndicator color="#3B82F6" />
        </View>
      ) : null}

      {showHint ? (
        <View style={styles.hintBox}>
          <Text style={styles.hintText}>
            Escribí el nombre de un grupo de Draft público para buscarlo.
          </Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(it) => it.id}
          renderItem={renderItem}
          contentContainerStyle={
            results.length === 0 ? styles.listEmpty : styles.listContent
          }
          ListEmptyComponent={
            !searching ? (
              <Text style={styles.emptyText}>No hay resultados.</Text>
            ) : null
          }
          keyboardShouldPersistTaps="handled"
        />
      )}

      <Modal
        visible={joinModalVisible}
        animationType="slide"
        transparent
        onRequestClose={closeJoinModal}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              Unirte a {joinWorkspace?.name ?? '…'}
            </Text>
            <Text style={styles.modalHint}>
              Mensaje opcional para los organizadores (máx. {JOIN_MSG_MAX}{' '}
              caracteres).
            </Text>
            <TextInput
              style={styles.modalInput}
              value={joinMessage}
              onChangeText={setJoinMessage}
              placeholder="Ej.: Juego con ustedes los viernes…"
              placeholderTextColor="#999"
              multiline
              maxLength={JOIN_MSG_MAX}
              editable={!joinSubmitting}
            />
            <Text style={styles.modalCounter}>
              {joinMessage.length}/{JOIN_MSG_MAX}
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={closeJoinModal}
                disabled={joinSubmitting}
              >
                <Text style={styles.modalCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalConfirm,
                  joinSubmitting && styles.modalConfirmDisabled,
                ]}
                onPress={() => {
                  void confirmJoin();
                }}
                disabled={joinSubmitting}
              >
                {joinSubmitting ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.modalConfirmText}>Enviar solicitud</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  search: {
    marginHorizontal: 16,
    marginVertical: 12,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    backgroundColor: '#fafafa',
  },
  searchingBox: {
    paddingVertical: 8,
  },
  hintBox: {
    paddingHorizontal: 24,
    paddingTop: 24,
  },
  hintText: {
    fontSize: 15,
    color: '#666',
    textAlign: 'center',
    lineHeight: 22,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  listEmpty: {
    flexGrow: 1,
    paddingHorizontal: 24,
    justifyContent: 'center',
  },
  emptyText: {
    textAlign: 'center',
    color: '#666',
    fontSize: 15,
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
  cardAvatarPh: {
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
  tag: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    marginTop: 4,
  },
  tagMember: {
    backgroundColor: '#DCFCE7',
  },
  tagMemberText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#15803D',
  },
  tagPending: {
    backgroundColor: '#FEF9C3',
  },
  tagPendingText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#A16207',
  },
  joinBtn: {
    alignSelf: 'flex-start',
    marginTop: 6,
    backgroundColor: '#3B82F6',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  joinBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111',
    marginBottom: 8,
  },
  modalHint: {
    fontSize: 14,
    color: '#666',
    marginBottom: 12,
    lineHeight: 20,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    minHeight: 100,
    textAlignVertical: 'top',
    fontSize: 16,
    backgroundColor: '#fafafa',
  },
  modalCounter: {
    fontSize: 12,
    color: '#999',
    textAlign: 'right',
    marginTop: 4,
    marginBottom: 16,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  modalCancel: {
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  modalCancelText: {
    color: '#666',
    fontSize: 16,
    fontWeight: '600',
  },
  modalConfirm: {
    backgroundColor: '#3B82F6',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    minWidth: 140,
    alignItems: 'center',
    marginLeft: 12,
  },
  modalConfirmDisabled: {
    backgroundColor: '#9CA3AF',
  },
  modalConfirmText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});

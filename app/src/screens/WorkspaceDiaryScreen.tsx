import React, { useCallback, useLayoutEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Pressable,
  TextInput,
  ActivityIndicator,
  Alert,
  Modal,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import PlayerAvatar from '../components/PlayerAvatar';

type Props = NativeStackScreenProps<MainStackParamList, 'WorkspaceDiary'>;

type DiaryKind = 'bug' | 'suggestion';

type DiaryRow = {
  id: string;
  user_id: string;
  kind: DiaryKind;
  content: string;
  created_at: string;
  users:
    | { display_name: string; username: string }
    | { display_name: string; username: string }[]
    | null;
};

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

function formatDiaryWhen(iso: string): string {
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
}

export default function WorkspaceDiaryScreen({ navigation, route }: Props) {
  const { workspaceId } = route.params;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [entries, setEntries] = useState<DiaryRow[]>([]);

  const [formOpen, setFormOpen] = useState(false);
  const [formContent, setFormContent] = useState('');
  const [formKind, setFormKind] = useState<DiaryKind>('bug');
  const [formSaving, setFormSaving] = useState(false);

  const load = useCallback(async () => {
    const meRes = await supabase.auth.getUser();
    const uid = meRes.data.user?.id ?? null;
    setMyUserId(uid);

    const { data, error } = await supabase
      .from('workspace_diary_entries')
      .select(
        `
        id,
        user_id,
        kind,
        content,
        created_at,
        users!workspace_diary_entries_user_id_fkey (display_name, username)
      `
      )
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false });

    if (error) {
      if (__DEV__) console.error('[WorkspaceDiary]', error);
      Alert.alert('Error', error.message ?? 'No se pudo cargar la bitácora.');
      setEntries([]);
    } else {
      setEntries((data ?? []) as DiaryRow[]);
    }

    setLoading(false);
  }, [workspaceId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      title: 'Bugs y sugerencias',
      headerBackTitle: 'Atrás',
      headerLeft: hierarchicalHeaderBack(navigation, 'WorkspaceDetail', { workspaceId }),
    });
  }, [navigation, workspaceId]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const openCreate = () => {
    setFormContent('');
    setFormKind('bug');
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setFormSaving(false);
  };

  const submitForm = async () => {
    const trimmed = formContent.trim();
    if (!trimmed.length) {
      Alert.alert('Vacío', 'Escribí algo antes de publicar.');
      return;
    }
    if (trimmed.length > 2000) {
      Alert.alert('Demasiado largo', 'El texto puede tener hasta 2000 caracteres.');
      return;
    }
    if (!myUserId) {
      Alert.alert('Sesión', 'Tenés que iniciar sesión para continuar.');
      return;
    }

    setFormSaving(true);
    try {
      const { error } = await supabase.from('workspace_diary_entries').insert({
        workspace_id: workspaceId,
        user_id: myUserId,
        kind: formKind,
        content: trimmed,
      });
      if (error) throw error;
      closeForm();
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'No se pudo guardar.';
      Alert.alert('Error', msg);
      setFormSaving(false);
    }
  };

  const renderCard = (row: DiaryRow) => {
    const u = relationOne(row.users);
    const author = u?.display_name?.trim() || u?.username || 'Jugador';
    const typeIcon = row.kind === 'bug' ? '🐛' : '💡';

    return (
      <View key={row.id} style={styles.card}>
        <View style={styles.cardHeader}>
          <PlayerAvatar userId={row.user_id} size="small" withColorBorder={false} outsideEvent />
          <View style={styles.cardHeaderText}>
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardAuthor} numberOfLines={1}>
                {author}
              </Text>
              <Text style={styles.cardTypeIcon}>{typeIcon}</Text>
            </View>
            <Text style={styles.cardMeta}>{formatDiaryWhen(row.created_at)}</Text>
          </View>
        </View>
        <Text style={styles.cardBody}>{row.content}</Text>
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
    <View style={styles.screen}>
      <TouchableOpacity style={styles.addBtn} onPress={openCreate}>
        <Text style={styles.addBtnTxt}>+ Agregar bug o sugerencia</Text>
      </TouchableOpacity>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {entries.length === 0 ? (
          <Text style={styles.empty}>Todavía no hay entradas en este grupo.</Text>
        ) : (
          entries.map(renderCard)
        )}
      </ScrollView>

      <Modal visible={formOpen} transparent animationType="fade" onRequestClose={closeForm}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.modalDismiss} onPress={closeForm} accessibilityLabel="Cerrar" />
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.modalKb}
          >
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>
                {formKind === 'bug' ? 'Reportar bug' : 'Sugerencia'}
              </Text>
              <View style={styles.segmentRow}>
                <TouchableOpacity
                  style={[styles.segment, formKind === 'bug' && styles.segmentOn]}
                  onPress={() => setFormKind('bug')}
                >
                  <Text style={[styles.segmentTxt, formKind === 'bug' && styles.segmentTxtOn]}>Bug</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.segment, formKind === 'suggestion' && styles.segmentOn]}
                  onPress={() => setFormKind('suggestion')}
                >
                  <Text style={[styles.segmentTxt, formKind === 'suggestion' && styles.segmentTxtOn]}>
                    Sugerencia
                  </Text>
                </TouchableOpacity>
              </View>
              <TextInput
                style={styles.modalInput}
                multiline
                maxLength={2000}
                placeholder="Escribí aquí…"
                placeholderTextColor="#9CA3AF"
                value={formContent}
                onChangeText={setFormContent}
                textAlignVertical="top"
              />
              <Text style={styles.counter}>{formContent.length}/2000</Text>
              <View style={styles.modalActions}>
                <TouchableOpacity style={styles.modalCancel} onPress={closeForm} disabled={formSaving}>
                  <Text style={styles.modalCancelTxt}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalPublish} onPress={() => void submitForm()} disabled={formSaving}>
                  {formSaving ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.modalPublishTxt}>Publicar</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F9FAFB' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  addBtn: {
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 8,
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  addBtnTxt: { fontSize: 15, fontWeight: '700', color: '#2563EB' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 28 },
  empty: { color: '#6B7280', fontSize: 14, marginTop: 20, textAlign: 'center' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 },
  cardHeaderText: { flex: 1, marginLeft: 10, minWidth: 0 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardAuthor: { fontSize: 15, fontWeight: '700', color: '#111827', flexShrink: 1 },
  cardTypeIcon: { fontSize: 15 },
  cardMeta: { fontSize: 12, color: '#6B7280', marginTop: 2 },
  cardBody: { fontSize: 15, color: '#1F2937', lineHeight: 22 },
  modalRoot: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 20,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  modalDismiss: {
    ...StyleSheet.absoluteFillObject,
  },
  modalKb: {
    width: '100%',
    maxHeight: '90%',
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 18,
    maxHeight: '85%',
  },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#111', marginBottom: 12 },
  segmentRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  segment: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
  },
  segmentOn: { backgroundColor: '#EFF6FF', borderWidth: 1, borderColor: '#93C5FD' },
  segmentTxt: { fontSize: 14, fontWeight: '600', color: '#6B7280' },
  segmentTxtOn: { color: '#1D4ED8' },
  modalInput: {
    minHeight: 140,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: '#111',
    marginBottom: 6,
  },
  counter: { fontSize: 12, color: '#9CA3AF', textAlign: 'right', marginBottom: 14 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  modalCancel: { paddingVertical: 10, paddingHorizontal: 14 },
  modalCancelTxt: { fontSize: 16, color: '#6B7280', fontWeight: '600' },
  modalPublish: {
    backgroundColor: '#2563EB',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 10,
    minWidth: 100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalPublishTxt: { color: '#fff', fontWeight: '700', fontSize: 16 },
});

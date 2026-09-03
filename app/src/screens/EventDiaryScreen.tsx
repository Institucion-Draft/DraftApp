import React, { useCallback, useLayoutEffect, useMemo, useState } from 'react';
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
import type { EventStatus } from '../lib/database.types';

type Props = NativeStackScreenProps<MainStackParamList, 'EventDiary'>;

type DiaryEntryType = 'curiosity' | 'bug' | 'suggestion';

type DiaryRow = {
  id: string;
  user_id: string;
  participant_id?: string | null;
  entry_type: DiaryEntryType;
  content: string;
  created_at: string;
  users:
    | {
        display_name: string;
        username: string;
      }
    | {
        display_name: string;
        username: string;
      }[]
    | null;
};

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

function isBuenosAiresSameCalendarDay(scheduledFor: string, when: Date = new Date()): boolean {
  const dayA = new Date(scheduledFor).toLocaleDateString('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  });
  const dayB = when.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  return dayA === dayB;
}

function canPostDiaryEntry(eventStatus: EventStatus, scheduledFor: string): boolean {
  if (eventStatus === 'drafting' || eventStatus === 'playing' || eventStatus === 'completed') {
    return true;
  }
  return isBuenosAiresSameCalendarDay(scheduledFor);
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

export default function EventDiaryScreen({ navigation, route }: Props) {
  const { eventId } = route.params;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [eventName, setEventName] = useState('');
  const [eventStatus, setEventStatus] = useState<EventStatus | null>(null);
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [myParticipantId, setMyParticipantId] = useState<string | null>(null);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [entries, setEntries] = useState<DiaryRow[]>([]);
  const [tab, setTab] = useState<'curiosity' | 'bugs'>('curiosity');

  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<'create' | 'edit'>('create');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formContent, setFormContent] = useState('');
  const [formBugKind, setFormBugKind] = useState<'bug' | 'suggestion'>('bug');
  const [formSaving, setFormSaving] = useState(false);

  const load = useCallback(async () => {
    const meRes = await supabase.auth.getUser();
    const uid = meRes.data.user?.id ?? null;
    setMyUserId(uid);

    const evRes = await supabase
      .from('draft_events')
      .select('name, workspace_id, status, scheduled_for')
      .eq('id', eventId)
      .maybeSingle();

    if (evRes.error || !evRes.data) {
      Alert.alert('Error', 'No se pudo cargar el evento.');
      setLoading(false);
      return;
    }

    const ev = evRes.data as {
      name: string;
      workspace_id: string;
      status: EventStatus;
      scheduled_for: string;
    };
    setEventName(ev.name);
    setEventStatus(ev.status);
    setScheduledFor(ev.scheduled_for);

    const [roleRes, partRes, diaryRes, eventPartsRes] = await Promise.all([
      uid
        ? supabase
            .from('workspace_members')
            .select('role')
            .eq('workspace_id', ev.workspace_id)
            .eq('user_id', uid)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      uid
        ? supabase
            .from('event_participants')
            .select('id')
            .eq('event_id', eventId)
            .eq('user_id', uid)
            .eq('role', 'player')
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from('event_diary_entries')
        .select(
          `
          id,
          user_id,
          entry_type,
          content,
          created_at,
          users!event_diary_entries_user_id_fkey (display_name, username)
        `
        )
        .eq('event_id', eventId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false }),
      supabase.from('event_participants').select('id, user_id').eq('event_id', eventId),
    ]);

    const role = roleRes.data as { role: string } | null;
    setIsOrganizer(role?.role === 'organizer');

    const part = partRes.data as { id: string } | null;
    setMyParticipantId(part?.id ?? null);

    const userToParticipantId = new Map<string, string>();
    if (!eventPartsRes.error) {
      for (const row of eventPartsRes.data ?? []) {
        const r = row as { id: string; user_id: string };
        userToParticipantId.set(r.user_id, r.id);
      }
    }

    if (diaryRes.error) {
      if (__DEV__) console.error('[EventDiary]', diaryRes.error);
      Alert.alert('Error', diaryRes.error.message ?? 'No se pudo cargar la bitácora.');
      setEntries([]);
    } else {
      const rows = (diaryRes.data ?? []) as Omit<DiaryRow, 'participant_id'>[];
      setEntries(
        rows.map((row) => ({
          ...row,
          participant_id: userToParticipantId.get(row.user_id) ?? null,
        }))
      );
    }

    setLoading(false);
  }, [eventId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      title: eventName ? `Bitácora · ${eventName}` : 'Bitácora',
      headerBackTitle: 'Atrás',
      headerLeft: hierarchicalHeaderBack(navigation, 'EventDetail', { eventId }),
    });
  }, [navigation, eventId, eventName]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const allowPost =
    myParticipantId != null &&
    scheduledFor != null &&
    eventStatus != null &&
    canPostDiaryEntry(eventStatus, scheduledFor);

  const visibleEntries = useMemo(() => {
    if (tab === 'curiosity') return entries.filter((e) => e.entry_type === 'curiosity');
    return entries.filter((e) => e.entry_type === 'bug' || e.entry_type === 'suggestion');
  }, [entries, tab]);

  const openCreateCuriosity = () => {
    if (!allowPost) {
      Alert.alert(
        'No disponible',
        'Solo podés publicar curiosidades si sos participante del evento y es el día del evento (o el evento está en curso o terminado).'
      );
      return;
    }
    setFormMode('create');
    setEditingId(null);
    setFormContent('');
    setTab('curiosity');
    setFormOpen(true);
  };

  const openCreateBug = () => {
    if (!allowPost) {
      Alert.alert(
        'No disponible',
        'Solo podés publicar bugs o sugerencias si sos participante del evento y es el día del evento (o el evento está en curso o terminado).'
      );
      return;
    }
    setFormMode('create');
    setEditingId(null);
    setFormContent('');
    setFormBugKind('bug');
    setTab('bugs');
    setFormOpen(true);
  };

  const openEdit = (row: DiaryRow) => {
    if (row.entry_type === 'curiosity') setTab('curiosity');
    else setTab('bugs');
    setFormMode('edit');
    setEditingId(row.id);
    setFormContent(row.content);
    if (row.entry_type === 'suggestion') setFormBugKind('suggestion');
    else if (row.entry_type === 'bug') setFormBugKind('bug');
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
      if (formMode === 'edit' && editingId) {
        const { error } = await supabase
          .from('event_diary_entries')
          .update({ content: trimmed, updated_at: new Date().toISOString() })
          .eq('id', editingId)
          .eq('user_id', myUserId);
        if (error) throw error;
      } else {
        const entryType: DiaryEntryType =
          tab === 'curiosity' ? 'curiosity' : formBugKind === 'bug' ? 'bug' : 'suggestion';
        const { error } = await supabase.from('event_diary_entries').insert({
          event_id: eventId,
          user_id: myUserId,
          entry_type: entryType,
          content: trimmed,
        });
        if (error) throw error;
      }
      closeForm();
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'No se pudo guardar.';
      Alert.alert('Error', msg);
      setFormSaving(false);
    }
  };

  const confirmDelete = (row: DiaryRow) => {
    const canDelete = row.user_id === myUserId || isOrganizer;
    if (!canDelete) return;
    Alert.alert('Borrar entrada', '¿Seguro que querés borrar esta entrada?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Borrar',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('event_diary_entries').delete().eq('id', row.id);
          if (error) {
            Alert.alert('Error', error.message ?? 'No se pudo borrar.');
            return;
          }
          await load();
        },
      },
    ]);
  };

  const renderCard = (row: DiaryRow) => {
    const u = relationOne(row.users);
    const author = u?.display_name?.trim() || u?.username || 'Jugador';
    const isMine = row.user_id === myUserId;
    const showEdit = isMine;
    const showDelete = isMine || isOrganizer;

    const typeIcon =
      row.entry_type === 'bug' ? '🐛' : row.entry_type === 'suggestion' ? '💡' : null;

    return (
      <View key={row.id} style={styles.card}>
        <View style={styles.cardHeader}>
          <PlayerAvatar
            userId={row.user_id}
            participantId={row.participant_id ?? undefined}
            size="small"
            withColorBorder={false}
          />
          <View style={styles.cardHeaderText}>
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardAuthor} numberOfLines={1}>
                {author}
              </Text>
              {typeIcon ? <Text style={styles.cardTypeIcon}>{typeIcon}</Text> : null}
            </View>
            <Text style={styles.cardMeta}>{formatDiaryWhen(row.created_at)}</Text>
          </View>
          <View style={styles.cardActions}>
            {showEdit ? (
              <TouchableOpacity hitSlop={12} onPress={() => openEdit(row)} accessibilityLabel="Editar">
                <Text style={styles.iconBtn}>✏️</Text>
              </TouchableOpacity>
            ) : null}
            {showDelete ? (
              <TouchableOpacity hitSlop={12} onPress={() => confirmDelete(row)} accessibilityLabel="Borrar">
                <Text style={styles.iconBtn}>✕</Text>
              </TouchableOpacity>
            ) : null}
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

  const formTitle =
    formMode === 'edit'
      ? 'Editar entrada'
      : tab === 'curiosity'
        ? 'Nueva curiosidad'
        : formBugKind === 'bug'
          ? 'Reportar bug'
          : 'Sugerencia';

  return (
    <View style={styles.screen}>
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tab, tab === 'curiosity' && styles.tabActive]}
          onPress={() => setTab('curiosity')}
        >
          <Text style={[styles.tabTxt, tab === 'curiosity' && styles.tabTxtActive]}>✨ Curiosidades</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tab, tab === 'bugs' && styles.tabActive]} onPress={() => setTab('bugs')}>
          <Text style={[styles.tabTxt, tab === 'bugs' && styles.tabTxtActive]}>🐛 Bugs y sugerencias</Text>
        </TouchableOpacity>
      </View>

      {tab === 'curiosity' ? (
        <TouchableOpacity style={styles.addBtn} onPress={openCreateCuriosity} disabled={!allowPost}>
          <Text style={[styles.addBtnTxt, !allowPost && styles.addBtnTxtDisabled]}>+ Agregar curiosidad</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity style={styles.addBtn} onPress={openCreateBug} disabled={!allowPost}>
          <Text style={[styles.addBtnTxt, !allowPost && styles.addBtnTxtDisabled]}>+ Agregar bug o sugerencia</Text>
        </TouchableOpacity>
      )}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {visibleEntries.length === 0 ? (
          <Text style={styles.empty}>Todavía no hay entradas en esta pestaña.</Text>
        ) : (
          visibleEntries.map(renderCard)
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
            <Text style={styles.modalTitle}>{formTitle}</Text>
            {formMode === 'create' && tab === 'bugs' ? (
              <View style={styles.segmentRow}>
                <TouchableOpacity
                  style={[styles.segment, formBugKind === 'bug' && styles.segmentOn]}
                  onPress={() => setFormBugKind('bug')}
                >
                  <Text style={[styles.segmentTxt, formBugKind === 'bug' && styles.segmentTxtOn]}>Bug</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.segment, formBugKind === 'suggestion' && styles.segmentOn]}
                  onPress={() => setFormBugKind('suggestion')}
                >
                  <Text style={[styles.segmentTxt, formBugKind === 'suggestion' && styles.segmentTxtOn]}>
                    Sugerencia
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}
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
                  <Text style={styles.modalPublishTxt}>{formMode === 'edit' ? 'Guardar' : 'Publicar'}</Text>
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
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
    gap: 8,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
  },
  tabActive: { backgroundColor: '#EFF6FF', borderWidth: 1, borderColor: '#BFDBFE' },
  tabTxt: { fontSize: 13, fontWeight: '600', color: '#6B7280', textAlign: 'center' },
  tabTxtActive: { color: '#1D4ED8' },
  addBtn: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  addBtnTxt: { fontSize: 15, fontWeight: '700', color: '#2563EB' },
  addBtnTxtDisabled: { color: '#9CA3AF' },
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
  cardActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  iconBtn: { fontSize: 16, color: '#374151', paddingHorizontal: 4 },
  cardBody: { fontSize: 15, color: '#1F2937', lineHeight: 22 },
  modalRoot: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 20,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  modalDismiss: {
    ...StyleSheet.absoluteFill,
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

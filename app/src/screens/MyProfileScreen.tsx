import React, { useCallback, useLayoutEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import PlayerAvatar from '../components/PlayerAvatar';
import CrossEventStats from '../components/CrossEventStats';

type Props = NativeStackScreenProps<MainStackParamList, 'MyProfile'>;
type MyProfileParams = { from?: 'WorkspacesList' | 'WorkspaceDetail' | 'Playground'; workspaceId?: string };

const COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

function formatDateDDMMYYYY(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function cooldownEndsAt(changedAtIso: string): Date {
  return new Date(new Date(changedAtIso).getTime() + COOLDOWN_MS);
}

function isCooldownActive(changedAtIso: string | null): boolean {
  if (!changedAtIso) return false;
  return Date.now() - new Date(changedAtIso).getTime() < COOLDOWN_MS;
}

export default function MyProfileScreen({ navigation, route }: Props) {
  const backParams = (route.params ?? {}) as MyProfileParams;
  const backFrom = backParams.from;
  const backWorkspaceId = backParams.workspaceId;
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [displayNameChangedAt, setDisplayNameChangedAt] = useState<string | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [inlineError, setInlineError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const me = await supabase.auth.getUser();
    const uid = me.data.user?.id ?? null;
    setUserId(uid);
    if (!uid) {
      setDisplayName('');
      setDisplayNameChangedAt(null);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from('users')
      .select('display_name, display_name_changed_at')
      .eq('id', uid)
      .maybeSingle();
    if (error || !data) {
      if (error) {
        Alert.alert('Error', error.message ?? 'No se pudo cargar tu perfil.');
      }
      setDisplayName('');
      setDisplayNameChangedAt(null);
      setLoading(false);
      return;
    }
    setDisplayName(String((data as { display_name: string }).display_name ?? ''));
    setDisplayNameChangedAt(
      (data as { display_name_changed_at: string | null }).display_name_changed_at ?? null
    );
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load();
    }, [load])
  );

  useLayoutEffect(() => {
    if (backFrom === 'WorkspaceDetail' && backWorkspaceId) {
      navigation.setOptions({
        headerLeft: hierarchicalHeaderBack(navigation, 'WorkspaceDetail', {
          workspaceId: backWorkspaceId,
        }),
      });
    } else if (backFrom === 'Playground' && backWorkspaceId) {
      navigation.setOptions({
        headerLeft: hierarchicalHeaderBack(navigation, 'Playground', {
          workspaceId: backWorkspaceId,
        }),
      });
    } else {
      navigation.setOptions({
        headerLeft: hierarchicalHeaderBack(navigation, 'WorkspacesList'),
      });
    }
  }, [navigation, backFrom, backWorkspaceId]);

  const cooldown = isCooldownActive(displayNameChangedAt);
  const nextChangeDate =
    displayNameChangedAt && cooldown ? formatDateDDMMYYYY(cooldownEndsAt(displayNameChangedAt)) : null;

  const openEditModal = () => {
    if (cooldown && nextChangeDate) {
      Alert.alert(
        'Cambio no disponible',
        `Vas a poder cambiar tu nombre de nuevo el ${nextChangeDate}.`
      );
      return;
    }
    setEditValue(displayName);
    setInlineError('');
    setModalVisible(true);
  };

  const closeModal = () => {
    if (saving) return;
    setModalVisible(false);
    setInlineError('');
  };

  const checkDuplicate = async (trimmed: string): Promise<boolean> => {
    if (!userId) return false;
    const { data, error } = await supabase
      .from('users')
      .select('id')
      .neq('id', userId)
      .ilike('display_name', trimmed)
      .limit(1);
    if (error) {
      if (__DEV__) console.error('checkDuplicate', error);
      return false;
    }
    return (data?.length ?? 0) > 0;
  };

  const performUpdate = async (trimmed: string) => {
    if (!userId) return;
    setSaving(true);
    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .from('users')
      .update({
        display_name: trimmed,
        display_name_changed_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', userId);
    setSaving(false);
    if (error) {
      const msg = error.message?.toLowerCase() ?? '';
      const dup =
        error.code === '23505' || msg.includes('unique') || msg.includes('duplicate');
      if (dup) {
        setInlineError('Ese nombre ya está en uso');
        return;
      }
      Alert.alert('Error', error.message ?? 'No se pudo guardar el nombre.');
      return;
    }
    setDisplayName(trimmed);
    setDisplayNameChangedAt(nowIso);
    setModalVisible(false);
    setInlineError('');
    Alert.alert('Listo', 'Tu nombre se actualizó correctamente.');
  };

  const onSavePress = () => {
    const trimmed = editValue.trim();
    if (trimmed.length < 2) {
      setInlineError('El nombre debe tener al menos 2 caracteres.');
      return;
    }
    if (trimmed === displayName) {
      setModalVisible(false);
      setInlineError('');
      return;
    }
    setInlineError('');
    void (async () => {
      const taken = await checkDuplicate(trimmed);
      if (taken) {
        setInlineError('Ese nombre ya está en uso');
        return;
      }
      const eligibleAgain = formatDateDDMMYYYY(new Date(Date.now() + COOLDOWN_MS));
      Alert.alert(
        'Confirmar cambio',
        `Una vez que cambies tu nombre, no podrás volver a cambiarlo hasta el ${eligibleAgain}. ¿Continuar?`,
        [
          { text: 'Cancelar', style: 'cancel' },
          { text: 'Confirmar', onPress: () => void performUpdate(trimmed) },
        ]
      );
    })();
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  if (!userId) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>No hay sesión activa.</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.avatarBlock}>
          <PlayerAvatar userId={userId} size="large" withColorBorder={false} outsideEvent />
        </View>
        <Text style={styles.sectionTitle}>Nombre de usuario</Text>
        <Text style={styles.currentName}>{displayName || '—'}</Text>
        <TouchableOpacity
          style={[styles.editBtn, cooldown && styles.editBtnMuted]}
          onPress={openEditModal}
          activeOpacity={0.7}
        >
          <Text style={[styles.editBtnTxt, cooldown && styles.editBtnTxtMuted]}>Editar nombre de usuario</Text>
        </TouchableOpacity>
        {cooldown && nextChangeDate ? (
          <Text style={styles.cooldownHint}>Vas a poder cambiarlo de nuevo el {nextChangeDate}</Text>
        ) : null}

        {userId && backWorkspaceId ? (
          <>
            <View style={styles.divider} />
            <CrossEventStats userId={userId} workspaceId={backWorkspaceId} />
          </>
        ) : null}
      </ScrollView>

      <Modal visible={modalVisible} animationType="slide" transparent onRequestClose={closeModal}>
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Editar nombre</Text>
            <TextInput
              style={styles.modalInput}
              value={editValue}
              onChangeText={(t) => {
                setEditValue(t);
                if (inlineError) setInlineError('');
              }}
              placeholder="Tu nombre visible"
              placeholderTextColor="#999"
              autoCapitalize="words"
              autoCorrect
              editable={!saving}
              maxLength={80}
            />
            {inlineError ? <Text style={styles.inlineError}>{inlineError}</Text> : null}
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancel} onPress={closeModal} disabled={saving}>
                <Text style={styles.modalCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalConfirm, saving && styles.modalConfirmDisabled]}
                onPress={onSavePress}
                disabled={saving}
              >
                {saving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.modalConfirmText}>Guardar</Text>
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
  root: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  muted: { color: '#666', fontSize: 15 },
  scroll: { padding: 24, paddingBottom: 40 },
  avatarBlock: { alignItems: 'center', marginBottom: 28 },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: '#374151', marginBottom: 8 },
  currentName: { fontSize: 22, fontWeight: '700', color: '#111', marginBottom: 16 },
  editBtn: {
    backgroundColor: '#3B82F6',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  editBtnMuted: { backgroundColor: '#93C5FD' },
  editBtnTxt: { color: '#fff', fontSize: 15, fontWeight: '600' },
  editBtnTxtMuted: { color: '#F9FAFB' },
  cooldownHint: { marginTop: 10, fontSize: 13, color: '#6B7280' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: '#E5E7EB', marginTop: 24 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#00000066',
    justifyContent: 'center',
    padding: 20,
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#111', marginBottom: 14 },
  modalInput: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    color: '#111',
  },
  inlineError: { marginTop: 8, color: '#DC2626', fontSize: 14, fontWeight: '600' },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 18, gap: 12 },
  modalCancel: { paddingVertical: 10, paddingHorizontal: 12 },
  modalCancelText: { color: '#3B82F6', fontSize: 16, fontWeight: '600' },
  modalConfirm: {
    backgroundColor: '#3B82F6',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
    minWidth: 100,
    alignItems: 'center',
  },
  modalConfirmDisabled: { opacity: 0.6 },
  modalConfirmText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});

import React, { useCallback, useLayoutEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Platform,
  Alert,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import DateTimePicker, {
  DateTimePickerAndroid,
} from '@react-native-community/datetimepicker';
import * as Clipboard from 'expo-clipboard';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';

type Props = NativeStackScreenProps<MainStackParamList, 'GenerateInvite'>;

const CODE_REGEX = /^[A-Z0-9]{6,10}$/;

function generateInviteCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const len = 6 + Math.floor(Math.random() * 5);
  let s = '';
  for (let i = 0; i < len; i++) {
    s += chars[Math.floor(Math.random() * chars.length)]!;
  }
  return s;
}

function endOfDayIso(d: Date): string {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x.toISOString();
}

type InviteRow = {
  id: string;
  code: string;
  expires_at: string | null;
  max_uses: number | null;
  uses_count: number;
  created_at: string;
};

export default function GenerateInviteScreen({ route, navigation }: Props) {
  const { workspaceId } = route.params;
  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'WorkspaceDetail', { workspaceId }),
    });
  }, [navigation, workspaceId]);
  const { user } = useAuth();
  const [maxUsesText, setMaxUsesText] = useState('');
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [iosPickerOpen, setIosPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lastCode, setLastCode] = useState<string | null>(null);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadInvites = useCallback(async () => {
    const { data, error } = await supabase
      .from('workspace_invites')
      .select('id, code, expires_at, max_uses, uses_count, created_at')
      .eq('workspace_id', workspaceId)
      .eq('is_revoked', false)
      .order('created_at', { ascending: false });

    if (error) {
      Alert.alert('Error', 'No se pudieron cargar los códigos activos.');
      setInvites([]);
      return;
    }

    setInvites((data ?? []) as InviteRow[]);
  }, [workspaceId]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        await loadInvites();
        if (cancelled) return;
      })();
      return () => {
        cancelled = true;
      };
    }, [loadInvites])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadInvites();
    setRefreshing(false);
  }, [loadInvites]);

  const openAndroidDatePicker = () => {
    const value = expiresAt ?? new Date();
    DateTimePickerAndroid.open({
      value,
      mode: 'date',
      minimumDate: new Date(),
      onChange: (event, date) => {
        if (event.type === 'set' && date) setExpiresAt(date);
      },
    });
  };

  const handleGenerate = async () => {
    if (!user?.id) {
      Alert.alert('Error', 'No hay sesión activa.');
      return;
    }

    let maxUses: number | null = null;
    const trimmed = maxUsesText.trim();
    if (trimmed.length > 0) {
      const n = parseInt(trimmed, 10);
      if (Number.isNaN(n) || n < 1) {
        Alert.alert(
          'Revisá los datos',
          'Si indicás un límite de usos, tiene que ser un número mayor a 0.'
        );
        return;
      }
      maxUses = n;
    }

    let expiresIso: string | null = null;
    if (expiresAt) {
      const end = new Date(endOfDayIso(expiresAt));
      if (end.getTime() < Date.now()) {
        Alert.alert(
          'Revisá los datos',
          'La fecha de vencimiento tiene que ser hoy o una fecha futura.'
        );
        return;
      }
      expiresIso = end.toISOString();
    }

    setSubmitting(true);
    let inserted = false;
    for (let attempt = 0; attempt < 8 && !inserted; attempt++) {
      const code = generateInviteCode();
      if (!CODE_REGEX.test(code)) continue;

      const { error } = await supabase.from('workspace_invites').insert({
        workspace_id: workspaceId,
        code,
        created_by: user.id,
        expires_at: expiresIso,
        max_uses: maxUses,
      });

      if (!error) {
        inserted = true;
        setLastCode(code);
        setMaxUsesText('');
        setExpiresAt(null);
        await loadInvites();
        break;
      }

      const msg = error.message?.toLowerCase() ?? '';
      const dup =
        error.code === '23505' ||
        msg.includes('duplicate') ||
        msg.includes('unique');
      if (!dup) {
        setSubmitting(false);
        Alert.alert('Error', error.message ?? 'No se pudo generar el código.');
        return;
      }
    }

    setSubmitting(false);
    if (!inserted) {
      Alert.alert(
        'Error',
        'No se pudo generar un código único. Probá de nuevo.'
      );
    }
  };

  const copyCode = async (code: string) => {
    try {
      await Clipboard.setStringAsync(code);
      Alert.alert('Copiado', 'El código se copió al portapapeles.');
    } catch {
      Alert.alert('Error', 'No se pudo copiar el código.');
    }
  };

  const revoke = async (id: string) => {
    setRevokingId(id);
    const { error } = await supabase
      .from('workspace_invites')
      .update({ is_revoked: true })
      .eq('id', id);
    setRevokingId(null);

    if (error) {
      Alert.alert('Error', error.message ?? 'No se pudo revocar el código.');
      return;
    }

    await loadInvites();
  };

  const formatExpiry = (iso: string | null) => {
    if (!iso) return 'Sin vencimiento';
    try {
      return new Date(iso).toLocaleString('es-AR', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      return iso;
    }
  };

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      <Text style={styles.label}>Límite de usos (opcional)</Text>
      <Text style={styles.hint}>
        Dejá vacío para usos ilimitados mientras el código esté activo.
      </Text>
      <TextInput
        style={styles.input}
        placeholder="Ej.: 10"
        placeholderTextColor="#999"
        value={maxUsesText}
        onChangeText={setMaxUsesText}
        keyboardType="number-pad"
        editable={!submitting}
      />

      <Text style={styles.label}>Vencimiento (opcional)</Text>
      <Text style={styles.hint}>
        Si no elegís fecha, el código no expira por tiempo.
      </Text>
      <View style={styles.dateRow}>
        <Text style={styles.datePreview}>
          {expiresAt
            ? expiresAt.toLocaleDateString('es-AR')
            : 'Sin vencimiento'}
        </Text>
        <TouchableOpacity
          style={styles.dateBtn}
          onPress={() => {
            if (Platform.OS === 'android') openAndroidDatePicker();
            else setIosPickerOpen(true);
          }}
        >
          <Text style={styles.dateBtnText}>Elegir fecha</Text>
        </TouchableOpacity>
        {expiresAt ? (
          <TouchableOpacity
            style={styles.clearDateBtn}
            onPress={() => setExpiresAt(null)}
          >
            <Text style={styles.clearDateText}>Quitar</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {Platform.OS === 'ios' && iosPickerOpen ? (
        <View style={styles.iosPickerWrap}>
          <DateTimePicker
            value={expiresAt ?? new Date()}
            mode="date"
            display="spinner"
            minimumDate={new Date()}
            onChange={(_event, date) => {
              if (date) setExpiresAt(date);
            }}
          />
          <TouchableOpacity
            style={styles.iosPickerDone}
            onPress={() => setIosPickerOpen(false)}
          >
            <Text style={styles.iosPickerDoneText}>Listo</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <TouchableOpacity
        style={[styles.primaryBtn, submitting && styles.primaryBtnDisabled]}
        onPress={() => {
          void handleGenerate();
        }}
        disabled={submitting}
      >
        {submitting ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.primaryBtnText}>Generar código</Text>
        )}
      </TouchableOpacity>

      {lastCode ? (
        <View style={styles.codeBox}>
          <Text style={styles.codeLabel}>Último código generado</Text>
          <Text style={styles.codeBig} selectable>
            {lastCode}
          </Text>
          <TouchableOpacity
            style={styles.copyBtn}
            onPress={() => {
              void copyCode(lastCode);
            }}
          >
            <Text style={styles.copyBtnText}>Copiar al portapapeles</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <Text style={styles.sectionTitle}>Códigos activos</Text>
      {invites.length === 0 ? (
        <Text style={styles.muted}>No hay códigos activos.</Text>
      ) : (
        invites.map((inv) => (
          <View key={inv.id} style={styles.inviteCard}>
            <Text style={styles.inviteCode}>{inv.code}</Text>
            <Text style={styles.inviteMeta}>
              Usos: {inv.uses_count}
              {inv.max_uses != null ? ` / ${inv.max_uses}` : ' (sin límite)'}
            </Text>
            <Text style={styles.inviteMeta}>
              Vence: {formatExpiry(inv.expires_at)}
            </Text>
            <TouchableOpacity
              style={styles.revokeBtn}
              disabled={revokingId === inv.id}
              onPress={() => {
                void revoke(inv.id);
              }}
            >
              <Text style={styles.revokeBtnText}>
                {revokingId === inv.id ? '…' : 'Revocar'}
              </Text>
            </TouchableOpacity>
          </View>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: '#fff',
  },
  scrollContent: {
    padding: 24,
    paddingBottom: 40,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111',
    marginBottom: 6,
  },
  hint: {
    fontSize: 13,
    color: '#666',
    marginBottom: 8,
    lineHeight: 18,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    marginBottom: 20,
    backgroundColor: '#fafafa',
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginBottom: 20,
  },
  datePreview: {
    flex: 1,
    minWidth: 120,
    fontSize: 15,
    color: '#111',
  },
  dateBtn: {
    backgroundColor: '#EFF6FF',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    marginRight: 8,
  },
  dateBtnText: {
    color: '#3B82F6',
    fontWeight: '600',
    fontSize: 14,
  },
  clearDateBtn: {
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  clearDateText: {
    color: '#666',
    fontSize: 14,
    fontWeight: '600',
  },
  iosPickerWrap: {
    marginBottom: 16,
  },
  iosPickerDone: {
    alignSelf: 'flex-end',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  iosPickerDoneText: {
    color: '#3B82F6',
    fontSize: 16,
    fontWeight: '600',
  },
  primaryBtn: {
    backgroundColor: '#3B82F6',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 24,
  },
  primaryBtnDisabled: {
    backgroundColor: '#9CA3AF',
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  codeBox: {
    backgroundColor: '#F0FDF4',
    borderWidth: 1,
    borderColor: '#BBF7D0',
    borderRadius: 12,
    padding: 20,
    marginBottom: 24,
    alignItems: 'center',
  },
  codeLabel: {
    fontSize: 14,
    color: '#166534',
    marginBottom: 8,
    fontWeight: '600',
  },
  codeBig: {
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 4,
    color: '#111',
    marginBottom: 16,
  },
  copyBtn: {
    backgroundColor: '#3B82F6',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
  },
  copyBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111',
    marginBottom: 12,
  },
  muted: {
    fontSize: 14,
    color: '#666',
  },
  inviteCard: {
    backgroundColor: '#fafafa',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#eee',
    padding: 14,
    marginBottom: 12,
  },
  inviteCode: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111',
    letterSpacing: 2,
    marginBottom: 6,
  },
  inviteMeta: {
    fontSize: 13,
    color: '#666',
    marginBottom: 4,
  },
  revokeBtn: {
    marginTop: 10,
    alignSelf: 'flex-start',
    backgroundColor: '#FEE2E2',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  revokeBtnText: {
    color: '#DC2626',
    fontWeight: '600',
    fontSize: 14,
  },
});

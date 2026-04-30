import React, { useLayoutEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';

type Props = NativeStackScreenProps<MainStackParamList, 'JoinByCode'>;

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export default function JoinByCodeScreen({ navigation }: Props) {
  const { user } = useAuth();
  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'WorkspacesList'),
    });
  }, [navigation]);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const handleJoin = async () => {
    const normalized = normalizeCode(code);
    if (normalized.length < 6) {
      Alert.alert('Revisá el código', 'Ingresá un código de invitación válido.');
      return;
    }
    if (!user?.id) {
      Alert.alert('Error', 'No hay sesión activa.');
      return;
    }

    setBusy(true);
    const { data, error } = await supabase.rpc('redeem_invite_code', {
      p_code: normalized,
    });
    setBusy(false);

    if (error) {
      Alert.alert('Error', error.message ?? 'No se pudo canjear el código.');
      return;
    }

    if (data == null || data === '') {
      Alert.alert('Error', 'Respuesta inválida del servidor.');
      return;
    }

    const workspaceId = String(data);
    navigation.navigate('WorkspaceDetail', { workspaceId });
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.title}>Unirme con código</Text>
      <Text style={styles.subtitle}>
        Pegá el código que te compartió un organizador.
      </Text>
      <TextInput
        style={styles.input}
        placeholder="ABCDEF123"
        placeholderTextColor="#999"
        value={code}
        onChangeText={(t) => setCode(t.toUpperCase())}
        autoCapitalize="characters"
        autoCorrect={false}
        editable={!busy}
      />
      <TouchableOpacity
        style={[styles.btn, busy && styles.btnDisabled]}
        onPress={() => {
          void handleJoin();
        }}
        disabled={busy}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.btnText}>Unirme</Text>
        )}
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    padding: 24,
    justifyContent: 'center',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    color: '#666',
    textAlign: 'center',
    marginBottom: 28,
    lineHeight: 22,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingVertical: 16,
    paddingHorizontal: 16,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 3,
    textAlign: 'center',
    backgroundColor: '#fafafa',
    marginBottom: 20,
  },
  btn: {
    backgroundColor: '#3B82F6',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  btnDisabled: {
    backgroundColor: '#9CA3AF',
  },
  btnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});

import React, { useLayoutEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';

type Props = NativeStackScreenProps<MainStackParamList, 'CreateVenue'>;

export default function CreateVenueScreen({ route, navigation }: Props) {
  const { workspaceId } = route.params;
  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'VenuesList', { workspaceId }),
    });
  }, [navigation, workspaceId]);
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const validate = (): string | null => {
    const n = name.trim();
    if (n.length < 1 || n.length > 60) return 'El nombre debe tener entre 1 y 60 caracteres.';
    if (notes.length > 1000) return 'Las notas no pueden superar 1000 caracteres.';
    return null;
  };

  const onCreate = async () => {
    const err = validate();
    if (err) return Alert.alert('Revisá los datos', err);
    if (!user?.id) return Alert.alert('Error', 'No hay sesión activa.');

    setSubmitting(true);
    const { error } = await supabase.from('venues').insert({
      workspace_id: workspaceId,
      name: name.trim(),
      address: address.trim() || null,
      notes: notes.trim() || null,
      created_by: user.id,
    });
    setSubmitting(false);

    if (error) {
      const msg = error.message?.toLowerCase() ?? '';
      if (error.code === '23505' || msg.includes('unique') || msg.includes('duplicate')) {
        Alert.alert('Nombre en uso', 'Ya existe una sede con ese nombre en este workspace.');
        return;
      }
      Alert.alert('Error', error.message ?? 'No se pudo crear la sede.');
      return;
    }
    navigation.goBack();
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Nombre</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} maxLength={60} placeholder="Nombre de la sede" />

        <Text style={styles.label}>Dirección (opcional)</Text>
        <TextInput style={styles.input} value={address} onChangeText={setAddress} placeholder="Dirección o referencia" />

        <Text style={styles.label}>Notas (opcional)</Text>
        <TextInput style={[styles.input, styles.notes]} value={notes} onChangeText={setNotes} multiline maxLength={1000} />
        <Text style={styles.counter}>{notes.length}/1000</Text>

        <TouchableOpacity style={[styles.btn, submitting && styles.btnDisabled]} disabled={submitting} onPress={() => void onCreate()}>
          {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Crear</Text>}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  scroll: { padding: 24, paddingBottom: 32 },
  label: { fontSize: 15, fontWeight: '600', color: '#111', marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    backgroundColor: '#fafafa',
    marginBottom: 16,
  },
  notes: { minHeight: 110, textAlignVertical: 'top', marginBottom: 6 },
  counter: { textAlign: 'right', color: '#999', fontSize: 12, marginBottom: 20 },
  btn: { backgroundColor: '#3B82F6', borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  btnDisabled: { backgroundColor: '#9CA3AF' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});

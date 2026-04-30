import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';

type Props = NativeStackScreenProps<MainStackParamList, 'CreateCube'>;

export default function CreateCubeScreen({ navigation, route }: Props) {
  const { workspaceId } = route.params;
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [cardCount, setCardCount] = useState('');
  const [cubeCobraUrl, setCubeCobraUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const validate = (): string | null => {
    const n = name.trim();
    if (n.length < 1 || n.length > 60) return 'El nombre debe tener entre 1 y 60 caracteres.';
    if (cardCount.trim()) {
      const parsed = Number(cardCount);
      if (!Number.isInteger(parsed) || parsed <= 0) return 'Card count debe ser un número mayor a 0.';
    }
    const u = cubeCobraUrl.trim();
    if (u && !/^https?:\/\//i.test(u)) return 'El link de CubeCobra debe empezar con http:// o https://';
    if (notes.length > 2000) return 'Las notas no pueden superar 2000 caracteres.';
    return null;
  };

  const onCreate = async () => {
    const err = validate();
    if (err) {
      Alert.alert('Revisá los datos', err);
      return;
    }
    if (!user?.id) {
      Alert.alert('Error', 'No hay sesión activa.');
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.from('cubes').insert({
      workspace_id: workspaceId,
      name: name.trim(),
      card_count: cardCount.trim() ? Number(cardCount) : null,
      cubecobra_url: cubeCobraUrl.trim() || null,
      notes: notes.trim() || null,
      created_by: user.id,
    });
    setSubmitting(false);

    if (error) {
      const msg = error.message?.toLowerCase() ?? '';
      if (error.code === '23505' || msg.includes('unique') || msg.includes('duplicate')) {
        Alert.alert('Nombre en uso', 'Ya existe un cubo con ese nombre en este workspace.');
        return;
      }
      Alert.alert('Error', error.message ?? 'No se pudo crear el cubo.');
      return;
    }

    navigation.goBack();
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Nombre</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Nombre del cubo" maxLength={60} />

        <Text style={styles.label}>Cantidad de cartas (opcional)</Text>
        <TextInput
          style={styles.input}
          value={cardCount}
          onChangeText={setCardCount}
          placeholder="Ej: 360"
          keyboardType="number-pad"
        />

        <Text style={styles.label}>Link de CubeCobra (opcional)</Text>
        <TextInput
          style={styles.input}
          value={cubeCobraUrl}
          onChangeText={setCubeCobraUrl}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="https://cubecobra.com/..."
        />

        <Text style={styles.label}>Notas (opcional)</Text>
        <TextInput
          style={[styles.input, styles.notes]}
          value={notes}
          onChangeText={setNotes}
          multiline
          maxLength={2000}
          placeholder="Detalles del cubo..."
        />
        <Text style={styles.counter}>{notes.length}/2000</Text>

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

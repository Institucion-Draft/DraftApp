import React, { useEffect, useLayoutEffect, useState } from 'react';
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
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import { useTheme, useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';

type Props = NativeStackScreenProps<MainStackParamList, 'EditCube'>;

type CubeRow = {
  id: string;
  name: string;
  card_count: number | null;
  cubecobra_url: string | null;
  notes: string | null;
};

export default function EditCubeScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { cubeId } = route.params;
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState('');
  const [cardCount, setCardCount] = useState('');
  const [cubeCobraUrl, setCubeCobraUrl] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    void (async () => {
      const { data, error } = await supabase
        .from('cubes')
        .select('id, workspace_id, name, card_count, cubecobra_url, notes')
        .eq('id', cubeId)
        .maybeSingle();
      setLoading(false);

      if (error || !data) {
        Alert.alert('Error', 'No se pudo cargar el cubo.');
        navigation.goBack();
        return;
      }

      const row = data as CubeRow & { workspace_id: string };
      setWorkspaceId(row.workspace_id);
      setName(row.name);
      setCardCount(row.card_count ? String(row.card_count) : '');
      setCubeCobraUrl(row.cubecobra_url ?? '');
      setNotes(row.notes ?? '');
    })();
  }, [cubeId, navigation]);

  useLayoutEffect(() => {
    if (!workspaceId) return;
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'CubesList', { workspaceId }),
    });
  }, [navigation, workspaceId]);

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

  const onSave = async () => {
    const err = validate();
    if (err) {
      Alert.alert('Revisá los datos', err);
      return;
    }
    setSubmitting(true);
    const { error } = await supabase
      .from('cubes')
      .update({
        name: name.trim(),
        card_count: cardCount.trim() ? Number(cardCount) : null,
        cubecobra_url: cubeCobraUrl.trim() || null,
        notes: notes.trim() || null,
      })
      .eq('id', cubeId);
    setSubmitting(false);

    if (error) {
      const msg = error.message?.toLowerCase() ?? '';
      if (error.code === '23505' || msg.includes('unique') || msg.includes('duplicate')) {
        Alert.alert('Nombre en uso', 'Ya existe un cubo con ese nombre en este grupo.');
        return;
      }
      Alert.alert('Error', error.message ?? 'No se pudo guardar el cubo.');
      return;
    }
    navigation.goBack();
  };

  const onDelete = () => {
    Alert.alert('Borrar cubo', '¿Seguro que querés borrar este cubo?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Borrar',
        style: 'destructive',
        onPress: async () => {
          setSubmitting(true);
          const { error } = await supabase
            .from('cubes')
            .update({ deleted_at: new Date().toISOString() })
            .eq('id', cubeId);
          setSubmitting(false);
          if (error) {
            Alert.alert('Error', error.message ?? 'No se pudo borrar el cubo.');
            return;
          }
          navigation.goBack();
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Nombre</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} maxLength={60} />

        <Text style={styles.label}>Cantidad de cartas (opcional)</Text>
        <TextInput style={styles.input} value={cardCount} onChangeText={setCardCount} keyboardType="number-pad" />

        <Text style={styles.label}>Link de CubeCobra (opcional)</Text>
        <TextInput style={styles.input} value={cubeCobraUrl} onChangeText={setCubeCobraUrl} autoCapitalize="none" />

        <Text style={styles.label}>Notas (opcional)</Text>
        <TextInput style={[styles.input, styles.notes]} value={notes} onChangeText={setNotes} multiline maxLength={2000} />
        <Text style={styles.counter}>{notes.length}/2000</Text>

        <TouchableOpacity style={[styles.btn, submitting && styles.btnDisabled]} disabled={submitting} onPress={() => void onSave()}>
          {submitting ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.btnText}>Guardar</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={styles.deleteBtn} disabled={submitting} onPress={onDelete}>
          <Text style={styles.deleteTxt}>Borrar cubo</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: c.background },
    scroll: { padding: 24, paddingBottom: 40 },
    label: { fontSize: 15, fontWeight: '600', color: c.text, marginBottom: 8 },
    input: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 8,
      paddingVertical: 12,
      paddingHorizontal: 16,
      fontSize: 16,
      backgroundColor: c.card,
      marginBottom: 16,
      color: c.text,
    },
    notes: { minHeight: 110, textAlignVertical: 'top', marginBottom: 6 },
    counter: { textAlign: 'right', color: c.textMuted, fontSize: 12, marginBottom: 20 },
    btn: { backgroundColor: c.accent, borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
    btnDisabled: { backgroundColor: c.textMuted },
    btnText: { color: c.onAccent, fontSize: 16, fontWeight: '600' },
    deleteBtn: {
      marginTop: 20,
      borderWidth: 1,
      borderColor: c.status.error.border,
      backgroundColor: c.status.error.subtle,
      borderRadius: 8,
      paddingVertical: 12,
      alignItems: 'center',
    },
    deleteTxt: { color: c.status.error.solid, fontWeight: '600', fontSize: 15 },
  });

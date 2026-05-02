import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Switch,
  ScrollView,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { MainStackParamList } from '../navigation/mainStackParams';

type Props = NativeStackScreenProps<MainStackParamList, 'CreateWorkspace'>;

const SLUG_REGEX = /^[a-z0-9_-]{3,40}$/;
const NAME_MIN = 2;
const NAME_MAX = 50;
const DESC_MAX = 500;

function slugFromName(name: string): string {
  let s = name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 40);

  if (s.length < 3) {
    const filler = 'ws';
    s = (s + filler).replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  }
  while (s.length < 3) {
    s += 'x';
  }
  return s.slice(0, 40);
}

export default function CreateWorkspaceScreen({ navigation }: Props) {
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const onNameChange = (t: string) => {
    setName(t);
    if (!slugTouched) setSlug(slugFromName(t));
  };

  const onSlugChange = (t: string) => {
    setSlugTouched(true);
    setSlug(t.toLowerCase().replace(/[^a-z0-9_-]/g, ''));
  };

  const validate = (): string | null => {
    const n = name.trim();
    if (n.length < NAME_MIN || n.length > NAME_MAX) {
      return `El nombre debe tener entre ${NAME_MIN} y ${NAME_MAX} caracteres.`;
    }
    const sl = slug.trim();
    if (!SLUG_REGEX.test(sl)) {
      return 'El slug debe tener 3–40 caracteres: solo letras minúsculas, números, guiones y guiones bajos.';
    }
    if (description.length > DESC_MAX) {
      return `La descripción no puede superar ${DESC_MAX} caracteres.`;
    }
    return null;
  };

  const handleCreate = async () => {
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
    const { error } = await supabase.from('workspaces').insert({
      name: name.trim(),
      slug: slug.trim(),
      description: description.trim() || null,
      is_public: isPublic,
      created_by: user.id,
    });
    setSubmitting(false);

    if (error) {
      const msg = error.message?.toLowerCase() ?? '';
      const isDup =
        error.code === '23505' ||
        msg.includes('duplicate') ||
        msg.includes('unique');
      if (isDup) {
        Alert.alert('Slug en uso', 'Ese slug ya está tomado. Elegí otro.');
        return;
      }
      Alert.alert('Error', error.message ?? 'No se pudo crear el grupo de Draft.');
      return;
    }

    navigation.goBack();
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.label}>Nombre</Text>
        <TextInput
          style={styles.input}
          placeholder="Nombre del grupo de Draft"
          value={name}
          onChangeText={onNameChange}
          editable={!submitting}
          maxLength={NAME_MAX}
        />

        <Text style={styles.label}>Slug (URL)</Text>
        <Text style={styles.hint}>
          Se genera desde el nombre; podés editarlo. Solo minúsculas, números,
          guiones y guiones bajos.
        </Text>
        <TextInput
          style={styles.input}
          placeholder="mi-grupo-draft"
          value={slug}
          onChangeText={onSlugChange}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!submitting}
          maxLength={40}
        />

        <Text style={styles.label}>Descripción (opcional)</Text>
        <TextInput
          style={[styles.input, styles.textArea]}
          placeholder="De qué se trata este grupo…"
          value={description}
          onChangeText={setDescription}
          editable={!submitting}
          multiline
          maxLength={DESC_MAX}
        />
        <Text style={styles.counter}>
          {description.length}/{DESC_MAX}
        </Text>

        <View style={styles.switchRow}>
          <View style={styles.switchLabels}>
            <Text style={styles.labelInline}>Grupo público</Text>
            <Text style={styles.hintSmall}>
              Si está activado, otros usuarios podrán encontrarlo más adelante.
            </Text>
          </View>
          <Switch
            value={isPublic}
            onValueChange={setIsPublic}
            disabled={submitting}
            trackColor={{ false: '#D1D5DB', true: '#93C5FD' }}
            thumbColor={isPublic ? '#3B82F6' : '#f4f3f4'}
          />
        </View>

        <TouchableOpacity
          style={[styles.button, submitting && styles.buttonDisabled]}
          onPress={() => {
            void handleCreate();
          }}
          disabled={submitting}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Crear</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  scroll: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 32,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111',
    marginBottom: 8,
  },
  labelInline: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111',
    marginBottom: 4,
  },
  hint: {
    fontSize: 13,
    color: '#666',
    marginBottom: 8,
    lineHeight: 18,
  },
  hintSmall: {
    fontSize: 13,
    color: '#666',
    lineHeight: 18,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    marginBottom: 16,
    backgroundColor: '#fafafa',
  },
  textArea: {
    minHeight: 100,
    textAlignVertical: 'top',
    marginBottom: 4,
  },
  counter: {
    fontSize: 12,
    color: '#999',
    textAlign: 'right',
    marginBottom: 20,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 28,
    gap: 16,
  },
  switchLabels: {
    flex: 1,
    minWidth: 0,
  },
  button: {
    backgroundColor: '#3B82F6',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonDisabled: {
    backgroundColor: '#9CA3AF',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});

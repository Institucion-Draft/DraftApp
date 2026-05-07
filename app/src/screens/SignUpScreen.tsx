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
  Modal,
  Keyboard,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useAuth } from '../contexts/AuthContext';
import type { Gender } from '../lib/genderText';

type Props = {
  onNavigateToLogin: () => void;
};

export default function SignUpScreen({ onNavigateToLogin }: Props) {
  const { signUp } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [gender, setGender] = useState<Gender | null>(null);
  const [birthDate, setBirthDate] = useState<Date | null>(null);
  const [showBirthPicker, setShowBirthPicker] = useState(false);
  const [loading, setLoading] = useState(false);

  const genderOptions: Array<{ id: Gender; label: string }> = [
    { id: 'male', label: 'Hombre' },
    { id: 'female', label: 'Mujer' },
    { id: 'other', label: 'Otro' },
    { id: 'prefer_not_to_say', label: 'Prefiero no decir' },
  ];

  const openBirthPicker = () => {
    Keyboard.dismiss();
    setShowBirthPicker(true);
  };

  const handleSignUp = async () => {
    if (!email || !password || !passwordConfirm) {
      Alert.alert('Error', 'Completá todos los campos');
      return;
    }

    if (password.length < 6) {
      Alert.alert('Error', 'La contraseña tiene que tener al menos 6 caracteres');
      return;
    }

    if (password !== passwordConfirm) {
      Alert.alert('Error', 'Las contraseñas no coinciden');
      return;
    }

    if (!gender) {
      Alert.alert('Error', 'Elegí un género');
      return;
    }

    if (!birthDate || Number.isNaN(birthDate.getTime())) {
      Alert.alert('Error', 'Cargá una fecha de nacimiento válida');
      return;
    }

    setLoading(true);
    const { error } = await signUp(
      email.trim(),
      password,
      gender,
      birthDate.toISOString().slice(0, 10)
    );
    setLoading(false);

    if (error) {
      Alert.alert('Error de registro', error);
    } else {
      Alert.alert(
        'Cuenta creada',
        'Ya podés usar la app. Tu avatar default fue asignado al azar.'
      );
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.content}>
        <Text style={styles.title}>DraftApp</Text>
        <Text style={styles.subtitle}>Crear cuenta</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          editable={!loading}
        />

        <TextInput
          style={styles.input}
          placeholder="Contraseña (mínimo 6 caracteres)"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          editable={!loading}
        />

        <TextInput
          style={styles.input}
          placeholder="Confirmar contraseña"
          value={passwordConfirm}
          onChangeText={setPasswordConfirm}
          secureTextEntry
          editable={!loading}
        />

        <Text style={styles.fieldLabel}>Género</Text>
        <View style={styles.genderGrid}>
          {genderOptions.map((option) => {
            const selected = gender === option.id;
            return (
              <TouchableOpacity
                key={option.id}
                style={[styles.genderBtn, selected ? styles.genderBtnSelected : null]}
                onPress={() => setGender(option.id)}
                disabled={loading}
              >
                <Text style={[styles.genderBtnText, selected ? styles.genderBtnTextSelected : null]}>
                  {option.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.fieldLabel}>Fecha de nacimiento</Text>
        <TouchableOpacity
          style={styles.dateBtn}
          onPress={openBirthPicker}
          disabled={loading}
        >
          <Text style={birthDate ? styles.dateBtnText : styles.dateBtnPlaceholder}>
            {birthDate
              ? birthDate.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })
              : 'Seleccionar fecha'}
          </Text>
        </TouchableOpacity>
        {showBirthPicker ? (
          Platform.OS === 'ios' ? (
            <Modal
              visible={showBirthPicker}
              transparent
              animationType="fade"
              onRequestClose={() => setShowBirthPicker(false)}
            >
              <View style={styles.dateModalOverlay}>
                <View style={styles.dateModalCard}>
                  <View style={styles.dateModalHeader}>
                    <TouchableOpacity onPress={() => setShowBirthPicker(false)}>
                      <Text style={styles.dateModalDone}>Listo</Text>
                    </TouchableOpacity>
                  </View>
                  <DateTimePicker
                    value={birthDate ?? new Date(2000, 0, 1)}
                    mode="date"
                    display="spinner"
                    maximumDate={new Date()}
                    onChange={(_event, date) => {
                      if (date) setBirthDate(date);
                    }}
                  />
                </View>
              </View>
            </Modal>
          ) : (
            <DateTimePicker
              value={birthDate ?? new Date(2000, 0, 1)}
              mode="date"
              display="default"
              maximumDate={new Date()}
              onChange={(_event, date) => {
                setShowBirthPicker(false);
                if (date) setBirthDate(date);
              }}
            />
          )
        ) : null}

        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleSignUp}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Crear cuenta</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          onPress={onNavigateToLogin}
          disabled={loading}
          style={styles.linkContainer}
        >
          <Text style={styles.linkText}>
            ¿Ya tenés cuenta? <Text style={styles.linkBold}>Iniciar sesión</Text>
          </Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 36,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 18,
    textAlign: 'center',
    color: '#666',
    marginBottom: 40,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    marginBottom: 12,
    backgroundColor: '#fafafa',
  },
  fieldLabel: { fontSize: 14, color: '#374151', fontWeight: '600', marginBottom: 8, marginTop: 4 },
  genderGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  genderBtn: {
    width: '48%',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  genderBtnSelected: { backgroundColor: '#3B82F6', borderColor: '#3B82F6' },
  genderBtnText: { fontSize: 13, color: '#374151', fontWeight: '600' },
  genderBtnTextSelected: { color: '#fff' },
  dateBtn: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 12,
    backgroundColor: '#fafafa',
  },
  dateBtnText: { fontSize: 16, color: '#111827' },
  dateBtnPlaceholder: { fontSize: 16, color: '#9CA3AF' },
  dateModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
    padding: 12,
  },
  dateModalCard: {
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
  },
  dateModalHeader: { flexDirection: 'row', justifyContent: 'flex-end' },
  dateModalDone: { color: '#3B82F6', fontWeight: '600', fontSize: 16 },
  button: {
    backgroundColor: '#3B82F6',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: {
    backgroundColor: '#9CA3AF',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  linkContainer: {
    marginTop: 24,
    alignItems: 'center',
  },
  linkText: {
    fontSize: 14,
    color: '#666',
  },
  linkBold: {
    color: '#3B82F6',
    fontWeight: '600',
  },
});
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
  ScrollView,
} from 'react-native';
import { useAuth } from '../contexts/AuthContext';
import type { Gender } from '../lib/genderText';
import {
  MONTH_NAMES,
  birthDateInputState,
  birthDateValue,
  birthDateWarning,
  canSubmitBirth,
  dayAfterMonthChange,
  dayOptions,
} from '../lib/birthDayMonth';
import { useTheme, useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';

type Props = {
  onNavigateToLogin: () => void;
  /** Cuenta creada: vuelve al login y saca esta pantalla del historial (el formulario se descarta con ella). */
  onSignUpComplete: () => void;
};

export default function SignUpScreen({ onNavigateToLogin, onSignUpComplete }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { signUp } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [gender, setGender] = useState<Gender | null>(null);
  // Cumpleaños OPCIONAL: solo día y mes, vacíos al empezar. Si hay uno solo no se puede crear la cuenta (completar o vaciar). Con los dos
  // se manda 2000-MM-DD (el año no se pide).
  const [birthDay, setBirthDay] = useState<number | null>(null);
  const [birthMonth, setBirthMonth] = useState<number | null>(null);
  const [openPicker, setOpenPicker] = useState<'day' | 'month' | null>(null);
  const birthState = birthDateInputState(birthDay, birthMonth);
  const birthOk = canSubmitBirth(birthState);
  const birthWarning = birthDateWarning(birthState);
  const birthDate = birthDateValue(birthState);
  const [loading, setLoading] = useState(false);

  const genderOptions: Array<{ id: Gender; label: string }> = [
    { id: 'male', label: 'Hombre' },
    { id: 'female', label: 'Mujer' },
    { id: 'other', label: 'Otro' },
    { id: 'prefer_not_to_say', label: 'Prefiero no decir' },
  ];

  const openBirthPicker = (which: 'day' | 'month') => {
    Keyboard.dismiss();
    setOpenPicker(which);
  };

  const pickMonth = (month: number) => {
    setBirthMonth(month);
    // El día elegido se conserva solo si existe en el mes nuevo (31 en abril, 30 en febrero... hay que elegirlo de nuevo).
    setBirthDay((d) => dayAfterMonthChange(d, month));
    setOpenPicker(null);
  };

  const pickerOptions: { value: number; label: string }[] =
    openPicker === 'month'
      ? MONTH_NAMES.map((name, i) => ({ value: i + 1, label: name }))
      : dayOptions(birthMonth).map((d) => ({ value: d, label: String(d) }));

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

    // Género y cumpleaños son opcionales; un cumpleaños a medias no se envía (el botón ya está deshabilitado).
    if (!birthOk) return;

    setLoading(true);
    const { error, needsEmailConfirmation } = await signUp(
      email.trim(),
      password,
      gender,
      birthDate
    );
    setLoading(false);

    if (error) {
      Alert.alert('Error de registro', error);
      return;
    }

    // Se cierra el selector de día/mes (Modal) y se vuelve al login; el aviso sale recién después, con la pantalla de
    // registro y su Modal ya fuera: un Alert.alert (también un Modal) no se puede presentar encima de otro en iOS.
    setOpenPicker(null);
    if (needsEmailConfirmation) onSignUpComplete();
    // Con sesión creada de inmediato, el navegador raíz pasa solo a la app; no hay que volver al login.
    setTimeout(() => {
      if (needsEmailConfirmation) {
        Alert.alert(
          'Cuenta creada',
          'Te enviamos un email de confirmación. Abrilo para poder iniciar sesión.'
        );
      } else {
        Alert.alert('Cuenta creada', 'Ya podés usar la app.');
      }
    }, 350);
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
          placeholderTextColor={colors.textMuted}
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
          placeholderTextColor={colors.textMuted}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          editable={!loading}
        />

        <TextInput
          style={styles.input}
          placeholder="Confirmar contraseña"
          placeholderTextColor={colors.textMuted}
          value={passwordConfirm}
          onChangeText={setPasswordConfirm}
          secureTextEntry
          editable={!loading}
        />

        <Text style={styles.fieldLabel}>Género (opcional)</Text>
        <View style={styles.genderGrid}>
          {genderOptions.map((option) => {
            const selected = gender === option.id;
            return (
              <TouchableOpacity
                key={option.id}
                style={[styles.genderBtn, selected ? styles.genderBtnSelected : null]}
                onPress={() => setGender((g) => (g === option.id ? null : option.id))}
                disabled={loading}
              >
                <Text style={[styles.genderBtnText, selected ? styles.genderBtnTextSelected : null]}>
                  {option.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.fieldLabel}>Cumpleaños (opcional)</Text>
        <View style={styles.birthRow}>
          <View style={[styles.dateBtn, styles.birthCol, styles.birthSelect]}>
            <TouchableOpacity style={styles.birthSelectMain} onPress={() => openBirthPicker('day')} disabled={loading}>
              <Text style={birthDay != null ? styles.dateBtnText : styles.dateBtnPlaceholder}>
                {birthDay != null ? String(birthDay) : 'Día'}
              </Text>
            </TouchableOpacity>
            {birthDay != null ? (
              <TouchableOpacity onPress={() => setBirthDay(null)} disabled={loading} hitSlop={10} accessibilityLabel="Vaciar el día">
                <Text style={styles.clearTxt}>✕</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <View style={[styles.dateBtn, styles.birthColWide, styles.birthSelect]}>
            <TouchableOpacity style={styles.birthSelectMain} onPress={() => openBirthPicker('month')} disabled={loading}>
              <Text style={birthMonth != null ? styles.dateBtnText : styles.dateBtnPlaceholder}>
                {birthMonth != null ? MONTH_NAMES[birthMonth - 1] : 'Mes'}
              </Text>
            </TouchableOpacity>
            {birthMonth != null ? (
              <TouchableOpacity onPress={() => setBirthMonth(null)} disabled={loading} hitSlop={10} accessibilityLabel="Vaciar el mes">
                <Text style={styles.clearTxt}>✕</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
        {birthWarning ? <Text style={styles.birthWarning}>{birthWarning}</Text> : null}
        <Modal visible={openPicker !== null} transparent animationType="fade" onRequestClose={() => setOpenPicker(null)}>
          <View style={styles.dateModalOverlay}>
            <View style={styles.dateModalCard}>
              <View style={styles.dateModalHeader}>
                <Text style={styles.pickerTitle}>{openPicker === 'month' ? 'Mes' : 'Día'}</Text>
                <TouchableOpacity onPress={() => setOpenPicker(null)}>
                  <Text style={styles.dateModalDone}>Cerrar</Text>
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.pickerList}>
                {pickerOptions.map((o) => {
                  const selected = openPicker === 'month' ? birthMonth === o.value : birthDay === o.value;
                  return (
                    <TouchableOpacity
                      key={o.value}
                      style={[styles.pickerItem, selected ? styles.pickerItemSelected : null]}
                      onPress={() => {
                        if (openPicker === 'month') pickMonth(o.value);
                        else {
                          setBirthDay(o.value);
                          setOpenPicker(null);
                        }
                      }}
                    >
                      <Text style={[styles.pickerItemText, selected ? styles.pickerItemTextSelected : null]}>{o.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          </View>
        </Modal>

        <TouchableOpacity
          style={[styles.button, (loading || !birthOk) && styles.buttonDisabled]}
          onPress={handleSignUp}
          disabled={loading || !birthOk}
        >
          {loading ? (
            <ActivityIndicator color={colors.onAccent} />
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

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
    },
    content: {
      flex: 1,
      justifyContent: 'center',
      paddingHorizontal: 24,
    },
    title: {
      fontSize: 36,
      fontWeight: 'bold',
      color: c.text,
      textAlign: 'center',
      marginBottom: 8,
    },
    subtitle: {
      fontSize: 18,
      textAlign: 'center',
      color: c.textSecondary,
      marginBottom: 40,
    },
    input: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 8,
      paddingVertical: 12,
      paddingHorizontal: 16,
      fontSize: 16,
      marginBottom: 12,
      backgroundColor: c.card,
      color: c.text,
    },
    fieldLabel: { fontSize: 14, color: c.textBody, fontWeight: '600', marginBottom: 8, marginTop: 4 },
    genderGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
    genderBtn: {
      width: '48%',
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 8,
      paddingVertical: 10,
      alignItems: 'center',
      backgroundColor: c.background,
    },
    genderBtnSelected: { backgroundColor: c.accent, borderColor: c.accent },
    genderBtnText: { fontSize: 13, color: c.textBody, fontWeight: '600' },
    genderBtnTextSelected: { color: c.onAccent },
    dateBtn: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 8,
      paddingVertical: 12,
      paddingHorizontal: 16,
      marginBottom: 12,
      backgroundColor: c.card,
    },
    dateBtnText: { fontSize: 16, color: c.text },
    dateBtnPlaceholder: { fontSize: 16, color: c.textMuted },
    dateModalOverlay: {
      flex: 1,
      backgroundColor: c.overlay,
      justifyContent: 'flex-end',
      padding: 12,
    },
    dateModalCard: {
      backgroundColor: c.background,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderRadius: 12,
    },
    dateModalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    birthRow: { flexDirection: 'row', gap: 8 },
    birthCol: { flex: 1 },
    birthColWide: { flex: 2 },
    birthSelect: { flexDirection: 'row', alignItems: 'center' },
    birthSelectMain: { flex: 1 },
    clearTxt: { fontSize: 16, color: c.textMuted, paddingLeft: 8 },
    birthWarning: { fontSize: 12, color: c.status.error.text, marginBottom: 8 },
    pickerTitle: { fontSize: 16, fontWeight: '700', color: c.text },
    pickerList: { maxHeight: 320, marginTop: 8 },
    pickerItem: { paddingVertical: 12, paddingHorizontal: 12, borderRadius: 8 },
    pickerItemSelected: { backgroundColor: c.accent },
    pickerItemText: { fontSize: 16, color: c.text },
    pickerItemTextSelected: { color: c.onAccent, fontWeight: '700' },
    dateModalDone: { color: c.accent, fontWeight: '600', fontSize: 16 },
    button: {
      backgroundColor: c.accent,
      paddingVertical: 14,
      borderRadius: 8,
      alignItems: 'center',
      marginTop: 8,
    },
    buttonDisabled: {
      backgroundColor: c.textMuted,
    },
    buttonText: {
      color: c.onAccent,
      fontSize: 16,
      fontWeight: '600',
    },
    linkContainer: {
      marginTop: 24,
      alignItems: 'center',
    },
    linkText: {
      fontSize: 14,
      color: c.textSecondary,
    },
    linkBold: {
      color: c.accent,
      fontWeight: '600',
    },
  });
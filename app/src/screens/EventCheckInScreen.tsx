import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import type { MtgColor } from '../lib/database.types';

type Props = NativeStackScreenProps<MainStackParamList, 'EventCheckIn'>;

/** Mazo: solo W/U/B/R/G (sin incoloro en la app). */
const DECK_COLOR_OPTIONS: { key: MtgColor; bg: string; text: string }[] = [
  { key: 'W', bg: '#F8FAFC', text: '#111827' },
  { key: 'U', bg: '#DBEAFE', text: '#1E3A8A' },
  { key: 'B', bg: '#1F2937', text: '#F9FAFB' },
  { key: 'R', bg: '#FEE2E2', text: '#991B1B' },
  { key: 'G', bg: '#DCFCE7', text: '#166534' },
];

const PRODEC_COLOR_OPTIONS = DECK_COLOR_OPTIONS;

type ParticipantRow = { id: string; self_evaluation: number | null };
type MemberRole = 'a' | 'b';

function sameColorSet(a: MtgColor[], b: MtgColor[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((c, i) => c === sb[i]);
}

export default function EventCheckInScreen({ route, navigation }: Props) {
  const {
    eventId,
    returnTo = 'EventDetail',
    pairingId,
    participantId: backProfileParticipantId,
    profileReturnFrom,
  } = route.params;
  useLayoutEffect(() => {
    const profileBackFrom = profileReturnFrom ?? 'EventDetail';
    const backParams =
      returnTo === 'PairingDetail' && pairingId
        ? { pairingId }
        : returnTo === 'PlayerProfileInEvent' && backProfileParticipantId
        ? { eventId, participantId: backProfileParticipantId, from: profileBackFrom }
        : returnTo === 'PairingsList'
        ? { eventId }
        : { eventId };
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, returnTo, backParams),
    });
  }, [navigation, eventId, returnTo, pairingId, backProfileParticipantId, profileReturnFrom]);
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [memberRole, setMemberRole] = useState<MemberRole>('a');
  const [selectedColors, setSelectedColors] = useState<MtgColor[]>([]);
  const [baselineColors, setBaselineColors] = useState<MtgColor[] | null>(null);
  const [selfEval, setSelfEval] = useState<number | null>(null);
  const [isFirstDeclaration, setIsFirstDeclaration] = useState(true);
  /** Solo primera declaración: 1 = colores, 2 = ProDeC, 3 = valoración. */
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);
  const [predictedColor, setPredictedColor] = useState<MtgColor | null>(null);

  useEffect(() => {
    setWizardStep(1);
    setPredictedColor(null);
  }, [eventId, user?.id]);

  useEffect(() => {
    void (async () => {
      if (!user?.id) {
        setLoading(false);
        return;
      }

      // Detectar si el usuario es miembro A (tiene fila propia) o miembro B
      // (absorbido en la fila del gigante vía member_b_user_id).
      let pid: string | null = null;
      let role: MemberRole = 'a';
      let selfEvalRaw: number | null = null;

      const memberARes = await supabase
        .from('event_participants')
        .select('id, self_evaluation')
        .eq('event_id', eventId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (memberARes.error) {
        Alert.alert('Error', 'No se pudo cargar Mi mazo.');
        setLoading(false);
        return;
      }

      if (memberARes.data) {
        const p = memberARes.data as ParticipantRow;
        pid = p.id;
        role = 'a';
        selfEvalRaw = p.self_evaluation;
      } else {
        // Intentar como miembro B de un gigante.
        const memberBRes = await supabase
          .from('event_participants')
          .select('id, self_evaluation')
          .eq('event_id', eventId)
          .eq('member_b_user_id', user.id)
          .maybeSingle();

        if (!memberBRes.error && memberBRes.data) {
          const p = memberBRes.data as ParticipantRow;
          pid = p.id; // ID del gigante (fila del miembro A)
          role = 'b';
          selfEvalRaw = p.self_evaluation;
        }
      }

      setParticipantId(pid);
      setMemberRole(role);
      setSelfEval(selfEvalRaw);

      if (pid) {
        const colorsRes = await supabase
          .from('participant_colors')
          .select('color')
          .eq('participant_id', pid)
          .eq('member', role);

        if (colorsRes.error) {
          setSelectedColors([]);
          setBaselineColors([]);
          setIsFirstDeclaration(true);
          const predRes = await supabase
            .from('event_color_predictions')
            .select('predicted_color')
            .eq('event_id', eventId)
            .eq('user_id', user.id)
            .maybeSingle();
          if (!predRes.error && predRes.data?.predicted_color) {
            setPredictedColor(predRes.data.predicted_color as MtgColor);
          }
        } else {
          const loaded = (colorsRes.data ?? []).map((c) => c.color as MtgColor).filter((c) => c !== 'C');
          setSelectedColors(loaded);
          setBaselineColors([...loaded]);
          const first = loaded.length === 0;
          setIsFirstDeclaration(first);
          if (first) {
            const predRes = await supabase
              .from('event_color_predictions')
              .select('predicted_color')
              .eq('event_id', eventId)
              .eq('user_id', user.id)
              .maybeSingle();
            if (!predRes.error && predRes.data?.predicted_color) {
              setPredictedColor(predRes.data.predicted_color as MtgColor);
            }
          }
        }
      }
      setLoading(false);
    })();
  }, [eventId, user?.id]);

  const toggleColor = (color: MtgColor) => {
    setSelectedColors((prev) => (prev.includes(color) ? prev.filter((c) => c !== color) : [...prev, color]));
  };

  const sortedColors = useMemo(
    () => DECK_COLOR_OPTIONS.map((o) => o.key).filter((k) => selectedColors.includes(k)),
    [selectedColors]
  );

  const colorsDirty = baselineColors != null && !sameColorSet(selectedColors, baselineColors);
  const editSaveDisabled = !colorsDirty || selectedColors.length < 1;

  const navigateAfterSave = () => {
    if (returnTo === 'PlayerProfileInEvent' && backProfileParticipantId) {
      navigation.navigate('PlayerProfileInEvent', {
        eventId,
        participantId: backProfileParticipantId,
        from: profileReturnFrom ?? 'EventDetail',
      });
      return;
    }
    if (returnTo === 'PairingDetail' && pairingId) {
      navigation.navigate('PairingDetail', { pairingId });
      return;
    }
    navigation.navigate('PairingsList', { eventId });
  };

  const persistWizard = async (opts: { withEvaluation: boolean }) => {
    if (!user?.id) {
      Alert.alert('Error', 'No hay sesión activa.');
      return;
    }
    setSaving(true);
    const pid = participantId;
    if (!pid) {
      setSaving(false);
      Alert.alert('Error', 'No estás inscripto en este evento.');
      return;
    }

    const updateRes = await supabase
      .from('event_participants')
      .update({ self_evaluation: opts.withEvaluation ? selfEval : null })
      .eq('id', pid);
    if (updateRes.error) {
      setSaving(false);
      Alert.alert('Error', updateRes.error.message ?? 'No se pudo guardar Mi mazo.');
      return;
    }

    const delRes = await supabase
      .from('participant_colors')
      .delete()
      .eq('participant_id', pid)
      .eq('member', memberRole);
    if (delRes.error) {
      setSaving(false);
      Alert.alert('Error', 'No se pudieron actualizar tus colores.');
      return;
    }
    if (sortedColors.length > 0) {
      const ins = await supabase
        .from('participant_colors')
        .insert(sortedColors.map((c) => ({ participant_id: pid, color: c, member: memberRole })));
      if (ins.error) {
        setSaving(false);
        console.error('[persistWizard] INSERT participant_colors error:', ins.error);
        Alert.alert('Error', 'No se pudieron guardar tus colores.');
        return;
      }
    }

    if (predictedColor && user?.id) {
      const predUpsert = await supabase.from('event_color_predictions').upsert(
        {
          event_id: eventId,
          user_id: user.id,
          predicted_color: predictedColor,
          voted_at: new Date().toISOString(),
        },
        { onConflict: 'event_id,user_id' }
      );
      if (predUpsert.error) {
        setSaving(false);
        Alert.alert('Error', predUpsert.error.message ?? 'No se pudo guardar tu predicción ProDeC.');
        return;
      }
    }

    setSaving(false);
    setBaselineColors([...sortedColors]);
    navigateAfterSave();
  };

  const persistEditColorsOnly = async () => {
    if (!user?.id || editSaveDisabled) return;
    setSaving(true);
    const pid = participantId;
    if (!pid) {
      setSaving(false);
      Alert.alert('Error', 'No estás inscripto en este evento.');
      return;
    }

    const delRes = await supabase
      .from('participant_colors')
      .delete()
      .eq('participant_id', pid)
      .eq('member', memberRole);
    if (delRes.error) {
      setSaving(false);
      Alert.alert('Error', 'No se pudieron actualizar tus colores.');
      return;
    }
    if (sortedColors.length > 0) {
      const ins = await supabase
        .from('participant_colors')
        .insert(sortedColors.map((c) => ({ participant_id: pid, color: c, member: memberRole })));
      if (ins.error) {
        setSaving(false);
        Alert.alert('Error', 'No se pudieron guardar tus colores.');
        return;
      }
    }

    setSaving(false);
    setBaselineColors([...sortedColors]);
    navigateAfterSave();
  };

  const onWizardContinue = () => {
    if (selectedColors.length < 1) {
      Alert.alert('Revisá los datos', 'Elegí al menos un color para continuar.');
      return;
    }
    setWizardStep(2);
  };

  const onProDecContinue = () => {
    if (predictedColor == null) {
      Alert.alert('Revisá los datos', 'Elegí un color para continuar.');
      return;
    }
    setWizardStep(3);
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  const showWizard = isFirstDeclaration;

  if (showWizard && wizardStep === 1) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>¿Qué colores sos?</Text>
        <View style={styles.colorsWrap}>
          {DECK_COLOR_OPTIONS.map((opt) => {
            const active = selectedColors.includes(opt.key);
            return (
              <TouchableOpacity
                key={opt.key}
                style={[styles.colorPill, { backgroundColor: opt.bg }, active && styles.colorPillActive]}
                onPress={() => toggleColor(opt.key)}
              >
                <Text style={[styles.colorTxt, { color: opt.text }]}>{opt.key}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <TouchableOpacity style={styles.saveBtn} onPress={onWizardContinue}>
          <Text style={styles.saveBtnTxt}>Continuar</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  if (showWizard && wizardStep === 2) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>¿Cuál pensás que fue el color más pickeado?</Text>
        <Text style={styles.label}>Tu predicción</Text>
        <View style={styles.colorsWrap}>
          {PRODEC_COLOR_OPTIONS.map((opt) => {
            const active = predictedColor === opt.key;
            return (
              <TouchableOpacity
                key={opt.key}
                style={[styles.colorPill, { backgroundColor: opt.bg }, active && styles.colorPillActive]}
                onPress={() => setPredictedColor(opt.key)}
              >
                <Text style={[styles.colorTxt, { color: opt.text }]}>{opt.key}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <TouchableOpacity style={styles.saveBtn} onPress={onProDecContinue}>
          <Text style={styles.saveBtnTxt}>Continuar</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  if (showWizard && wizardStep === 3) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>¿Qué tan sólido ves tu mazo hoy?</Text>
        <Text style={styles.label}>Autoevaluación (1 a 10)</Text>
        <View style={styles.starsWrap}>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
            const active = selfEval != null && n <= selfEval;
            return (
              <TouchableOpacity key={n} onPress={() => setSelfEval(n)} style={styles.starBtn}>
                <Text style={[styles.star, active && styles.starActive]}>★</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <TouchableOpacity
          style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
          onPress={() => void persistWizard({ withEvaluation: true })}
          disabled={saving}
        >
          {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnTxt}>Guardar</Text>}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.secondaryBtn, saving && styles.saveBtnDisabled]}
          onPress={() => void persistWizard({ withEvaluation: false })}
          disabled={saving}
        >
          <Text style={styles.secondaryBtnTxt}>Omitir</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      <Text style={styles.title}>Editar colores</Text>
      <Text style={styles.label}>Colores jugados</Text>
      <View style={styles.colorsWrap}>
        {DECK_COLOR_OPTIONS.map((opt) => {
          const active = selectedColors.includes(opt.key);
          return (
            <TouchableOpacity
              key={opt.key}
              style={[styles.colorPill, { backgroundColor: opt.bg }, active && styles.colorPillActive]}
              onPress={() => toggleColor(opt.key)}
            >
              <Text style={[styles.colorTxt, { color: opt.text }]}>{opt.key}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <TouchableOpacity
        style={[styles.saveBtn, (saving || editSaveDisabled) && styles.saveBtnDisabled]}
        onPress={() => void persistEditColorsOnly()}
        disabled={saving || editSaveDisabled}
      >
        {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnTxt}>Guardar</Text>}
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  scroll: { padding: 24, paddingBottom: 38 },
  title: { fontSize: 20, fontWeight: '700', color: '#111', marginBottom: 14 },
  label: { fontSize: 15, color: '#111', fontWeight: '600', marginBottom: 10 },
  colorsWrap: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 24 },
  colorPill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    marginRight: 8,
    marginBottom: 8,
  },
  colorPillActive: { borderColor: '#3B82F6', borderWidth: 2 },
  colorTxt: { fontSize: 14, fontWeight: '700' },
  starsWrap: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  starBtn: { padding: 4, marginRight: 4 },
  star: { fontSize: 28, color: '#D1D5DB' },
  starActive: { color: '#F59E0B' },
  saveBtn: { backgroundColor: '#3B82F6', borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  saveBtnDisabled: { backgroundColor: '#9CA3AF' },
  saveBtnTxt: { color: '#fff', fontSize: 16, fontWeight: '600' },
  secondaryBtn: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
  },
  secondaryBtnTxt: { color: '#374151', fontSize: 16, fontWeight: '600' },
});

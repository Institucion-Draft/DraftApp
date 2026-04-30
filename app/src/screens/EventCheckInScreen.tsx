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

const COLOR_OPTIONS: { key: MtgColor; bg: string; text: string }[] = [
  { key: 'W', bg: '#F8FAFC', text: '#111827' },
  { key: 'U', bg: '#DBEAFE', text: '#1E3A8A' },
  { key: 'B', bg: '#1F2937', text: '#F9FAFB' },
  { key: 'R', bg: '#FEE2E2', text: '#991B1B' },
  { key: 'G', bg: '#DCFCE7', text: '#166534' },
  { key: 'C', bg: '#E5E7EB', text: '#374151' },
];

type ParticipantRow = { id: string; self_evaluation: number | null };

export default function EventCheckInScreen({ route, navigation }: Props) {
  const { eventId } = route.params;
  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'EventDetail', { eventId }),
    });
  }, [navigation, eventId]);
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [selectedColors, setSelectedColors] = useState<MtgColor[]>([]);
  const [selfEval, setSelfEval] = useState<number | null>(null);
  const [isFirstDeclaration, setIsFirstDeclaration] = useState(true);

  useEffect(() => {
    void (async () => {
      if (!user?.id) {
        setLoading(false);
        return;
      }
      const { data, error } = await supabase
        .from('event_participants')
        .select('id, self_evaluation')
        .eq('event_id', eventId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) {
        Alert.alert('Error', 'No se pudo cargar tu check-in.');
        setLoading(false);
        return;
      }

      if (data) {
        const p = data as ParticipantRow;
        setParticipantId(p.id);
        setSelfEval(p.self_evaluation);
        const colorsRes = await supabase
          .from('participant_colors')
          .select('color')
          .eq('participant_id', p.id);
        if (!colorsRes.error) {
          const loaded = (colorsRes.data ?? []).map((c) => c.color as MtgColor);
          setSelectedColors(loaded);
          setIsFirstDeclaration(loaded.length === 0);
        }
      }
      setLoading(false);
    })();
  }, [eventId, user?.id]);

  const toggleColor = (color: MtgColor) => {
    setSelectedColors((prev) => (prev.includes(color) ? prev.filter((c) => c !== color) : [...prev, color]));
  };

  const sortedColors = useMemo(
    () => COLOR_OPTIONS.map((o) => o.key).filter((k) => selectedColors.includes(k)),
    [selectedColors]
  );

  const onSave = async () => {
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
    const updateRes = await supabase.from('event_participants').update({ self_evaluation: selfEval }).eq('id', pid);
    if (updateRes.error) {
      setSaving(false);
      Alert.alert('Error', updateRes.error.message ?? 'No se pudo actualizar tu check-in.');
      return;
    }

    const delRes = await supabase.from('participant_colors').delete().eq('participant_id', pid);
    if (delRes.error) {
      setSaving(false);
      Alert.alert('Error', 'No se pudieron actualizar tus colores.');
      return;
    }
    if (sortedColors.length > 0) {
      const ins = await supabase
        .from('participant_colors')
        .insert(sortedColors.map((c) => ({ participant_id: pid, color: c })));
      if (ins.error) {
        setSaving(false);
        Alert.alert('Error', 'No se pudieron guardar tus colores.');
        return;
      }
    }

    setSaving(false);
    navigation.goBack();
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      <Text style={styles.title}>
        {isFirstDeclaration
          ? 'Colores de tu mazo y valoración'
          : 'Editar mis colores y valoración'}
      </Text>
      <Text style={styles.label}>Colores jugados</Text>
      <View style={styles.colorsWrap}>
        {COLOR_OPTIONS.map((opt) => {
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
      <TouchableOpacity onPress={() => setSelfEval(null)} style={styles.skipBtn}>
        <Text style={styles.skipTxt}>Saltear</Text>
      </TouchableOpacity>

      <TouchableOpacity style={[styles.saveBtn, saving && styles.saveBtnDisabled]} onPress={() => void onSave()} disabled={saving}>
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
  skipBtn: { alignSelf: 'flex-start', marginBottom: 24 },
  skipTxt: { color: '#666', fontSize: 14, fontWeight: '600' },
  saveBtn: { backgroundColor: '#3B82F6', borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  saveBtnDisabled: { backgroundColor: '#9CA3AF' },
  saveBtnTxt: { color: '#fff', fontSize: 16, fontWeight: '600' },
});

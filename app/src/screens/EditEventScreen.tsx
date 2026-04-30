import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  Platform,
} from 'react-native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import type { EventStatus, EventType } from '../lib/database.types';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { getEventStatusLabel, getEventTypeLabel } from '../lib/labels';

type Props = NativeStackScreenProps<MainStackParamList, 'EditEvent'>;
type SimpleOption = { id: string; name: string };

const EVENT_TYPES: { value: EventType; label: string }[] = [
  { value: 'draft', label: getEventTypeLabel('draft') },
  { value: 'tournament', label: getEventTypeLabel('tournament') },
  { value: 'pepidraft', label: getEventTypeLabel('pepidraft') },
];
const STATUS_OPTIONS: EventStatus[] = ['scheduled', 'drafting', 'playing', 'completed', 'cancelled'];

function pick(title: string, opts: { label: string; onPress: () => void }[]) {
  Alert.alert(title, undefined, [...opts.map((o) => ({ text: o.label, onPress: o.onPress })), { text: 'Cancelar', style: 'cancel' }]);
}

export default function EditEventScreen({ route, navigation }: Props) {
  const { eventId } = route.params;
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [eventType, setEventType] = useState<EventType>('draft');
  const [status, setStatus] = useState<EventStatus>('scheduled');
  const [scheduledFor, setScheduledFor] = useState(new Date());
  const [showIosPicker, setShowIosPicker] = useState(false);
  const [cubeId, setCubeId] = useState<string | null>(null);
  const [venueId, setVenueId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [cubes, setCubes] = useState<SimpleOption[]>([]);
  const [venues, setVenues] = useState<SimpleOption[]>([]);

  useEffect(() => {
    void (async () => {
      const { data, error } = await supabase
        .from('draft_events')
        .select('id, workspace_id, name, event_type, status, scheduled_for, cube_id, venue_id, notes')
        .eq('id', eventId)
        .maybeSingle();

      if (error || !data) {
        setLoading(false);
        Alert.alert('Error', 'No se pudo cargar el evento.');
        navigation.goBack();
        return;
      }

      const row = data as any;
      setWorkspaceId(row.workspace_id);
      setName(row.name);
      setEventType(row.event_type as EventType);
      setStatus(row.status as EventStatus);
      setScheduledFor(new Date(row.scheduled_for));
      setCubeId(row.cube_id);
      setVenueId(row.venue_id);
      setNotes(row.notes ?? '');

      const [cubesRes, venuesRes] = await Promise.all([
        supabase.from('cubes').select('id, name').eq('workspace_id', row.workspace_id).order('name'),
        supabase.from('venues').select('id, name').eq('workspace_id', row.workspace_id).order('name'),
      ]);
      setCubes((cubesRes.data ?? []) as SimpleOption[]);
      setVenues((venuesRes.data ?? []) as SimpleOption[]);
      setLoading(false);
    })();
  }, [eventId, navigation]);

  const cubeLabel = useMemo(() => cubes.find((c) => c.id === cubeId)?.name ?? 'Sin definir', [cubeId, cubes]);
  const venueLabel = useMemo(() => venues.find((v) => v.id === venueId)?.name ?? 'Sin definir', [venueId, venues]);
  const typeLabel = EVENT_TYPES.find((t) => t.value === eventType)?.label ?? eventType;

  const openDatePicker = () => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: scheduledFor,
        mode: 'date',
        onChange: (_e, d) => {
          if (!d) return;
          const base = new Date(scheduledFor);
          base.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
          setScheduledFor(base);
          DateTimePickerAndroid.open({
            value: base,
            mode: 'time',
            is24Hour: true,
            onChange: (__e, t) => {
              if (!t) return;
              const dt = new Date(base);
              dt.setHours(t.getHours(), t.getMinutes(), 0, 0);
              setScheduledFor(dt);
            },
          });
        },
      });
    } else {
      setShowIosPicker(true);
    }
  };

  const onSave = async () => {
    const n = name.trim();
    if (n.length < 1 || n.length > 80) return Alert.alert('Revisá los datos', 'El nombre debe tener entre 1 y 80 caracteres.');
    if (notes.length > 2000) return Alert.alert('Revisá los datos', 'Las notas no pueden superar 2000 caracteres.');
    setSubmitting(true);
    const { error } = await supabase
      .from('draft_events')
      .update({
        name: n,
        event_type: eventType,
        status,
        scheduled_for: scheduledFor.toISOString(),
        cube_id: cubeId,
        venue_id: venueId,
        notes: notes.trim() || null,
      })
      .eq('id', eventId);
    setSubmitting(false);
    if (error) return Alert.alert('Error', error.message ?? 'No se pudo guardar el evento.');
    navigation.goBack();
  };

  const onDelete = () => {
    Alert.alert('Borrar evento', '¿Seguro que querés borrar este evento?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Borrar',
        style: 'destructive',
        onPress: async () => {
          setSubmitting(true);
          const { error } = await supabase
            .from('draft_events')
            .update({ deleted_at: new Date().toISOString() })
            .eq('id', eventId);
          setSubmitting(false);
          if (error) return Alert.alert('Error', error.message ?? 'No se pudo borrar el evento.');
          if (workspaceId) navigation.replace('EventsList', { workspaceId });
          else navigation.goBack();
        },
      },
    ]);
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
      <Text style={styles.label}>Nombre</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} maxLength={80} />

      <Text style={styles.label}>Tipo de evento</Text>
      <TouchableOpacity
        style={styles.pickerBtn}
        onPress={() =>
          pick(
            'Tipo de evento',
            EVENT_TYPES.map((t) => ({ label: t.label, onPress: () => setEventType(t.value) }))
          )
        }
      >
        <Text style={styles.pickerTxt}>{typeLabel}</Text>
      </TouchableOpacity>

      <Text style={styles.label}>Estado</Text>
      <TouchableOpacity
        style={styles.pickerBtn}
        onPress={() =>
          pick(
            'Estado',
            STATUS_OPTIONS.map((s) => ({ label: getEventStatusLabel(s), onPress: () => setStatus(s) }))
          )
        }
      >
        <Text style={styles.pickerTxt}>{getEventStatusLabel(status)}</Text>
      </TouchableOpacity>

      <Text style={styles.label}>Fecha y hora</Text>
      <TouchableOpacity style={styles.pickerBtn} onPress={openDatePicker}>
        <Text style={styles.pickerTxt}>
          {scheduledFor.toLocaleString('es-AR', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </Text>
      </TouchableOpacity>

      {Platform.OS === 'ios' && showIosPicker ? (
        <View style={styles.iosPickerWrap}>
          <DateTimePicker
            value={scheduledFor}
            mode="datetime"
            onChange={(_, d) => {
              if (d) setScheduledFor(d);
            }}
          />
          <TouchableOpacity style={styles.iosDone} onPress={() => setShowIosPicker(false)}>
            <Text style={styles.iosDoneTxt}>Listo</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <Text style={styles.label}>Cubo</Text>
      <TouchableOpacity
        style={styles.pickerBtn}
        onPress={() =>
          pick('Seleccionar cubo', [
            { label: 'Sin definir', onPress: () => setCubeId(null) },
            ...cubes.map((c) => ({ label: c.name, onPress: () => setCubeId(c.id) })),
          ])
        }
      >
        <Text style={styles.pickerTxt}>{cubeLabel}</Text>
      </TouchableOpacity>

      <Text style={styles.label}>Sede</Text>
      <TouchableOpacity
        style={styles.pickerBtn}
        onPress={() =>
          pick('Seleccionar sede', [
            { label: 'Sin definir', onPress: () => setVenueId(null) },
            ...venues.map((v) => ({ label: v.name, onPress: () => setVenueId(v.id) })),
          ])
        }
      >
        <Text style={styles.pickerTxt}>{venueLabel}</Text>
      </TouchableOpacity>

      <Text style={styles.label}>Notas (opcional)</Text>
      <TextInput style={[styles.input, styles.notes]} value={notes} onChangeText={setNotes} multiline maxLength={2000} />
      <Text style={styles.counter}>{notes.length}/2000</Text>

      <TouchableOpacity style={[styles.primaryBtn, submitting && styles.primaryBtnDisabled]} onPress={() => void onSave()} disabled={submitting}>
        {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnTxt}>Guardar</Text>}
      </TouchableOpacity>

      <TouchableOpacity style={styles.deleteBtn} onPress={onDelete} disabled={submitting}>
        <Text style={styles.deleteTxt}>Borrar evento</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  scroll: { padding: 24, paddingBottom: 40 },
  label: { fontSize: 15, fontWeight: '600', color: '#111', marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    backgroundColor: '#fafafa',
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    marginBottom: 16,
  },
  pickerBtn: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    backgroundColor: '#fafafa',
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  pickerTxt: { fontSize: 16, color: '#111' },
  notes: { minHeight: 110, textAlignVertical: 'top', marginBottom: 6 },
  counter: { textAlign: 'right', color: '#999', fontSize: 12, marginBottom: 20 },
  iosPickerWrap: { marginBottom: 12 },
  iosDone: { alignSelf: 'flex-end', paddingVertical: 8, paddingHorizontal: 12 },
  iosDoneTxt: { color: '#3B82F6', fontWeight: '600', fontSize: 16 },
  primaryBtn: { backgroundColor: '#3B82F6', borderRadius: 8, alignItems: 'center', paddingVertical: 14 },
  primaryBtnDisabled: { backgroundColor: '#9CA3AF' },
  primaryBtnTxt: { color: '#fff', fontSize: 16, fontWeight: '600' },
  deleteBtn: {
    marginTop: 20,
    borderWidth: 1,
    borderColor: '#FECACA',
    backgroundColor: '#FEE2E2',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  deleteTxt: { color: '#DC2626', fontWeight: '600', fontSize: 15 },
});

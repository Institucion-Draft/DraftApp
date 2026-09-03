import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
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
  Switch,
} from 'react-native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import type { EventType } from '../lib/database.types';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import { getEventTypeLabel } from '../lib/labels';

type Props = NativeStackScreenProps<MainStackParamList, 'CreateEvent'>;
type SimpleOption = { id: string; name: string };

type CompetitionFormat = 'round_robin' | 'swiss' | 'swiss_bo2';

const COMPETITION_FORMAT_OPTIONS: { value: CompetitionFormat; label: string }[] = [
  { value: 'round_robin', label: 'Todos contra todos' },
  { value: 'swiss', label: 'Suizo' },
  { value: 'swiss_bo2', label: 'Suizo BO2' },
];

const SWISS_BO2_ROUNDS_OPTIONS = [3, 4, 5] as const;
const STARTING_LIFE_OPTIONS = [20, 25, 30] as const;

const EVENT_TYPE_OPTIONS: { value: EventType; label: string }[] = [
  { value: 'draft', label: getEventTypeLabel('draft') },
  { value: 'tournament', label: getEventTypeLabel('tournament') },
  { value: 'pepidraft', label: getEventTypeLabel('pepidraft') },
  { value: 'two_headed_giant', label: getEventTypeLabel('two_headed_giant') },
];

function pickFromOptions(
  title: string,
  options: { id: string; label: string; onPress: () => void }[]
) {
  Alert.alert(title, undefined, [
    ...options.map((o) => ({ text: o.label, onPress: o.onPress })),
    { text: 'Cancelar', style: 'cancel' },
  ]);
}

export default function CreateEventScreen({ route, navigation }: Props) {
  const { workspaceId } = route.params;
  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'EventsList', { workspaceId }),
    });
  }, [navigation, workspaceId]);
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [eventType, setEventType] = useState<EventType>('draft');
  const [competitionFormat, setCompetitionFormat] = useState<CompetitionFormat>('round_robin');
  /** Solo round_robin: ON = top_size 4 (antes competition_format='round_robin_bo1_top4'). */
  const [top4, setTop4] = useState(false);
  /** Suizo o round_robin+top4: ON = topcut_format bo3, OFF = bo1. */
  const [eliminatoriasBo3, setEliminatoriasBo3] = useState(true);
  /** Solo swiss_bo2: cantidad de rondas suizas (3, 4 o 5). */
  const [swissRoundsManual, setSwissRoundsManual] = useState<number>(3);
  const [startingLife, setStartingLife] = useState<number>(20);
  const [turnTrackingEnabled, setTurnTrackingEnabled] = useState(true);
  const [isOfficial, setIsOfficial] = useState(true);
  const [isTimedDraft, setIsTimedDraft] = useState(false);
  const [scheduledFor, setScheduledFor] = useState(new Date(Date.now() + 60 * 60 * 1000));
  const [showIosPicker, setShowIosPicker] = useState(false);
  const [cubeId, setCubeId] = useState<string | null>(null);
  const [venueId, setVenueId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [cubes, setCubes] = useState<SimpleOption[]>([]);
  const [venues, setVenues] = useState<SimpleOption[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [loadingOptions, setLoadingOptions] = useState(true);

  // two_headed_giant fuerza round_robin y vida inicial 30.
  useEffect(() => {
    if (eventType === 'two_headed_giant') {
      setCompetitionFormat('round_robin');
      setTop4(false);
      setStartingLife(30);
    } else {
      setStartingLife(20);
    }
  }, [eventType]);

  useEffect(() => {
    void (async () => {
      const [countRes, cubesRes, venuesRes] = await Promise.all([
        supabase
          .from('draft_events')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId),
        supabase.from('cubes').select('id, name').eq('workspace_id', workspaceId).order('name', { ascending: true }),
        supabase.from('venues').select('id, name').eq('workspace_id', workspaceId).order('name', { ascending: true }),
      ]);
      setLoadingOptions(false);

      if (!countRes.error) {
        setName(`Draft ${(countRes.count ?? 0) + 1}`);
      } else {
        setName('Draft');
      }

      if (cubesRes.error || venuesRes.error) {
        Alert.alert('Error', 'No se pudieron cargar cubos/sedes.');
      }
      setCubes(((cubesRes.data ?? []) as SimpleOption[]).map((c) => ({ id: c.id, name: c.name })));
      setVenues(((venuesRes.data ?? []) as SimpleOption[]).map((v) => ({ id: v.id, name: v.name })));
    })();
  }, [workspaceId]);

  const cubeLabel = useMemo(() => cubes.find((c) => c.id === cubeId)?.name ?? 'Sin definir', [cubeId, cubes]);
  const venueLabel = useMemo(() => venues.find((v) => v.id === venueId)?.name ?? 'Sin definir', [venueId, venues]);
  const typeLabel = EVENT_TYPE_OPTIONS.find((t) => t.value === eventType)?.label ?? eventType;
  const competitionFormatLabel =
    COMPETITION_FORMAT_OPTIONS.find((f) => f.value === competitionFormat)?.label ?? competitionFormat;

  const validate = (): string | null => {
    const n = name.trim();
    if (n.length < 1 || n.length > 80) return 'El nombre debe tener entre 1 y 80 caracteres.';
    if (notes.length > 2000) return 'Las notas no pueden superar 2000 caracteres.';
    return null;
  };

  const onCreate = async () => {
    const err = validate();
    if (err) return Alert.alert('Revisá los datos', err);
    if (!user?.id) return Alert.alert('Error', 'No hay sesión activa.');

    setSubmitting(true);
    const insertRow: Record<string, unknown> = {
      workspace_id: workspaceId,
      name: name.trim(),
      event_type: eventType,
      competition_format: competitionFormat,
      scheduled_for: scheduledFor.toISOString(),
      cube_id: cubeId,
      venue_id: venueId,
      notes: notes.trim() || null,
      created_by: user.id,
      status: 'scheduled',
      turn_tracking_enabled: turnTrackingEnabled,
      is_official: isOfficial,
    };
    if (competitionFormat === 'swiss') {
      insertRow.topcut_format = eliminatoriasBo3 ? 'bo3' : 'bo1';
    }
    if (competitionFormat === 'swiss_bo2') {
      insertRow.topcut_format = eliminatoriasBo3 ? 'bo3' : 'bo1';
      insertRow.swiss_rounds_manual = swissRoundsManual;
    }
    if (competitionFormat === 'round_robin' && top4) {
      // Antes competition_format='round_robin_bo1_top4'; ahora round_robin + top_size=4 (0076).
      insertRow.top_size = 4;
      insertRow.topcut_format = eliminatoriasBo3 ? 'bo3' : 'bo1';
      // El oficial es a una sola partida: el trigger update_pairing_official_result
      // resuelve el pairing con el primer match 'draft' completado.
      insertRow.match_format = 'bo1';
    }
    if (eventType === 'two_headed_giant') {
      insertRow.giant_randomization_done = false;
    }
    insertRow.starting_life = startingLife;
    if (isTimedDraft) {
      insertRow.is_timed_draft = true;
    }
    const { data, error } = await supabase.from('draft_events').insert(insertRow)
      .select('id')
      .maybeSingle();
    setSubmitting(false);

    if (error || !data) {
      Alert.alert('Error', error?.message ?? 'No se pudo crear el evento.');
      return;
    }
    navigation.replace('EventDetail', { eventId: data.id as string });
  };

  const openEventTypePicker = () =>
    pickFromOptions(
      'Tipo de evento',
      EVENT_TYPE_OPTIONS.map((opt) => ({
        id: opt.value,
        label: opt.label,
        onPress: () => setEventType(opt.value),
      }))
    );

  const openCompetitionFormatPicker = () =>
    pickFromOptions(
      'Formato de competición',
      COMPETITION_FORMAT_OPTIONS.map((opt) => ({
        id: opt.value,
        label: opt.label,
        onPress: () => setCompetitionFormat(opt.value),
      }))
    );

  const openCubePicker = () =>
    pickFromOptions('Seleccionar cubo', [
      { id: 'none', label: 'Sin definir', onPress: () => setCubeId(null) },
      ...cubes.map((c) => ({ id: c.id, label: c.name, onPress: () => setCubeId(c.id) })),
    ]);

  const openVenuePicker = () =>
    pickFromOptions('Seleccionar sede', [
      { id: 'none', label: 'Sin definir', onPress: () => setVenueId(null) },
      ...venues.map((v) => ({ id: v.id, label: v.name, onPress: () => setVenueId(v.id) })),
    ]);

  const openDatePicker = () => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: scheduledFor,
        mode: 'date',
        onChange: (_, date) => {
          if (!date) return;
          const withDate = new Date(scheduledFor);
          withDate.setFullYear(date.getFullYear(), date.getMonth(), date.getDate());
          setScheduledFor(withDate);
          DateTimePickerAndroid.open({
            value: withDate,
            mode: 'time',
            is24Hour: true,
            onChange: (__2, time) => {
              if (!time) return;
              const done = new Date(withDate);
              done.setHours(time.getHours(), time.getMinutes(), 0, 0);
              setScheduledFor(done);
            },
          });
        },
      });
    } else {
      setShowIosPicker(true);
    }
  };

  if (loadingOptions) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      <View style={styles.sandboxRow}>
        <Text style={styles.sandboxLabel}>Modo sandbox</Text>
        <Switch value={!isOfficial} onValueChange={(v) => setIsOfficial(!v)} />
      </View>

      <Text style={styles.label}>Nombre</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} maxLength={80} />

      <Text style={styles.label}>Tipo de evento</Text>
      <TouchableOpacity style={styles.pickerBtn} onPress={openEventTypePicker}>
        <Text style={styles.pickerTxt}>{typeLabel}</Text>
      </TouchableOpacity>

      <Text style={styles.label}>Formato de competición</Text>
      {eventType === 'two_headed_giant' ? (
        <View style={[styles.pickerBtn, { opacity: 0.5 }]}>
          <Text style={styles.pickerTxt}>Todos contra todos (forzado)</Text>
        </View>
      ) : (
        <TouchableOpacity style={styles.pickerBtn} onPress={openCompetitionFormatPicker}>
          <Text style={styles.pickerTxt}>{competitionFormatLabel}</Text>
        </TouchableOpacity>
      )}

      {competitionFormat === 'round_robin' ? (
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Top 4</Text>
          <Switch value={top4} onValueChange={setTop4} />
        </View>
      ) : null}

      {competitionFormat === 'swiss' || (competitionFormat === 'round_robin' && top4) ? (
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Eliminatorias BO3</Text>
          <Switch value={eliminatoriasBo3} onValueChange={setEliminatoriasBo3} />
        </View>
      ) : null}

      {competitionFormat === 'swiss_bo2' ? (
        <>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Eliminatorias BO3</Text>
            <Switch value={eliminatoriasBo3} onValueChange={setEliminatoriasBo3} />
          </View>

          <Text style={styles.label}>Rondas suizas</Text>
          <View style={styles.segmented}>
            {SWISS_BO2_ROUNDS_OPTIONS.map((n) => {
              const selected = swissRoundsManual === n;
              return (
                <TouchableOpacity
                  key={n}
                  style={[styles.segment, selected && styles.segmentSelected]}
                  onPress={() => setSwissRoundsManual(n)}
                >
                  <Text style={[styles.segmentTxt, selected && styles.segmentTxtSelected]}>{n}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </>
      ) : null}

      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Sistema de turnos con animaciones</Text>
        <Switch value={turnTrackingEnabled} onValueChange={setTurnTrackingEnabled} />
      </View>

      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Draft cronometrado</Text>
        <Switch value={isTimedDraft} onValueChange={setIsTimedDraft} />
      </View>

      <Text style={styles.label}>Vida inicial</Text>
      <View style={styles.segmented}>
        {STARTING_LIFE_OPTIONS.map((n) => {
          const selected = startingLife === n;
          return (
            <TouchableOpacity
              key={n}
              style={[styles.segment, selected && styles.segmentSelected]}
              onPress={() => setStartingLife(n)}
            >
              <Text style={[styles.segmentTxt, selected && styles.segmentTxtSelected]}>{n}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

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
          <TouchableOpacity onPress={() => setShowIosPicker(false)} style={styles.iosDone}>
            <Text style={styles.iosDoneTxt}>Listo</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <Text style={styles.label}>Cubo</Text>
      <TouchableOpacity style={styles.pickerBtn} onPress={openCubePicker}>
        <Text style={styles.pickerTxt}>{cubeLabel}</Text>
      </TouchableOpacity>

      <Text style={styles.label}>Sede</Text>
      <TouchableOpacity style={styles.pickerBtn} onPress={openVenuePicker}>
        <Text style={styles.pickerTxt}>{venueLabel}</Text>
      </TouchableOpacity>

      <Text style={styles.label}>Notas (opcional)</Text>
      <TextInput style={[styles.input, styles.notes]} value={notes} onChangeText={setNotes} multiline maxLength={2000} />
      <Text style={styles.counter}>{notes.length}/2000</Text>

      <TouchableOpacity style={[styles.primaryBtn, submitting && styles.primaryBtnDisabled]} onPress={() => void onCreate()} disabled={submitting}>
        {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnTxt}>Crear</Text>}
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  scroll: { padding: 24, paddingBottom: 38 },
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
  sandboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 10,
    marginBottom: 20,
  },
  sandboxLabel: { fontSize: 14, color: '#6B7280', fontWeight: '500' },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 16,
    paddingVertical: 4,
  },
  switchLabel: { flex: 1, fontSize: 15, color: '#111', fontWeight: '500', marginRight: 12 },
  segmented: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: 16,
  },
  segment: { flex: 1, paddingVertical: 12, alignItems: 'center', backgroundColor: '#fafafa' },
  segmentSelected: { backgroundColor: '#3B82F6' },
  segmentTxt: { fontSize: 16, color: '#111', fontWeight: '600' },
  segmentTxtSelected: { color: '#fff' },
});

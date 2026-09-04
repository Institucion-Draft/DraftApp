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
import { supabase } from '../lib/supabase';
import type { EventStatus, EventType } from '../lib/database.types';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import { getEventStatusLabel, getEventTypeLabel } from '../lib/labels';

type Props = NativeStackScreenProps<MainStackParamList, 'EditEvent'>;
type SimpleOption = { id: string; name: string };

type CompetitionFormat = 'round_robin' | 'swiss' | 'swiss_bo2';

const SWISS_BO2_ROUNDS_OPTIONS = [3, 4, 5] as const;
const STARTING_LIFE_OPTIONS = [20, 25, 30] as const;

function getCompetitionFormatLabel(f: CompetitionFormat, topSize: number | null): string {
  if (f === 'swiss') return 'Suizo';
  if (f === 'swiss_bo2') return 'Suizo BO2';
  // round_robin + top_size=4: antes competition_format='round_robin_bo1_top4' (0076).
  if (f === 'round_robin' && topSize === 4) return 'Todos vs todos + Top 4';
  return 'Todos contra todos';
}

function getMatchFormatLabel(mf: string | null): string {
  if (mf === 'bo1') return 'BO1';
  if (mf === 'bo2') return 'BO2';
  if (mf === 'bo3') return 'BO3';
  return 'Sin definir';
}

type FormBaseline = {
  name: string;
  eventType: EventType;
  status: EventStatus;
  scheduledForMs: number;
  cubeId: string | null;
  venueId: string | null;
  notes: string;
  forceEditOverride: boolean;
  turnTrackingEnabled: boolean;
  eliminatoriasBo3: boolean;
  swissRoundsManual: number;
  startingLife: number;
};

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
  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'EventDetail', { eventId }),
    });
  }, [navigation, eventId]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [competitionFormat, setCompetitionFormat] = useState<CompetitionFormat>('round_robin');
  /** Solo round_robin; read-only, igual que competitionFormat. */
  const [topSize, setTopSize] = useState<number | null>(null);
  /** Solo round_robin (con o sin top4); read-only, igual que topSize. */
  const [matchFormat, setMatchFormat] = useState<string | null>(null);
  const [eventType, setEventType] = useState<EventType>('draft');
  const [status, setStatus] = useState<EventStatus>('scheduled');
  const [scheduledFor, setScheduledFor] = useState(new Date());
  const [showIosPicker, setShowIosPicker] = useState(false);
  const [cubeId, setCubeId] = useState<string | null>(null);
  const [venueId, setVenueId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [turnTrackingEnabled, setTurnTrackingEnabled] = useState(false);
  const [isOfficial, setIsOfficial] = useState(true);
  /** Suizo: ON = topcut_format bo3, OFF = bo1. */
  const [eliminatoriasBo3, setEliminatoriasBo3] = useState(true);
  /** Solo swiss_bo2: cantidad de rondas suizas (3, 4 o 5). */
  const [swissRoundsManual, setSwissRoundsManual] = useState<number>(3);
  const [topcutFormatLocked, setTopcutFormatLocked] = useState(false);
  /** swiss_bo2: selector de rondas bloqueado cuando ya hay al menos 1 partida en el evento. */
  const [swissRoundsLocked, setSwissRoundsLocked] = useState(false);
  const [startingLife, setStartingLife] = useState<number>(20);
  const [cubes, setCubes] = useState<SimpleOption[]>([]);
  const [venues, setVenues] = useState<SimpleOption[]>([]);
  /** Solo aplica si status es playing/completed: permite editar cubo, sede, tipo, fecha (no estado). */
  const [forceEditOverride, setForceEditOverride] = useState(false);
  /** Estado del servidor al cargar la pantalla; no se actualiza al cambiar el picker. */
  const [loadedStatus, setLoadedStatus] = useState<EventStatus | null>(null);
  const [baseline, setBaseline] = useState<FormBaseline | null>(null);

  const isAdvancedStatus = status === 'playing' || status === 'completed';
  const restricted = isAdvancedStatus && !forceEditOverride;
  const statusPickerLocked = loadedStatus === 'playing' || loadedStatus === 'completed';

  useEffect(() => {
    void (async () => {
      const { data, error } = await supabase
        .from('draft_events')
        .select(
          'id, workspace_id, name, event_type, status, scheduled_for, cube_id, venue_id, notes, turn_tracking_enabled, is_official, competition_format, top_size, match_format, topcut_format, swiss_rounds_manual, starting_life'
        )
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
      const rawCf = (row.competition_format as string | null | undefined) ?? 'round_robin';
      const cf: CompetitionFormat = rawCf === 'swiss' ? 'swiss' : rawCf === 'swiss_bo2' ? 'swiss_bo2' : 'round_robin';
      setCompetitionFormat(cf);
      const ts = typeof row.top_size === 'number' ? row.top_size : null;
      setTopSize(ts);
      setMatchFormat((row.match_format as string | null | undefined) ?? null);
      const isTop4 = cf === 'round_robin' && ts === 4;
      const roundsManual =
        typeof row.swiss_rounds_manual === 'number' && row.swiss_rounds_manual >= 3 && row.swiss_rounds_manual <= 5
          ? row.swiss_rounds_manual
          : 3;
      setSwissRoundsManual(roundsManual);
      setEventType(row.event_type as EventType);
      const st = row.status as EventStatus;
      setLoadedStatus(st);
      setStatus(st);
      setScheduledFor(new Date(row.scheduled_for));
      setCubeId(row.cube_id);
      setVenueId(row.venue_id);
      setNotes(row.notes ?? '');
      setForceEditOverride(false);
      const tt = !!row.turn_tracking_enabled;
      setTurnTrackingEnabled(tt);
      const io = row.is_official !== false;
      setIsOfficial(io);
      const rawTf = (row.topcut_format as string | null | undefined) ?? 'bo3';
      const elimBo3 = rawTf !== 'bo1';
      setEliminatoriasBo3(elimBo3);
      const sl = typeof row.starting_life === 'number' && [20, 25, 30].includes(row.starting_life) ? row.starting_life : 20;
      setStartingLife(sl);

      let swissTopcutBracketLocked = false;
      if (cf === 'swiss' || cf === 'swiss_bo2' || isTop4) {
        const bracketOrigin = isTop4 ? 'round_robin_topcut' : 'swiss_topcut';
        const grpRes = await supabase
          .from('event_tiebreak_groups')
          .select('id')
          .eq('event_id', eventId)
          .eq('group_origin', bracketOrigin);
        const groupIds = (grpRes.data ?? []).map((r: { id: string }) => r.id);
        if (groupIds.length > 0) {
          const bmRes = await supabase
            .from('event_tiebreak_bracket_matches')
            .select('pairing_id')
            .in('group_id', groupIds);
          const pairingIds = [
            ...new Set(
              (bmRes.data ?? [])
                .map((r: { pairing_id: string | null }) => r.pairing_id)
                .filter((pid): pid is string => pid != null && String(pid).length > 0)
            ),
          ];
          if (pairingIds.length > 0) {
            const mRes = await supabase
              .from('matches')
              .select('id', { count: 'exact', head: true })
              .in('pairing_id', pairingIds)
              .eq('match_type', 'tiebreak');
            swissTopcutBracketLocked = (mRes.count ?? 0) > 0;
          }
        }
      }
      setTopcutFormatLocked(swissTopcutBracketLocked);

      // swiss_bo2: bloquear el selector de rondas en cuanto haya cualquier partida en el evento.
      let roundsLocked = false;
      if (cf === 'swiss_bo2') {
        const allPairingsRes = await supabase
          .from('pairings')
          .select('id')
          .eq('event_id', eventId)
          .limit(1);
        const pairingIdsForLock = (allPairingsRes.data ?? []).map((r: { id: string }) => r.id);
        if (pairingIdsForLock.length > 0) {
          const matchLockRes = await supabase
            .from('matches')
            .select('id', { count: 'exact', head: true })
            .in('pairing_id', pairingIdsForLock)
            .in('status', ['in_progress', 'completed']);
          roundsLocked = (matchLockRes.count ?? 0) > 0;
        }
      }
      setSwissRoundsLocked(roundsLocked);

      setBaseline({
        name: row.name,
        eventType: row.event_type as EventType,
        status: st,
        scheduledForMs: new Date(row.scheduled_for).getTime(),
        cubeId: row.cube_id,
        venueId: row.venue_id,
        notes: row.notes ?? '',
        forceEditOverride: false,
        turnTrackingEnabled: tt,
        eliminatoriasBo3: elimBo3,
        swissRoundsManual: roundsManual,
        startingLife: sl,
      });

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

  const hasDirtyFields = useMemo(() => {
    if (!baseline) return false;
    return (
      name.trim() !== baseline.name.trim() ||
      eventType !== baseline.eventType ||
      status !== baseline.status ||
      scheduledFor.getTime() !== baseline.scheduledForMs ||
      cubeId !== baseline.cubeId ||
      venueId !== baseline.venueId ||
      (notes.trim() || '') !== (baseline.notes.trim() || '') ||
      forceEditOverride !== baseline.forceEditOverride ||
      turnTrackingEnabled !== baseline.turnTrackingEnabled ||
      eliminatoriasBo3 !== baseline.eliminatoriasBo3 ||
      swissRoundsManual !== baseline.swissRoundsManual ||
      startingLife !== baseline.startingLife
    );
  }, [
    baseline,
    name,
    eventType,
    status,
    scheduledFor,
    cubeId,
    venueId,
    notes,
    forceEditOverride,
    turnTrackingEnabled,
    eliminatoriasBo3,
    swissRoundsManual,
    startingLife,
  ]);

  const openStatusPicker = () => {
    if (statusPickerLocked || !loadedStatus) return;
    if (loadedStatus === 'drafting') {
      pick('Estado', [
        { label: getEventStatusLabel('scheduled'), onPress: () => setStatus('scheduled') },
        { label: getEventStatusLabel('cancelled'), onPress: () => setStatus('cancelled') },
      ]);
      return;
    }
    pick(
      'Estado',
      STATUS_OPTIONS.map((s) => ({ label: getEventStatusLabel(s), onPress: () => setStatus(s) }))
    );
  };

  const openDatePicker = () => {
    if (restricted) return;
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
    if (!hasDirtyFields) return;
    const n = name.trim();
    if (n.length < 1 || n.length > 80) return Alert.alert('Revisá los datos', 'El nombre debe tener entre 1 y 80 caracteres.');
    if (notes.length > 2000) return Alert.alert('Revisá los datos', 'Las notas no pueden superar 2000 caracteres.');
    setSubmitting(true);
    const patch: Record<string, unknown> = {
      name: n,
      notes: notes.trim() || null,
      turn_tracking_enabled: turnTrackingEnabled,
    };
    if (!restricted) {
      patch.event_type = eventType;
      patch.scheduled_for = scheduledFor.toISOString();
      patch.cube_id = cubeId;
      patch.venue_id = venueId;
    }
    if (
      (competitionFormat === 'swiss' ||
        competitionFormat === 'swiss_bo2' ||
        (competitionFormat === 'round_robin' && topSize === 4)) &&
      !topcutFormatLocked
    ) {
      patch.topcut_format = eliminatoriasBo3 ? 'bo3' : 'bo1';
    }
    if (competitionFormat === 'swiss_bo2' && !topcutFormatLocked && !swissRoundsLocked) {
      patch.swiss_rounds_manual = swissRoundsManual;
    }
    if (!statusPickerLocked && loadedStatus) {
      if (loadedStatus === 'drafting') {
        if (status === 'scheduled' || status === 'cancelled') {
          patch.status = status;
          if (status === 'scheduled') {
            patch.draft_started_at = null;
          }
        }
      } else {
        patch.status = status;
      }
    }
    patch.starting_life = startingLife;
    const { error } = await supabase.from('draft_events').update(patch).eq('id', eventId);
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
          // reset() en vez de replace(): replace() solo reemplaza esta pantalla, dejando la
          // instancia de EventDetailScreen (con el evento ya borrado) enterrada más abajo en el
          // stack — al volver atrás desde ahí en algún momento posterior, el usuario cae en esa
          // pantalla zombie. reset() limpia todo el stack hasta EventsList, sin nada debajo.
          if (workspaceId) {
            navigation.reset({ index: 0, routes: [{ name: 'EventsList', params: { workspaceId } }] });
          } else {
            navigation.goBack();
          }
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
      {!isOfficial ? (
        <View style={styles.sandboxRow}>
          <Text style={styles.sandboxLabel}>Evento sandbox (no editable)</Text>
        </View>
      ) : null}

      <Text style={styles.label}>Nombre</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} maxLength={80} />

      <Text style={styles.label}>Formato de competición</Text>
      <View style={[styles.pickerBtn, styles.pickerBtnDisabled]}>
        <Text style={[styles.pickerTxt, styles.pickerTxtMuted]}>{getCompetitionFormatLabel(competitionFormat, topSize)}</Text>
      </View>
      <Text style={styles.readOnlyHint}>Definido al crear el evento; no se puede cambiar.</Text>

      {competitionFormat === 'round_robin' ? (
        <>
          <Text style={styles.label}>Formato de partidas (fase regular)</Text>
          <View style={[styles.pickerBtn, styles.pickerBtnDisabled]}>
            <Text style={[styles.pickerTxt, styles.pickerTxtMuted]}>{getMatchFormatLabel(matchFormat)}</Text>
          </View>
          <Text style={styles.readOnlyHint}>Definido al crear el evento; no se puede cambiar.</Text>
        </>
      ) : null}

      {competitionFormat === 'swiss' || competitionFormat === 'swiss_bo2' || (competitionFormat === 'round_robin' && topSize === 4) ? (
        <>
          <View style={styles.turnTrackingRow}>
            <Text style={styles.turnTrackingLabel}>Eliminatorias BO3</Text>
            <Switch value={eliminatoriasBo3} onValueChange={setEliminatoriasBo3} disabled={topcutFormatLocked} />
          </View>
          {topcutFormatLocked ? (
            <Text style={styles.topcutLockedHint}>Ya no editable: las eliminatorias comenzaron.</Text>
          ) : null}
        </>
      ) : null}

      {competitionFormat === 'swiss_bo2' ? (
        <>
          <Text style={[styles.label, swissRoundsLocked && styles.labelMuted]}>Rondas suizas</Text>
          <View style={styles.segmented}>
            {SWISS_BO2_ROUNDS_OPTIONS.map((n) => {
              const selected = swissRoundsManual === n;
              return (
                <TouchableOpacity
                  key={n}
                  style={[styles.segment, selected && styles.segmentSelected]}
                  disabled={swissRoundsLocked}
                  onPress={() => setSwissRoundsManual(n)}
                >
                  <Text style={[styles.segmentTxt, selected && styles.segmentTxtSelected]}>{n}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {swissRoundsLocked ? (
            <Text style={styles.topcutLockedHint}>Ya no editable: ya se jugaron partidas.</Text>
          ) : null}
        </>
      ) : null}

      {isAdvancedStatus ? (
        <View style={styles.forceEditBlock}>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>El draft ya empezó. ¿Forzar edición?</Text>
            <Switch value={forceEditOverride} onValueChange={setForceEditOverride} />
          </View>
          {forceEditOverride ? (
            <Text style={styles.forceEditHint}>
              Los datos del evento ya empezado se modificarán. Los enfrentamientos en curso no se ven afectados.
            </Text>
          ) : null}
        </View>
      ) : null}

      <Text style={[styles.label, restricted && styles.labelMuted]}>Tipo de evento</Text>
      <TouchableOpacity
        style={[styles.pickerBtn, restricted && styles.pickerBtnDisabled]}
        disabled={restricted}
        onPress={() =>
          pick(
            'Tipo de evento',
            EVENT_TYPES.map((t) => ({ label: t.label, onPress: () => setEventType(t.value) }))
          )
        }
      >
        <Text style={[styles.pickerTxt, restricted && styles.pickerTxtMuted]}>{typeLabel}</Text>
      </TouchableOpacity>

      <Text style={[styles.label, (restricted || statusPickerLocked) && styles.labelMuted]}>Estado</Text>
      <TouchableOpacity
        style={[styles.pickerBtn, (restricted || statusPickerLocked) && styles.pickerBtnDisabled]}
        disabled={restricted || statusPickerLocked}
        onPress={openStatusPicker}
      >
        <Text style={[styles.pickerTxt, (restricted || statusPickerLocked) && styles.pickerTxtMuted]}>
          {getEventStatusLabel(status)}
        </Text>
      </TouchableOpacity>

      <Text style={[styles.label, restricted && styles.labelMuted]}>Fecha y hora</Text>
      <TouchableOpacity
        style={[styles.pickerBtn, restricted && styles.pickerBtnDisabled]}
        disabled={restricted}
        onPress={openDatePicker}
      >
        <Text style={[styles.pickerTxt, restricted && styles.pickerTxtMuted]}>
          {scheduledFor.toLocaleString('es-AR', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </Text>
      </TouchableOpacity>

      {Platform.OS === 'ios' && showIosPicker && !restricted ? (
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

      <Text style={[styles.label, restricted && styles.labelMuted]}>Cubo</Text>
      <TouchableOpacity
        style={[styles.pickerBtn, restricted && styles.pickerBtnDisabled]}
        disabled={restricted}
        onPress={() =>
          pick('Seleccionar cubo', [
            { label: 'Sin definir', onPress: () => setCubeId(null) },
            ...cubes.map((c) => ({ label: c.name, onPress: () => setCubeId(c.id) })),
          ])
        }
      >
        <Text style={[styles.pickerTxt, restricted && styles.pickerTxtMuted]}>{cubeLabel}</Text>
      </TouchableOpacity>

      <Text style={[styles.label, restricted && styles.labelMuted]}>Sede</Text>
      <TouchableOpacity
        style={[styles.pickerBtn, restricted && styles.pickerBtnDisabled]}
        disabled={restricted}
        onPress={() =>
          pick('Seleccionar sede', [
            { label: 'Sin definir', onPress: () => setVenueId(null) },
            ...venues.map((v) => ({ label: v.name, onPress: () => setVenueId(v.id) })),
          ])
        }
      >
        <Text style={[styles.pickerTxt, restricted && styles.pickerTxtMuted]}>{venueLabel}</Text>
      </TouchableOpacity>

      <Text style={[styles.label, restricted && styles.labelMuted]}>Vida inicial</Text>
      <View style={styles.segmented}>
        {STARTING_LIFE_OPTIONS.map((n) => {
          const selected = startingLife === n;
          return (
            <TouchableOpacity
              key={n}
              style={[styles.segment, selected && styles.segmentSelected]}
              disabled={restricted}
              onPress={() => setStartingLife(n)}
            >
              <Text style={[styles.segmentTxt, selected && styles.segmentTxtSelected]}>{n}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <Text style={styles.label}>Notas (opcional)</Text>
      <TextInput style={[styles.input, styles.notes]} value={notes} onChangeText={setNotes} multiline maxLength={2000} />
      <Text style={styles.counter}>{notes.length}/2000</Text>

      <View style={styles.turnTrackingRow}>
        <Text style={styles.turnTrackingLabel}>Sistema de turnos con animaciones</Text>
        <Switch value={turnTrackingEnabled} onValueChange={setTurnTrackingEnabled} />
      </View>

      {!hasDirtyFields ? <Text style={styles.noChangesHint}>No hay cambios para guardar</Text> : null}
      <TouchableOpacity
        style={[styles.primaryBtn, (submitting || !hasDirtyFields) && styles.primaryBtnDisabled]}
        onPress={() => void onSave()}
        disabled={submitting || !hasDirtyFields}
      >
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
  pickerBtnDisabled: {
    backgroundColor: '#E5E7EB',
    borderColor: '#D1D5DB',
  },
  pickerTxt: { fontSize: 16, color: '#111' },
  pickerTxtMuted: { color: '#6B7280' },
  readOnlyHint: { fontSize: 12, color: '#9CA3AF', marginTop: 4, marginBottom: 16 },
  topcutLockedHint: { fontSize: 12, color: '#9CA3AF', marginBottom: 16 },
  labelMuted: { color: '#6B7280' },
  forceEditBlock: { marginBottom: 8 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
    paddingVertical: 4,
  },
  switchLabel: { flex: 1, fontSize: 15, color: '#374151', fontWeight: '500' },
  sandboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 10,
    marginBottom: 20,
  },
  sandboxLabel: { fontSize: 14, color: '#6B7280', fontWeight: '500' },
  turnTrackingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  turnTrackingLabel: { flex: 1, fontSize: 15, color: '#111', fontWeight: '500', marginRight: 12 },
  forceEditHint: {
    fontSize: 13,
    color: '#6B7280',
    lineHeight: 18,
    marginBottom: 12,
  },
  notes: { minHeight: 110, textAlignVertical: 'top', marginBottom: 6 },
  counter: { textAlign: 'right', color: '#999', fontSize: 12, marginBottom: 20 },
  iosPickerWrap: { marginBottom: 12 },
  iosDone: { alignSelf: 'flex-end', paddingVertical: 8, paddingHorizontal: 12 },
  iosDoneTxt: { color: '#3B82F6', fontWeight: '600', fontSize: 16 },
  primaryBtn: { backgroundColor: '#3B82F6', borderRadius: 8, alignItems: 'center', paddingVertical: 14 },
  primaryBtnDisabled: { backgroundColor: '#9CA3AF' },
  noChangesHint: { fontSize: 13, color: '#9CA3AF', textAlign: 'center', marginBottom: 10 },
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

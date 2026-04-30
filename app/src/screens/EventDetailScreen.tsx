import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  Image,
  Alert,
  RefreshControl,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { avatarPublicUrl } from '../lib/avatarUrl';
import type { MtgColor } from '../lib/database.types';
import { getEventStatusLabel, getEventTypeLabel, getPairingsLabel } from '../lib/labels';

type Props = NativeStackScreenProps<MainStackParamList, 'EventDetail'>;

type EventRow = {
  id: string;
  workspace_id: string;
  name: string;
  avatar_path: string | null;
  status: 'scheduled' | 'drafting' | 'playing' | 'completed' | 'cancelled';
  event_type: 'draft' | 'tournament' | 'pepidraft';
  scheduled_for: string;
  cube_id: string | null;
  venue_id: string | null;
  notes: string | null;
  draft_started_at: string | null;
  draft_ended_at: string | null;
};

type ParticipantView = {
  id: string;
  user_id: string;
  self_evaluation: number | null;
  users:
    | {
        username: string;
        display_name: string;
        custom_avatar_path: string | null;
        default_avatars: { storage_path: string } | { storage_path: string }[] | null;
      }
    | {
        username: string;
        display_name: string;
        custom_avatar_path: string | null;
        default_avatars: { storage_path: string } | { storage_path: string }[] | null;
      }[]
    | null;
};

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

export default function EventDetailScreen({ route, navigation }: Props) {
  const { eventId } = route.params;
  const [event, setEvent] = useState<EventRow | null>(null);
  const [participants, setParticipants] = useState<ParticipantView[]>([]);
  const [participantColors, setParticipantColors] = useState<Record<string, MtgColor[]>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [isWorkspaceMember, setIsWorkspaceMember] = useState(false);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [myParticipantId, setMyParticipantId] = useState<string | null>(null);
  const [cubeName, setCubeName] = useState<string | null>(null);
  const [venueName, setVenueName] = useState<string | null>(null);
  const firstRef = useRef(true);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('draft_events')
      .select(
        'id, workspace_id, name, avatar_path, status, event_type, scheduled_for, cube_id, venue_id, notes, draft_started_at, draft_ended_at'
      )
      .eq('id', eventId)
      .maybeSingle();

    if (error || !data) {
      Alert.alert('Error', 'No se pudo cargar el evento.');
      setEvent(null);
      return;
    }
    const e = data as EventRow;
    setEvent(e);

    const [meRes, roleRes, partsRes, cubeRes, venueRes] = await Promise.all([
      supabase.auth.getUser(),
      supabase.from('workspace_members').select('role').eq('workspace_id', e.workspace_id).maybeSingle(),
      supabase
        .from('event_participants')
        .select(
          `
          id,
          user_id,
          self_evaluation,
          users!event_participants_user_id_fkey (
            username,
            display_name,
            custom_avatar_path,
            default_avatars (storage_path)
          )
        `
        )
        .eq('event_id', e.id)
        .eq('role', 'player'),
      e.cube_id ? supabase.from('cubes').select('name').eq('id', e.cube_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
      e.venue_id ? supabase.from('venues').select('name').eq('id', e.venue_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    ]);

    const currentUserId = meRes.data.user?.id ?? null;
    setMyUserId(currentUserId);
    const role = roleRes.data?.role as 'organizer' | 'member' | undefined;
    setIsOrganizer(role === 'organizer');
    setIsWorkspaceMember(role === 'organizer' || role === 'member');
    if (partsRes.error) {
      if (__DEV__) {
        console.error('Error cargando participantes del evento:', partsRes.error);
      }
      Alert.alert(
        'Error',
        partsRes.error.message ?? 'No se pudieron cargar los participantes.'
      );
      return;
    }

    const p = (partsRes.data ?? []) as ParticipantView[];
    setParticipants(p);
    const mine = p.find((x) => x.user_id === (currentUserId ?? ''));
    setMyParticipantId(mine?.id ?? null);
    setCubeName((cubeRes.data as any)?.name ?? null);
    setVenueName((venueRes.data as any)?.name ?? null);

    if (p.length > 0) {
      const ids = p.map((x) => x.id);
      const cRes = await supabase.from('participant_colors').select('participant_id, color').in('participant_id', ids);
      if (!cRes.error) {
        const map: Record<string, MtgColor[]> = {};
        for (const row of cRes.data ?? []) {
          const pid = row.participant_id as string;
          if (!map[pid]) map[pid] = [];
          map[pid].push(row.color as MtgColor);
        }
        setParticipantColors(map);
      }
    } else {
      setParticipantColors({});
    }
  }, [eventId]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        const first = firstRef.current;
        if (first) {
          setLoading(true);
          firstRef.current = false;
        }
        await load();
        if (!cancelled && first) setLoading(false);
      })();
      return () => {
        cancelled = true;
      };
    }, [load])
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      title: event?.name ?? 'Evento',
    });
  }, [event?.name, navigation]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const patchEvent = async (patch: Partial<EventRow>) => {
    if (!event) return;
    const { error } = await supabase.from('draft_events').update(patch).eq('id', event.id);
    if (error) {
      Alert.alert('Error', error.message ?? 'No se pudo actualizar el evento.');
      return;
    }
    await load();
  };

  const participantCount = participants.length;
  const myColors = myParticipantId ? participantColors[myParticipantId] ?? [] : [];
  const hasDeclaredColors = myColors.length > 0;
  const startDraftDisabled = !event?.cube_id || !event?.venue_id || participantCount < 1;

  const canOpenMatchups =
    event?.status === 'playing' || event?.status === 'completed'
      ? isOrganizer || (isWorkspaceMember && (!myParticipantId || hasDeclaredColors))
      : false;

  const insertMyRegistration = async () => {
    if (!event || !myUserId) return;
    const { error } = await supabase.from('event_participants').insert({
      event_id: event.id,
      user_id: myUserId,
      role: 'player',
    });
    if (error) {
      const msg = error.message?.toLowerCase() ?? '';
      const isDup =
        error.code === '23505' ||
        msg.includes('duplicate') ||
        msg.includes('unique');
      if (isDup) {
        await load();
        return;
      }
      Alert.alert('Error', error.message ?? 'No se pudo completar la inscripción.');
      return;
    }
    await load();
  };

  const cancelMyRegistration = () => {
    if (!myParticipantId) return;
    Alert.alert('Cancelar inscripción', '¿Seguro que querés cancelar tu inscripción al evento?', [
      { text: 'Volver', style: 'cancel' },
      {
        text: 'Cancelar inscripción',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('event_participants').delete().eq('id', myParticipantId);
          if (error) {
            const msg = error.message?.toLowerCase() ?? '';
            const alreadyGone =
              msg.includes('no rows') ||
              msg.includes('not found') ||
              msg.includes('0 rows');
            if (alreadyGone) {
              await load();
              return;
            }
            Alert.alert('Error', error.message ?? 'No se pudo cancelar la inscripción.');
            return;
          }
          await load();
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

  if (!event) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>No se encontró el evento.</Text>
      </View>
    );
  }

  const eventAvatar = avatarPublicUrl(event.avatar_path);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
      <View style={styles.header}>
        {eventAvatar ? (
          <Image source={{ uri: eventAvatar }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarPh]}>
            <Text style={styles.avatarTxt}>{event.name.slice(0, 1).toUpperCase()}</Text>
          </View>
        )}
        <Text style={styles.title}>{event.name}</Text>
        <Text style={styles.meta}>Estado: {getEventStatusLabel(event.status)}</Text>
        <Text style={styles.meta}>Tipo: {getEventTypeLabel(event.event_type)}</Text>
      </View>

      <View style={styles.block}>
        <Text style={styles.meta}>
          Fecha: {new Date(event.scheduled_for).toLocaleString('es-AR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </Text>
        <TouchableOpacity disabled={!event.cube_id} onPress={() => event.cube_id && navigation.navigate('CubeDetail', { cubeId: event.cube_id })}>
          <Text style={[styles.meta, event.cube_id ? styles.link : null]}>Cubo: {cubeName ?? 'Sin definir'}</Text>
        </TouchableOpacity>
        <Text style={styles.meta}>Sede: {venueName ?? 'Sin definir'}</Text>
        <Text style={styles.meta}>Notas: {event.notes?.trim() || 'Sin notas.'}</Text>
      </View>

      {isOrganizer ? (
        <View style={styles.block}>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.navigate('EditEvent', { eventId: event.id })}>
            <Text style={styles.primaryBtnTxt}>Editar evento</Text>
          </TouchableOpacity>
          {event.status === 'scheduled' && !event.draft_started_at ? (
            <TouchableOpacity
              style={[styles.secondaryBtn, startDraftDisabled && styles.disabledBtn]}
              disabled={startDraftDisabled}
              onPress={() =>
                Alert.alert('Iniciar draft', '¿Iniciar el draft? Las inscripciones se cerrarán.', [
                  { text: 'Volver', style: 'cancel' },
                  {
                    text: 'Iniciar',
                    onPress: () => void patchEvent({ draft_started_at: new Date().toISOString(), status: 'drafting' }),
                  },
                ])
              }
            >
              <Text style={styles.secondaryBtnTxt}>Marcar inicio del draft</Text>
            </TouchableOpacity>
          ) : null}
          {event.status === 'scheduled' && startDraftDisabled ? (
            <Text style={styles.disabledHint}>
              Falta seleccionar cubo, sede, o que se inscriba al menos un jugador
            </Text>
          ) : null}
          {event.draft_started_at && !event.draft_ended_at ? (
            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={() =>
                Alert.alert(
                  'Fin del draft',
                  '¿Marcar fin del draft? Los jugadores podrán pasar a enfrentamientos.',
                  [
                    { text: 'Volver', style: 'cancel' },
                    {
                      text: 'Marcar fin',
                      onPress: () => void patchEvent({ draft_ended_at: new Date().toISOString(), status: 'playing' }),
                    },
                  ]
                )
              }
            >
              <Text style={styles.secondaryBtnTxt}>Marcar fin del draft</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            style={styles.dangerBtn}
            onPress={() =>
              Alert.alert('Cancelar evento', '¿Seguro que querés cancelar este evento?', [
                { text: 'Volver', style: 'cancel' },
                { text: 'Cancelar evento', style: 'destructive', onPress: () => void patchEvent({ status: 'cancelled' }) },
              ])
            }
          >
            <Text style={styles.dangerTxt}>Cancelar evento</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={styles.block}>
        <Text style={styles.blockTitle}>Participantes</Text>
        {participants.length === 0 ? <Text style={styles.muted}>Todavía no hay participantes.</Text> : null}
        {participants.map((p) => {
          const u = relationOne(p.users);
          const da = relationOne(u?.default_avatars);
          const uri = u ? avatarPublicUrl(u.custom_avatar_path) ?? avatarPublicUrl(da?.storage_path ?? null) : null;
          const uname = u?.username ?? u?.display_name ?? 'Usuario';
          const colors = participantColors[p.id] ?? [];
          return (
            <View key={p.id} style={styles.participantRow}>
              {uri ? (
                <Image source={{ uri }} style={styles.participantAvatar} />
              ) : (
                <View style={[styles.participantAvatar, styles.avatarPh]}>
                  <Text style={styles.participantTxt}>{uname.slice(0, 1).toUpperCase()}</Text>
                </View>
              )}
              <View style={styles.participantBody}>
                <Text style={styles.participantName}>{uname}</Text>
                <Text style={styles.metaSmall}>
                  Colores: {colors.length ? colors.join(', ') : '—'} · Valoración:{' '}
                  {p.self_evaluation != null ? `${'★'.repeat(p.self_evaluation)} (${p.self_evaluation})` : '—'}
                </Text>
              </View>
            </View>
          );
        })}
      </View>

      <View style={styles.block}>
        {event.status === 'scheduled' ? (
          <>
            {!myParticipantId && isWorkspaceMember ? (
              <TouchableOpacity style={styles.primaryBtn} onPress={() => void insertMyRegistration()}>
                <Text style={styles.primaryBtnTxt}>Inscribirme al evento</Text>
              </TouchableOpacity>
            ) : null}
            {myParticipantId ? (
              <View style={styles.inlineRow}>
                <Text style={styles.registeredTxt}>Estás inscripto</Text>
                <TouchableOpacity onPress={cancelMyRegistration} style={styles.smallDangerBtn}>
                  <Text style={styles.smallDangerTxt}>Cancelar inscripción</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </>
        ) : null}

        {event.status === 'drafting' ? (
          !myParticipantId ? (
            <Text style={styles.muted}>Las inscripciones cerraron al iniciar el draft.</Text>
          ) : (
            <Text style={styles.muted}>Estás inscripto en este evento.</Text>
          )
        ) : null}

        {event.status === 'playing' ? (
          <>
            {myParticipantId && !hasDeclaredColors ? (
              <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.navigate('EventCheckIn', { eventId: event.id })}>
                <Text style={styles.primaryBtnTxt}>Pasar a enfrentamientos</Text>
              </TouchableOpacity>
            ) : null}
            {myParticipantId && hasDeclaredColors ? (
              <TouchableOpacity style={styles.secondaryBtn} onPress={() => navigation.navigate('EventCheckIn', { eventId: event.id })}>
                <Text style={styles.secondaryBtnTxt}>Editar mis colores y valoración</Text>
              </TouchableOpacity>
            ) : null}
          </>
        ) : null}
      </View>

      <View style={styles.block}>
        <Text style={styles.blockTitle}>Próximamente</Text>
        <TouchableOpacity
          style={styles.placeholderBtn}
          onPress={() =>
            canOpenMatchups
              ? Alert.alert('Próximamente', 'Enfrentamientos llegará en Sprint 3B.')
              : Alert.alert('Enfrentamientos', 'Los enfrentamientos se habilitan después del draft.')
          }
        >
          <Text style={styles.placeholderTxt}>{getPairingsLabel()}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.placeholderBtn} onPress={() => Alert.alert('Próximamente', 'Bitácora digital llegará en Sprint 3B.')}>
          <Text style={styles.placeholderTxt}>Bitácora digital</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.placeholderBtn} onPress={() => Alert.alert('Próximamente', 'Ruleta de cubos llegará en Sprint 3B.')}>
          <Text style={styles.placeholderTxt}>Ruleta de cubos</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  muted: { color: '#666', fontSize: 14 },
  scroll: { paddingBottom: 30 },
  header: { alignItems: 'center', padding: 24, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#eee' },
  avatar: { width: 84, height: 84, borderRadius: 16, backgroundColor: '#f3f4f6', marginBottom: 10 },
  avatarPh: { justifyContent: 'center', alignItems: 'center', backgroundColor: '#E0E7FF' },
  avatarTxt: { fontSize: 34, fontWeight: '700', color: '#4338CA' },
  title: { fontSize: 22, fontWeight: '700', color: '#111', marginBottom: 6, textAlign: 'center' },
  meta: { color: '#666', fontSize: 14, marginBottom: 4 },
  link: { color: '#3B82F6' },
  block: { paddingHorizontal: 24, paddingTop: 18 },
  blockTitle: { fontSize: 16, fontWeight: '700', color: '#111', marginBottom: 10 },
  primaryBtn: { backgroundColor: '#3B82F6', borderRadius: 8, paddingVertical: 12, alignItems: 'center', marginBottom: 10 },
  primaryBtnTxt: { color: '#fff', fontSize: 15, fontWeight: '600' },
  secondaryBtn: {
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  secondaryBtnTxt: { color: '#3B82F6', fontSize: 15, fontWeight: '600' },
  disabledBtn: { opacity: 0.5 },
  disabledHint: { color: '#666', fontSize: 12, marginTop: -4, marginBottom: 10 },
  dangerBtn: {
    backgroundColor: '#FEE2E2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 4,
  },
  dangerTxt: { color: '#DC2626', fontSize: 15, fontWeight: '600' },
  participantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    backgroundColor: '#fafafa',
  },
  participantAvatar: { width: 40, height: 40, borderRadius: 10, backgroundColor: '#f3f4f6', marginRight: 10 },
  participantTxt: { fontSize: 16, fontWeight: '700', color: '#4338CA' },
  participantBody: { flex: 1, minWidth: 0 },
  participantName: { fontSize: 15, fontWeight: '700', color: '#111', marginBottom: 2 },
  metaSmall: { fontSize: 12, color: '#666' },
  inlineRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  registeredTxt: { color: '#166534', fontSize: 14, fontWeight: '600' },
  smallDangerBtn: {
    borderWidth: 1,
    borderColor: '#FECACA',
    backgroundColor: '#FEE2E2',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  smallDangerTxt: { color: '#B91C1C', fontSize: 12, fontWeight: '700' },
  placeholderBtn: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingVertical: 11,
    paddingHorizontal: 12,
    marginBottom: 8,
    backgroundColor: '#fafafa',
  },
  placeholderTxt: { color: '#374151', fontSize: 14, fontWeight: '600' },
});

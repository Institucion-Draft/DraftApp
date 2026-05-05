import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import { avatarPublicUrl } from '../lib/avatarUrl';
import PlayerAvatar from '../components/PlayerAvatar';
import type { MtgColor } from '../lib/database.types';
import { getEventStatusLabel, getEventTypeLabel } from '../lib/labels';

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

type PairingInsert = {
  event_id: string;
  participant_a_id: string;
  participant_b_id: string;
  data_source: 'app';
};

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

function formatDraftNetDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}min` : `${h}h`;
  if (m > 0) return s > 0 ? `${m} min ${s}s` : `${m} min`;
  return `${s}s`;
}

export default function EventDetailScreen({ route, navigation }: Props) {
  const isFocused = useIsFocused();
  const [participantColors, setParticipantColors] = useState<Record<string, MtgColor[]>>({});
  const { eventId } = route.params;
  const [event, setEvent] = useState<EventRow | null>(null);
  const [participants, setParticipants] = useState<ParticipantView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [isWorkspaceMember, setIsWorkspaceMember] = useState(false);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [myParticipantId, setMyParticipantId] = useState<string | null>(null);
  const [cubeName, setCubeName] = useState<string | null>(null);
  const [venueName, setVenueName] = useState<string | null>(null);
  const firstRef = useRef(true);
  const [, setDraftDurationTick] = useState(0);

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

    const meRes = await supabase.auth.getUser();
    const currentUserId = meRes.data.user?.id ?? null;
    setMyUserId(currentUserId);

    const [roleRes, partsRes, cubeRes, venueRes] = await Promise.all([
      currentUserId
        ? supabase
            .from('workspace_members')
            .select('role')
            .eq('workspace_id', e.workspace_id)
            .eq('user_id', currentUserId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase
        .from('event_participants')
        .select(
          `
          id,
          user_id,
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

    if (roleRes.error) {
      if (__DEV__) {
        console.error('Error cargando rol del workspace:', roleRes.error);
      }
    }
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

  useEffect(() => {
    if (!event?.draft_started_at || event.draft_ended_at || !isFocused) return;
    const id = setInterval(() => setDraftDurationTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [event?.draft_started_at, event?.draft_ended_at, isFocused]);

  useLayoutEffect(() => {
    const wsId = event?.workspace_id;
    navigation.setOptions({
      title: event?.name ?? 'Evento',
      headerLeft: wsId
        ? hierarchicalHeaderBack(navigation, 'EventsList', { workspaceId: wsId })
        : undefined,
    });
  }, [event?.name, event?.workspace_id, navigation]);

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

  const finishDraftAndGeneratePairings = async () => {
    if (!event) return;

    const toPlaying = await supabase
      .from('draft_events')
      .update({ draft_ended_at: new Date().toISOString(), status: 'playing' })
      .eq('id', event.id);
    if (toPlaying.error) {
      if (__DEV__) {
        console.error('[finishDraft] Error actualizando evento a playing', toPlaying.error);
      }
      Alert.alert('Error', toPlaying.error.message ?? 'No se pudo marcar fin del draft.');
      return;
    }

    const partsRes = await supabase
      .from('event_participants')
      .select(
        `
        id,
        users!event_participants_user_id_fkey (
          display_name,
          username
        )
      `
      )
      .eq('event_id', event.id)
      .eq('role', 'player');

    if (partsRes.error) {
      if (__DEV__) {
        console.error('[finishDraft] Error cargando participantes', partsRes.error);
      }
      await supabase
        .from('draft_events')
        .update({ status: 'drafting', draft_ended_at: null })
        .eq('id', event.id);
      Alert.alert('Error', partsRes.error.message ?? 'No se pudieron generar los enfrentamientos.');
      await load();
      return;
    }

    const players = ((partsRes.data ?? []) as Array<{ id: string; users: any }>).map((p) => {
      const u = relationOne(p.users) as { display_name?: string; username?: string } | null;
      const name = (u?.display_name || u?.username || '').trim();
      return { id: p.id, sortName: name.toLocaleLowerCase('es-AR') };
    });

    if (players.length < 2) {
      if (__DEV__) {
        console.error('[finishDraft] Jugadores insuficientes para generar pairings', {
          eventId: event.id,
          playersLength: players.length,
        });
      }
      await supabase
        .from('draft_events')
        .update({ status: 'drafting', draft_ended_at: null })
        .eq('id', event.id);
      Alert.alert('Error', 'Se necesitan al menos 2 jugadores para generar enfrentamientos.');
      await load();
      return;
    }

    players.sort((a, b) => a.sortName.localeCompare(b.sortName, 'es', { sensitivity: 'base' }));

    const inserts: PairingInsert[] = [];
    for (let i = 0; i < players.length; i += 1) {
      for (let j = i + 1; j < players.length; j += 1) {
        const aId = players[i]?.id ?? '';
        const bId = players[j]?.id ?? '';
        if (!aId || !bId || aId === bId) continue;
        const participant_a_id = aId < bId ? aId : bId;
        const participant_b_id = aId < bId ? bId : aId;
        inserts.push({
          event_id: event.id,
          participant_a_id,
          participant_b_id,
          data_source: 'app',
        });
      }
    }

    if (inserts.length === 0) {
      if (__DEV__) {
        console.error('[finishDraft] inserts vacío con jugadores suficientes', {
          eventId: event.id,
          playersLength: players.length,
          playerIds: players.map((p) => p.id),
        });
      }
      await supabase
        .from('draft_events')
        .update({ status: 'drafting', draft_ended_at: null })
        .eq('id', event.id);
      Alert.alert('Error', 'No se pudieron generar enfrentamientos. Probá de nuevo.');
      await load();
      return;
    }

    if (inserts.length > 0) {
      const insertRes = await supabase.from('pairings').upsert(inserts, {
        onConflict: 'event_id,participant_a_id,participant_b_id',
        ignoreDuplicates: true,
      });
      if (insertRes.error) {
        if (__DEV__) {
          console.error('[finishDraft] Error insertando/upsert pairings', insertRes.error);
        }
        await supabase
          .from('draft_events')
          .update({ status: 'drafting', draft_ended_at: null })
          .eq('id', event.id);
        Alert.alert('Error', insertRes.error.message ?? 'No se pudieron crear los enfrentamientos.');
        await load();
        return;
      }
    }

    const verifyRes = await supabase
      .from('pairings')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', event.id);
    if (verifyRes.error) {
      if (__DEV__) {
        console.error('[finishDraft] Error verificando pairings insertados', verifyRes.error);
      }
      await supabase
        .from('draft_events')
        .update({ status: 'drafting', draft_ended_at: null })
        .eq('id', event.id);
      Alert.alert('Error', verifyRes.error.message ?? 'No se pudieron verificar los enfrentamientos generados.');
      await load();
      return;
    }
    const totalInDb = verifyRes.count ?? 0;
    if (totalInDb !== inserts.length) {
      if (__DEV__) {
        console.error('[finishDraft] Verificación inconsistente de pairings', {
          eventId: event.id,
          expected: inserts.length,
          actual: totalInDb,
        });
      }
      await supabase
        .from('draft_events')
        .update({ status: 'drafting', draft_ended_at: null })
        .eq('id', event.id);
      Alert.alert('Error', 'No se pudieron generar enfrentamientos. Probá de nuevo.');
      await load();
      return;
    }

    if (inserts.length > 0) {
      Alert.alert('Listo', `Se generaron ${inserts.length} enfrentamientos`);
    }
    await load();
  };

  const participantCount = participants.length;
  const myColors = myParticipantId ? participantColors[myParticipantId] ?? [] : [];
  const hasDeclaredColors = myColors.length > 0;
  const missingCube = !event?.cube_id;
  const missingVenue = !event?.venue_id;
  const missingParticipants = participantCount < 1;
  const startDraftDisabled = missingCube || missingVenue || missingParticipants;
  const missingStartRequirements: string[] = [];
  if (missingCube) missingStartRequirements.push('seleccionar el cubo');
  if (missingVenue) missingStartRequirements.push('seleccionar la sede');
  if (missingParticipants) {
    missingStartRequirements.push('que se inscriba al menos un jugador');
  }
  const startDraftDisabledHint = missingStartRequirements.length
    ? `Falta ${missingStartRequirements.join(', ')}`
    : '';

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
  const playingOrDone = event.status === 'playing' || event.status === 'completed';
  const showEnfrentamientosBtn = playingOrDone && (myParticipantId != null || isWorkspaceMember);
  const showStandingsBtn =
    isOrganizer || hasDeclaredColors || (playingOrDone && isWorkspaceMember && !myParticipantId);

  const goEnfrentamientos = () => {
    if (myParticipantId && !hasDeclaredColors && playingOrDone) {
      navigation.navigate('EventCheckIn', { eventId: event.id, returnTo: 'EventDetail' });
      return;
    }
    navigation.navigate('PairingsList', { eventId: event.id });
  };

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
        {event.draft_started_at && event.draft_ended_at ? (
          <Text style={styles.meta}>
            Duración del draft:{' '}
            {formatDraftNetDuration(
              new Date(event.draft_ended_at).getTime() - new Date(event.draft_started_at).getTime()
            )}
          </Text>
        ) : null}
        {event.draft_started_at && !event.draft_ended_at ? (
          <Text style={styles.meta}>
            Drafteando: {formatDraftNetDuration(Date.now() - new Date(event.draft_started_at).getTime())}
          </Text>
        ) : null}
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
                Alert.alert('Iniciar draft', '¿Iniciar el draft? Se cierran las inscripciones.', [
                  { text: 'Volver', style: 'cancel' },
                  {
                    text: 'Iniciar',
                    onPress: () => void patchEvent({ draft_started_at: new Date().toISOString(), status: 'drafting' }),
                  },
                ])
              }
            >
              <Text style={styles.secondaryBtnTxt}>Arrancar a draftear</Text>
            </TouchableOpacity>
          ) : null}
          {event.status === 'scheduled' && startDraftDisabled ? (
            <Text style={styles.disabledHint}>
              {startDraftDisabledHint}
            </Text>
          ) : null}
          {event.draft_started_at && !event.draft_ended_at ? (
            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={() =>
                Alert.alert(
                  'Fin del draft',
                  '¿Finalizar draft? Queda habilitado Enfrentamientos.',
                  [
                    { text: 'Volver', style: 'cancel' },
                    {
                      text: 'Finalizar',
                      onPress: () => void finishDraftAndGeneratePairings(),
                    },
                  ]
                )
              }
            >
              <Text style={styles.secondaryBtnTxt}>Finalizar draft</Text>
            </TouchableOpacity>
          ) : null}
          {(event.status === 'scheduled' || event.status === 'drafting') && !event.cube_id ? (
            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={() => navigation.navigate('CubeRoulette', { eventId: event.id })}
            >
              <Text style={styles.secondaryBtnTxt}>Ruleta</Text>
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

      {event.status === 'scheduled' ? (
        <View style={styles.block}>
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
        </View>
      ) : null}

      {event.status === 'drafting' ? (
        <View style={styles.block}>
          {!myParticipantId ? (
            <Text style={styles.muted}>Las inscripciones cerraron al iniciar el draft.</Text>
          ) : (
            <Text style={styles.muted}>Estás inscripto en este evento.</Text>
          )}
        </View>
      ) : null}

      {showEnfrentamientosBtn ? (
        <View style={styles.block}>
          <TouchableOpacity style={styles.primaryBtn} onPress={goEnfrentamientos}>
            <Text style={styles.primaryBtnTxt}>Enfrentamientos</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {showStandingsBtn ? (
        <View style={styles.block}>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => navigation.navigate('Standings', { eventId: event.id })}
          >
            <Text style={styles.primaryBtnTxt}>Tabla de posiciones</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={styles.block}>
        <Text style={styles.blockTitle}>Participantes</Text>
        {participants.length === 0 ? <Text style={styles.muted}>Todavía no hay participantes.</Text> : null}
        {participants.map((p) => {
          const u = relationOne(p.users);
          const uname = u?.display_name || u?.username || 'sin nombre';
          return (
            <TouchableOpacity
              key={p.id}
              style={styles.participantRow}
              onPress={() =>
                navigation.navigate('PlayerProfileInEvent', {
                  eventId: event.id,
                  participantId: p.id,
                  from: 'EventDetail',
                })
              }
            >
              <PlayerAvatar
                userId={p.user_id}
                participantId={p.id}
                size="small"
                withColorBorder={false}
                style={{ marginRight: 10 }}
              />
              <View style={styles.participantBody}>
                <Text style={styles.participantName}>{uname}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={[styles.block, styles.blockLast]}>
        <TouchableOpacity
          style={styles.placeholderBtn}
          onPress={() => Alert.alert('Próximamente', 'Bitácora digital llegará en una próxima versión.')}
        >
          <Text style={styles.placeholderTxt}>Bitácora digital</Text>
          <Text style={styles.placeholderSub}>Próximamente</Text>
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
  placeholderSub: { color: '#9CA3AF', fontSize: 12, marginTop: 4, fontWeight: '500' },
  blockLast: { paddingBottom: 28 },
});

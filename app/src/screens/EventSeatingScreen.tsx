import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import SeatingTable, { type SeatOccupant } from '../components/SeatingTable';
import { preloadAvatars } from '../components/PlayerAvatar';
import {
  isDraftStarted,
  rouletteDelays,
  rouletteSeat,
  seatingPersons,
  seatingScreenMode,
  type PackDirection,
  type SeatingParticipantRow,
} from '../lib/eventSeating';
import {
  drawSeating,
  fetchDisplayNames,
  fetchPendingSeating,
  fetchSeating,
  fetchSeatingParticipants,
  publishSeating,
  type DrawResult,
  type SeatEntry,
  type SeatingRecord,
} from '../lib/eventSeatingApi';
import { useTheme, useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';

type Props = NativeStackScreenProps<MainStackParamList, 'EventSeating'>;

/** Espera máxima por la precarga de avatares antes de arrancar la ruleta. */
const PRELOAD_TIMEOUT_MS = 2000;
/** Final de la ruleta: fade out de todos, mesa vacía, y fade in escalonado por lugar. */
const FADE_OUT_MS = 400;
const EMPTY_HOLD_MS = 350;
const FADE_IN_MS = 300;
const FADE_IN_STAGGER_MS = 120;

type EventInfo = {
  name: string;
  workspace_id: string;
  draft_started_at: string | null;
  status: string;
  random_seating_enabled: boolean;
  event_organizer_user_id: string | null;
};

/**
 * Mesa del evento: lugares 1..n, sentido de los sobres y, para quien gestiona, el sorteo con la ruleta.
 * La animación es cosmética: el resultado lo calcula el servidor (draw_event_seating) y se publica al terminar
 * (publish_event_seating), o al volver / salir de la pantalla si se interrumpió.
 */
export default function EventSeatingScreen({ route, navigation }: Props) {
  const { eventId } = route.params;
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  // Los vórtices giran sólo con la pantalla en foco.
  const isFocused = useIsFocused();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [event, setEvent] = useState<EventInfo | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [participants, setParticipants] = useState<SeatingParticipantRow[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [current, setCurrent] = useState<SeatingRecord | null>(null);
  const [pending, setPending] = useState<DrawResult | null>(null);

  const [busy, setBusy] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [rouletteStep, setRouletteStep] = useState(0);
  const [rouletteSteps, setRouletteSteps] = useState(0);
  const [drawn, setDrawn] = useState<DrawResult | null>(null);
  const blink = useRef(new Animated.Value(1)).current;
  const firstRef = useRef(true);
  // Publicación: nunca dos a la vez, y si el organizador sale a mitad de la animación se publica igual.
  const publishingRef = useRef(false);
  const toPublishRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Parpadeo de la ruleta: se guarda el loop para poder frenarlo y terminar con un fundido a opacidad 1.
  const blinkLoopRef = useRef<Animated.CompositeAnimation | null>(null);
  // Fade out / fade in del final de la ruleta, y la opacidad de cada lugar (índice = lugar - 1).
  const revealAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  const seatFadesRef = useRef<Animated.Value[]>([]);
  // false una vez desmontada la pantalla: frena la secuencia de onDraw (preload y callbacks de animación).
  const aliveRef = useRef(true);
  // Espejo de `animating` para que load() (que no depende de él) sepa si hay una ruleta en curso.
  const animatingRef = useRef(false);
  // Generación de load(): sólo la última llamada puede escribir en el estado.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const { data: ev, error } = await supabase
      .from('draft_events')
      .select('name, workspace_id, draft_started_at, status, random_seating_enabled, event_organizer_user_id')
      .eq('id', eventId)
      .maybeSingle();
    if (seq !== loadSeq.current) return;
    if (error || !ev) {
      Alert.alert('Error', 'No se pudo cargar el evento.');
      return;
    }
    const info = ev as EventInfo;
    setEvent(info);

    const me = (await supabase.auth.getUser()).data.user?.id ?? null;
    if (seq !== loadSeq.current) return;
    let manage = false;
    if (me) {
      if (info.event_organizer_user_id === me) manage = true;
      else {
        const roleRes = await supabase
          .from('workspace_members')
          .select('role')
          .eq('workspace_id', info.workspace_id)
          .eq('user_id', me)
          .maybeSingle();
        manage = roleRes.data?.role === 'organizer';
        if (seq !== loadSeq.current) return;
      }
    }
    setCanManage(manage);

    try {
      const [rows, cur, pend] = await Promise.all([
        fetchSeatingParticipants(eventId),
        fetchSeating(eventId),
        manage ? fetchPendingSeating(eventId) : Promise.resolve(null),
      ]);
      if (seq !== loadSeq.current) return;
      setParticipants(rows);
      setCurrent(cur);
      // Con una ruleta o una publicación en curso el pendiente lo maneja onDraw / publish: pisarlo dispararía un segundo publish().
      if (!animatingRef.current && !publishingRef.current) setPending(pend);
      const userIds = [
        ...rows.flatMap((r) => [r.user_id, r.member_b_user_id ?? '']),
        ...(cur?.seats ?? []).map((s) => s.user_id),
        ...(pend?.seats ?? []).map((s) => s.user_id),
      ];
      const nameMap = await fetchDisplayNames(userIds);
      if (seq !== loadSeq.current) return;
      setNames(nameMap);
    } catch (e) {
      if (__DEV__) console.warn('[seating] carga', e);
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

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const draftStarted = event ? isDraftStarted(event) : false;
  const mode = seatingScreenMode({ canManage, hasPending: !!pending && !draftStarted, current, animating });

  // Publica el sorteo pendiente (sin duplicar llamadas). Si falla, queda pendiente y se reintenta al volver a abrir.
  const publish = useCallback(async () => {
    if (publishingRef.current) return;
    publishingRef.current = true;
    try {
      await publishSeating(eventId);
      toPublishRef.current = false;
      // El registro vigente entra al estado en el mismo lote que se suelta el pendiente: ningún render intermedio con la mesa vacía o vieja.
      const cur = await fetchSeating(eventId);
      if (cur) setCurrent(cur);
      setPending(null);
      setDrawn(null);
      await load();
    } catch (e) {
      if (__DEV__) console.warn('[seating] publicar', e);
    } finally {
      publishingRef.current = false;
    }
  }, [eventId, load]);

  // El organizador vuelve con un sorteo sin publicar (cerró la app a mitad de la animación): se muestra estático y se publica.
  useEffect(() => {
    if (mode === 'pending' && !publishingRef.current) void publish();
  }, [mode, publish]);

  // Salir de la pantalla durante la animación también publica.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      timersRef.current.forEach(clearTimeout);
      blinkLoopRef.current?.stop();
      revealAnimRef.current?.stop();
      if (toPublishRef.current && !publishingRef.current) {
        toPublishRef.current = false;
        void publishSeating(eventId).catch(() => undefined);
      }
    };
  }, [eventId]);

  const persons = useMemo(() => seatingPersons(participants), [participants]);

  const nameOf = useCallback((userId: string) => names.get(userId) ?? 'Jugador', [names]);

  const occupantsFrom = useCallback(
    (seats: SeatEntry[], displaySeat?: (s: SeatEntry) => number): Map<number, SeatOccupant> => {
      const map = new Map<number, SeatOccupant>();
      for (const s of seats) {
        map.set(displaySeat ? displaySeat(s) : s.seat, {
          userId: s.user_id,
          participantId: s.participant_id,
          member: s.member,
          name: nameOf(s.user_id),
        });
      }
      return map;
    },
    [nameOf]
  );

  const startBlink = () => {
    blink.setValue(1);
    blinkLoopRef.current?.stop();
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(blink, { toValue: 0.3, duration: 130, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 130, useNativeDriver: true }),
      ])
    );
    blinkLoopRef.current = loop;
    loop.start();
  };

  // Final de la ruleta: el parpadeo se corta junto con el fade out de todos los lugares; queda la mesa vacía un instante
  // (ya con las posiciones definitivas montadas, invisibles) y los definitivos entran por fade in, lugar por lugar.
  // Recién terminado el fade in se suelta `animating` y se publica: el render del estado final es idéntico al que ya se ve.
  const revealFinal = (steps: number, fades: Animated.Value[]) => {
    blinkLoopRef.current?.stop();
    blinkLoopRef.current = null;
    const fadeOut = Animated.parallel([
      Animated.timing(blink, { toValue: 1, duration: 120, useNativeDriver: true }),
      ...fades.map((v) => Animated.timing(v, { toValue: 0, duration: FADE_OUT_MS, useNativeDriver: true })),
    ]);
    revealAnimRef.current = fadeOut;
    fadeOut.start(({ finished }) => {
      if (!finished || !aliveRef.current) return;
      setRouletteStep(steps);
      timersRef.current.push(
        setTimeout(() => {
          const fadeIn = Animated.stagger(
            FADE_IN_STAGGER_MS,
            fades.map((v) => Animated.timing(v, { toValue: 1, duration: FADE_IN_MS, useNativeDriver: true }))
          );
          revealAnimRef.current = fadeIn;
          fadeIn.start(({ finished: done }) => {
            if (!done || !aliveRef.current) return;
            revealAnimRef.current = null;
            animatingRef.current = false;
            setAnimating(false);
            setBusy(false);
            void publish();
          });
        }, EMPTY_HOLD_MS)
      );
    });
  };

  const onDraw = async () => {
    if (busy || animating || !event) return;
    setBusy(true);
    let result: DrawResult;
    try {
      result = await drawSeating(eventId);
    } catch (e) {
      setBusy(false);
      Alert.alert('No se pudo sortear', (e as { message?: string }).message ?? 'Probá de nuevo.');
      return;
    }
    // A partir de acá el sorteo existe en el servidor como pendiente: pase lo que pase se publica.
    toPublishRef.current = true;
    const fades = Array.from({ length: result.n }, () => new Animated.Value(1));
    seatFadesRef.current = fades;
    setDrawn(result);
    setPending(result);
    if (result.warning) Alert.alert('Aviso', result.warning);

    // Frena fuerte hacia el final y el último paso intermedio dura claramente más (suspenso antes del fade out).
    const base = rouletteDelays(2800, 70, 1.22);
    const delays = base.map((d, i) => (i === base.length - 1 ? Math.round(d * 1.8) : d));
    setRouletteSteps(delays.length);
    setRouletteStep(0);
    animatingRef.current = true;
    setAnimating(true);
    // Los avatares se precargan antes de arrancar: así cada paso resuelve nombre y avatar sincrónicamente desde el caché.
    await preloadAvatars(
      result.seats.map((s) => ({ participantId: s.participant_id, userId: s.user_id, member: s.member })),
      PRELOAD_TIMEOUT_MS
    );
    if (!aliveRef.current) return;
    startBlink();
    let acc = 0;
    delays.forEach((d, i) => {
      acc += d;
      // El último paso mostrado es el anterior al definitivo: de ahí se pasa al fade out, no a las posiciones finales.
      if (i < delays.length - 1) timersRef.current.push(setTimeout(() => setRouletteStep(i + 1), acc));
    });
    timersRef.current.push(setTimeout(() => revealFinal(delays.length, fades), acc));
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      title: draftStarted && canManage ? 'Posiciones en la mesa' : 'Lugares en la mesa',
    });
  }, [navigation, draftStarted, canManage]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.accent} />
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

  // Qué se dibuja
  let n = persons.length;
  let occupants = new Map<number, SeatOccupant>();
  let direction: PackDirection | null = null;
  if (mode === 'animating' && drawn) {
    n = drawn.n;
    // La dirección ya se ve durante la ruleta: así vórtices y flechas no aparecen de golpe al asentarse.
    direction = drawn.direction;
    occupants = occupantsFrom(drawn.seats, (s) => rouletteSeat(s.seat, drawn.n, rouletteStep, rouletteSteps));
  } else if (mode === 'pending' && pending) {
    n = pending.n;
    direction = pending.direction;
    occupants = occupantsFrom(pending.seats);
  } else if (mode === 'current' && current) {
    n = current.n;
    direction = current.direction;
    occupants = occupantsFrom(current.seats);
  }

  const canDraw = canManage && !draftStarted && event.random_seating_enabled && (mode === 'empty' || mode === 'current' || mode === 'pending');
  const drawLabel = current?.is_current ? 'Volver a sortear lugares' : 'Sortear lugares';

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {mode === 'stale' ? (
          <View style={styles.staleBox}>
            <Text style={styles.staleTitle}>Los lugares se van a volver a sortear</Text>
            <Text style={styles.muted}>Cambiaron los inscriptos: el organizador va a sortear la mesa de nuevo.</Text>
          </View>
        ) : (
          <>
            {n < 2 ? (
              <Text style={styles.muted}>Se necesitan al menos 2 inscriptos para sortear los lugares.</Text>
            ) : (
              <SeatingTable
                eventId={eventId}
                n={n}
                occupants={occupants}
                direction={direction}
                blink={blink}
                seatFade={seatFadesRef.current}
                lite={mode === 'animating' && rouletteStep < rouletteSteps}
                active={isFocused}
              />
            )}
          </>
        )}
      </ScrollView>

      {canDraw ? (
        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.drawBtn, (busy || animating || n < 2) && styles.drawBtnDisabled]}
            disabled={busy || animating || n < 2}
            onPress={() => void onDraw()}
          >
            {busy || animating ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.drawBtnTxt}>{drawLabel}</Text>}
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: c.background },
    scroll: { padding: 16, paddingBottom: 24, flexGrow: 1 },
    muted: { fontSize: 14, color: c.textSecondary, textAlign: 'center' },
    staleBox: { marginTop: 40, padding: 20, borderRadius: 12, borderWidth: 1, borderColor: c.divider, backgroundColor: c.card, alignItems: 'center', gap: 8 },
    staleTitle: { fontSize: 17, fontWeight: '700', color: c.text, textAlign: 'center' },
    footer: { padding: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.divider, backgroundColor: c.background },
    drawBtn: { backgroundColor: c.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
    drawBtnDisabled: { opacity: 0.6 },
    drawBtnTxt: { color: c.onAccent, fontSize: 16, fontWeight: '700' },
  });

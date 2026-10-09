import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';
import { normalizeCompetitionFormat } from '../lib/eventMode';
import {
  buildZoneOption,
  recommendZoneOptions,
  zoneLayout,
  ZONES_MAX,
  ZONES_MIN,
  type ZoneOption,
} from '../lib/zonesPlanner';
import { zoneOptionKey, zoneOptionLines, zoneOptionText } from '../lib/zonesPlannerText';
import ZonesSchema from '../components/ZonesSchema';
import { CUP_CONSUELO_NAME, cupPrimaName } from '../lib/knockoutRounds';
import { fetchEventVenueName } from '../lib/eventVenueName';

type Props = NativeStackScreenProps<MainStackParamList, 'ZonesDraw'>;

type EventRow = {
  id: string;
  name: string;
  competition_format: string | null;
  match_format: 'bo1' | 'bo2' | 'bo3' | null;
  /** Formato de las llaves (Copa principal y Consuelo). */
  topcut_format: string | null;
  status: string;
  zones_drawn_at: string | null;
};

type DrawResult = { already_drawn?: boolean };

const MATCH_FORMAT_LABEL: Record<string, string> = { bo1: 'BO1', bo2: 'BO2', bo3: 'BO3' };

export default function ZonesDrawScreen({ route, navigation }: Props) {
  const { eventId } = route.params;
  const styles = useThemedStyles(createStyles);

  const [loading, setLoading] = useState(true);
  const [event, setEvent] = useState<EventRow | null>(null);
  const [playerCount, setPlayerCount] = useState(0);
  const [venueName, setVenueName] = useState<string | null>(null);
  const [tab, setTab] = useState<'recommended' | 'custom'>('recommended');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [custom, setCustom] = useState({ k: 2, q: 1, w: 0, iz: false });
  const [customInit, setCustomInit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const load = useCallback(async () => {
    const [evRes, partsRes, venue] = await Promise.all([
      supabase
        .from('draft_events')
        .select('id, name, competition_format, match_format, topcut_format, status, zones_drawn_at')
        .eq('id', eventId)
        .maybeSingle(),
      // Inscriptos activos: jugadores que no usaron "Me voy".
      supabase
        .from('event_participants')
        .select('id', { count: 'exact', head: true })
        .eq('event_id', eventId)
        .eq('role', 'player')
        .is('left_event_at', null),
      fetchEventVenueName(eventId),
    ]);
    setEvent((evRes.data as EventRow | null) ?? null);
    setPlayerCount(partsRes.count ?? 0);
    setVenueName(venue);
    setLoading(false);
  }, [eventId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const matchFormat = event?.match_format ?? undefined;
  const recommended = useMemo(
    () => recommendZoneOptions({ playerCount, matchFormat: matchFormat ?? undefined }),
    [playerCount, matchFormat]
  );

  // Estado inicial: la primera recomendada seleccionada (sugerida); Personalizar arranca desde ella.
  const effectiveSelectedKey = selectedKey ?? (recommended[0] ? zoneOptionKey(recommended[0]) : null);
  useEffect(() => {
    if (customInit || !recommended[0] || playerCount <= 0) return;
    const r = recommended[0];
    setCustom({ k: r.zonesCount, q: r.qualifiers, w: r.wildcards, iz: r.interzonal });
    setCustomInit(true);
  }, [customInit, recommended, playerCount]);

  const customLayout = useMemo(() => zoneLayout(playerCount, custom.k), [playerCount, custom.k]);
  const customMinSize = Math.min(...customLayout.sizes);
  const customOption: ZoneOption = useMemo(
    () => buildZoneOption(playerCount, custom.k, custom.q, custom.w, custom.iz),
    [playerCount, custom]
  );

  const setK = (k: number) => {
    const lay = zoneLayout(playerCount, k);
    const min = Math.min(...lay.sizes);
    setCustom((c) => ({
      k,
      q: Math.max(1, Math.min(c.q, min)),
      w: Math.max(0, Math.min(c.w, k - 1)),
      iz: lay.mode === 'mandatory' ? true : lay.mode === 'impossible' ? false : c.iz,
    }));
  };

  const selectedRecommended = recommended.find((o) => zoneOptionKey(o) === effectiveSelectedKey) ?? null;
  const chosen: ZoneOption | null = tab === 'recommended' ? selectedRecommended : customOption;
  const alreadyDrawn = event?.zones_drawn_at != null;
  const confirmDisabled =
    submitting || alreadyDrawn || chosen == null || chosen.blockers.length > 0 || event?.status !== 'playing';

  const cupNames = useMemo(() => ({ prima: cupPrimaName(venueName), consuelo: CUP_CONSUELO_NAME }), [venueName]);

  // Vuelve al detalle del evento ya existente en el stack y le pasa una marca nueva: el detalle recarga TODO (evento,
  // nota de grupos sorteados y botones de Enfrentamientos y Tabla) sin depender de que el foco dispare la carga.
  const backToEventDetail = () => {
    navigation.popTo('EventDetail', { eventId, refresh: Date.now() });
  };

  const runDraw = async (o: ZoneOption) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const { data, error } = await supabase.rpc('draw_zones', {
      p_event_id: eventId,
      p_zones_count: o.zonesCount,
      p_qualifiers: o.qualifiers,
      p_wildcards: o.wildcards,
      p_interzonal: o.interzonal,
    });
    submittingRef.current = false;
    setSubmitting(false);
    if (error) {
      const permission = error.code === '42501';
      Alert.alert(
        permission ? 'Sin permisos' : 'No se pudo sortear',
        permission ? 'Solo quien gestiona el evento puede sortear los grupos.' : error.message ?? 'Probá de nuevo.'
      );
      await load();
      return;
    }
    const res = (data ?? {}) as DrawResult;
    if (res.already_drawn) {
      Alert.alert('Grupos ya sorteados', 'Los grupos de este evento ya se habían sorteado; no se hizo ningún cambio.', [
        { text: 'OK', onPress: () => backToEventDetail() },
      ]);
      return;
    }
    Alert.alert('Grupos sorteados', 'Ya están armadas las zonas y los partidos de cada grupo.', [
      { text: 'OK', onPress: () => backToEventDetail() },
    ]);
  };

  const onConfirm = () => {
    if (confirmDisabled || !chosen) return;
    Alert.alert('¿Sortear grupos?', 'Esta acción no se puede deshacer.', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Sortear', onPress: () => void runDraw(chosen) },
    ]);
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!event || normalizeCompetitionFormat(event.competition_format) !== 'zones_knockout') {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Este evento no es de Grupos + Copa.</Text>
      </View>
    );
  }

  const formatLabel = event.match_format ? MATCH_FORMAT_LABEL[event.match_format] ?? event.match_format : '—';
  const topcutLabel = event.topcut_format === 'bo1' || event.topcut_format === 'bo3' ? event.topcut_format.toUpperCase() : '—';

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.meta}>
          {playerCount} jugadores · Grupos {formatLabel} · Llaves {topcutLabel}
        </Text>

        {alreadyDrawn ? (
          <View style={styles.noticeBox}>
            <Text style={styles.noticeTxt}>Los grupos de este evento ya se sortearon.</Text>
          </View>
        ) : event.status !== 'playing' ? (
          <View style={styles.noticeBox}>
            <Text style={styles.noticeTxt}>El sorteo se hace al finalizar el draft.</Text>
          </View>
        ) : null}

        <View style={styles.tabsRow}>
          {(
            [
              ['recommended', 'Recomendadas'],
              ['custom', 'Personalizar'],
            ] as const
          ).map(([key, label]) => (
            <TouchableOpacity key={key} style={styles.tabBtn} onPress={() => setTab(key)} activeOpacity={0.7}>
              <Text style={[styles.tabLabel, tab === key && styles.tabLabelActive]}>{label}</Text>
              <View style={[styles.tabUnderline, tab !== key && styles.tabUnderlineHidden]} />
            </TouchableOpacity>
          ))}
        </View>

        {tab === 'recommended' ? (
          recommended.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Sin recomendadas</Text>
              <Text style={styles.cardLine}>
                {playerCount < 8
                  ? `Con ${playerCount} inscriptos no hay una configuración recomendada: los grupos quedarían muy chicos. Armá la tuya en "Personalizar" y revisá las advertencias.`
                  : 'No hay una configuración recomendada para esta cantidad de inscriptos. Armá la tuya en "Personalizar".'}
              </Text>
              <TouchableOpacity style={styles.secondaryBtn} onPress={() => setTab('custom')}>
                <Text style={styles.secondaryBtnTxt}>Ir a Personalizar</Text>
              </TouchableOpacity>
            </View>
          ) : (
            recommended.map((o, idx) => {
              const t = zoneOptionText(o, cupNames);
              const key = zoneOptionKey(o);
              const selected = key === effectiveSelectedKey;
              return (
                <TouchableOpacity
                  key={key}
                  style={[styles.card, selected && styles.cardSelected]}
                  onPress={() => setSelectedKey(key)}
                  activeOpacity={0.8}
                >
                  <View style={styles.cardHeader}>
                    <Text style={styles.cardTitle}>{t.title}</Text>
                    {idx === 0 ? (
                      <View style={styles.suggestedBadge}>
                        <Text style={styles.suggestedBadgeTxt}>Sugerida</Text>
                      </View>
                    ) : null}
                  </View>
                  {zoneOptionLines(t).map((line) => (
                    <Text key={line} style={styles.cardLine}>
                      {line}
                    </Text>
                  ))}
                  {t.warnings.map((w) => (
                    <Text key={w} style={styles.warnTxt}>
                      ⚠ {w}
                    </Text>
                  ))}
                </TouchableOpacity>
              );
            })
          )
        ) : (
          <View style={styles.card}>
            <StepperRow
              styles={styles}
              label="Cantidad de zonas"
              value={custom.k}
              min={ZONES_MIN}
              max={ZONES_MAX}
              onChange={setK}
            />
            <View style={styles.switchRow}>
              <Text style={styles.rowLabel}>Interzonal</Text>
              <Switch
                value={customOption.interzonal}
                disabled={customLayout.mode !== 'optional'}
                onValueChange={(v) => setCustom((c) => ({ ...c, iz: v }))}
              />
            </View>
            <Text style={styles.hint}>
              {customLayout.mode === 'impossible'
                ? 'No se puede jugar interzonal con esta cantidad de jugadores y zonas.'
                : customLayout.mode === 'mandatory'
                  ? 'El interzonal es obligatorio: lo juegan los jugadores de las zonas más chicas, cada uno contra uno de otra zona.'
                  : 'Opcional: todos juegan un partido extra contra alguien de otra zona.'}
            </Text>
            <StepperRow
              styles={styles}
              label="Clasificados por zona"
              value={custom.q}
              min={1}
              max={Math.max(1, customMinSize)}
              onChange={(q) => setCustom((c) => ({ ...c, q }))}
            />
            <StepperRow
              styles={styles}
              label="Mejores del puesto siguiente"
              value={custom.w}
              min={0}
              max={custom.k - 1}
              onChange={(w) => setCustom((c) => ({ ...c, w }))}
            />

            <View style={styles.derived}>
              <Text style={styles.derivedTitle}>Así queda</Text>
              {(() => {
                const t = zoneOptionText(customOption, cupNames);
                return [t.title, ...zoneOptionLines(t)].map((line, i) => (
                  <Text key={line} style={i === 0 ? styles.derivedHead : styles.cardLine}>
                    {line}
                  </Text>
                ));
              })()}
              {customOption.blockers.map((b) => (
                <Text key={b} style={styles.blockTxt}>
                  ⛔ {b}
                </Text>
              ))}
              {customOption.warnings.map((w) => (
                <Text key={w} style={styles.warnTxt}>
                  ⚠ {w}
                </Text>
              ))}
            </View>
          </View>
        )}

        {chosen ? <ZonesSchema option={chosen} names={cupNames} /> : null}
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.primaryBtn, confirmDisabled && styles.primaryBtnDisabled]}
          disabled={confirmDisabled}
          onPress={onConfirm}
        >
          {submitting ? (
            <ActivityIndicator />
          ) : (
            <Text style={styles.primaryBtnTxt}>Confirmar</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

function StepperRow({
  styles,
  label,
  value,
  min,
  max,
  onChange,
}: {
  styles: ReturnType<typeof createStyles>;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <View style={styles.stepperRow}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.stepper}>
        <TouchableOpacity
          style={[styles.stepBtn, value <= min && styles.stepBtnDisabled]}
          disabled={value <= min}
          onPress={() => onChange(value - 1)}
          accessibilityLabel={`Menos ${label}`}
        >
          <Text style={styles.stepBtnTxt}>−</Text>
        </TouchableOpacity>
        <Text style={styles.stepValue}>{value}</Text>
        <TouchableOpacity
          style={[styles.stepBtn, value >= max && styles.stepBtnDisabled]}
          disabled={value >= max}
          onPress={() => onChange(value + 1)}
          accessibilityLabel={`Más ${label}`}
        >
          <Text style={styles.stepBtnTxt}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: c.background, padding: 24 },
    scroll: { padding: 16, paddingBottom: 24 },
    muted: { color: c.textSecondary, fontSize: 14, textAlign: 'center' },
    title: { fontSize: 22, fontWeight: '800', color: c.text },
    meta: { marginTop: 4, fontSize: 15, fontWeight: '600', color: c.textBody },
    derivedHead: { marginTop: 4, fontSize: 14, fontWeight: '800', color: c.text },
    noticeBox: {
      marginTop: 12,
      padding: 10,
      borderRadius: 10,
      backgroundColor: c.status.info.subtle,
      borderWidth: 1,
      borderColor: c.status.info.border,
    },
    noticeTxt: { color: c.status.info.text, fontSize: 13 },
    tabsRow: { flexDirection: 'row', marginTop: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.divider },
    tabBtn: { flex: 1, alignItems: 'center', paddingTop: 10 },
    tabLabel: { fontSize: 15, fontWeight: '600', color: c.textSecondary, paddingBottom: 8 },
    tabLabelActive: { color: c.accent },
    tabUnderline: { height: 3, alignSelf: 'stretch', backgroundColor: c.accent },
    tabUnderlineHidden: { backgroundColor: 'transparent' },
    card: {
      marginTop: 12,
      padding: 14,
      borderRadius: 12,
      backgroundColor: c.card,
      borderWidth: 1,
      borderColor: c.border,
    },
    cardSelected: { borderColor: c.accent, borderWidth: 2 },
    cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    cardTitle: { fontSize: 16, fontWeight: '800', color: c.text, flexShrink: 1 },
    cardLine: { marginTop: 3, fontSize: 13, color: c.textBody },
    suggestedBadge: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 999,
      backgroundColor: c.status.success.subtle,
      borderWidth: 1,
      borderColor: c.status.success.border,
    },
    suggestedBadgeTxt: { fontSize: 11, fontWeight: '700', color: c.status.success.text },
    warnTxt: { marginTop: 6, fontSize: 12, color: c.status.warning.text },
    blockTxt: { marginTop: 6, fontSize: 12, fontWeight: '700', color: c.status.error.text },
    stepperRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 },
    rowLabel: { fontSize: 14, fontWeight: '600', color: c.text, flexShrink: 1, paddingRight: 8 },
    stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    stepBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: c.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepBtnDisabled: { opacity: 0.35 },
    stepBtnTxt: { fontSize: 20, fontWeight: '700', color: c.text },
    stepValue: { minWidth: 24, textAlign: 'center', fontSize: 17, fontWeight: '800', color: c.text },
    switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
    hint: { marginTop: 4, fontSize: 12, color: c.textSecondary },
    derived: { marginTop: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.divider },
    derivedTitle: { fontSize: 14, fontWeight: '800', color: c.text },
    secondaryBtn: {
      marginTop: 12,
      paddingVertical: 10,
      borderRadius: 10,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: c.accent,
    },
    secondaryBtnTxt: { color: c.accent, fontSize: 15, fontWeight: '700' },
    footer: { padding: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.divider, backgroundColor: c.background },
    primaryBtn: { backgroundColor: c.accent, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
    primaryBtnDisabled: { opacity: 0.4 },
    primaryBtnTxt: { color: c.onAccent, fontSize: 16, fontWeight: '700' },
  });

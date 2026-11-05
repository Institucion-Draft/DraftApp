import PokemonReceivedSection from './PokemonReceivedSection';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { supabase } from '../lib/supabase';
import type { MtgColor } from '../lib/database.types';
import PlayerAvatar from './PlayerAvatar';
import { fetchEventPodiums, type EventPodiumResult } from '../lib/eventPodium';
import { cupReachedInstance, cupReachedText, type CupGroupInput, type CupSlotInput } from '../lib/cupReachedInstance';
import { CUP_CONSUELO_NAME, cupPrimaName } from '../lib/knockoutRounds';
import { resolveGenderedText, type Gender } from '../lib/genderText';
import { pickColorCombos, type ColorCombo, type ComboViewRow } from '../lib/colorCombos';
import { useTheme, useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';

// Todos los require() deben ser estáticos para Metro bundler
const MANA_IMAGES: Partial<Record<MtgColor, ReturnType<typeof require>>> = {
  W: require('../../assets/mana/mana_w.png'),
  U: require('../../assets/mana/mana_u.png'),
  B: require('../../assets/mana/mana_b.png'),
  R: require('../../assets/mana/mana_r.png'),
  G: require('../../assets/mana/mana_g.png'),
};

const MANA_SIZE_LG = 32;
const MANA_SIZE_SM = 20;
// Íconos de las combinaciones: más chicos y juntos para que entren 3 por fila (hasta 5 colores cada una) en pantallas angostas.
const MANA_SIZE_XS = 14;

function ManaSymbol({ color, size = MANA_SIZE_LG }: { color: string; size?: number }) {
  const src = MANA_IMAGES[color as MtgColor];
  if (src) {
    return (
      <Image source={src} style={{ width: size, height: size }} resizeMode="contain" />
    );
  }
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#9CA3AF' }} />;
}

// ── Tipos locales ─────────────────────────────────────────────────────────────

type AggStats = {
  pairings_won: number;
  pairings_lost: number;
  total_matches_won: number;
  total_matches_lost: number;
};

type ColorStat = {
  color: string;
  times_played: number;
  percentage: number;
  /** Partidas individuales oficiales jugadas con el color y % ganado (un decimal); la vista excluye venganzas, 2HG y sandbox. */
  games_played: number;
  game_winrate: number | null;
};

type EventEntry = {
  event_id: string;
  participant_id: string;
  event_name: string;
  placement: number;
  total_players: number;
  colors: MtgColor[];
  /** Copa sola / Grupos + Copa: instancia alcanzada ("Campeón Copa Quito"...); null en los demás formatos. */
  reached: string | null;
  /** Draft ya terminado pero con los enfrentamientos en curso (status 'playing'): todavía no hay posición final ("Inc"). */
  inProgress: boolean;
};

type H2HEntry = {
  opponent_user_id: string;
  opponent_name: string;
  total_pairings: number;
  pairings_won: number;
  pairings_lost: number;
  draft_matches_won: number;
  draft_matches_lost: number;
  revenge_matches_won: number;
  revenge_matches_lost: number;
  total_matches_won: number;
  total_matches_lost: number;
};

type Streaks = {
  longest_win_streak: number;
  longest_loss_streak: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(won: number, lost: number): number | null {
  const total = won + lost;
  return total > 0 ? Math.round((won / total) * 100) : null;
}

function CellStat({ won, lost }: { won: number; lost: number }) {
  const styles = useThemedStyles(createStyles);
  const p = pct(won, lost);
  return (
    <View style={styles.h2hCell}>
      <Text style={styles.h2hCellRecord}>{won}G-{lost}P</Text>
      {p !== null && <Text style={styles.h2hCellPct}>{p}%</Text>}
    </View>
  );
}

/**
 * Copa sola y Grupos + Copa: instancia alcanzada de la persona en cada evento Copa del historial. Consultas en lote
 * (una por tabla para todos los eventos Copa), no una por fila. Devuelve event_id -> texto; los demás eventos no figuran.
 */
async function loadCupReachedTexts(
  userId: string,
  entries: { event_id: string; participant_id: string }[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const eventIds = Array.from(new Set(entries.map((e) => e.event_id)));
  if (eventIds.length === 0) return out;
  const evRes = await supabase.from('draft_events').select('id, competition_format, venue_id').in('id', eventIds);
  const cupEvents = ((evRes.data ?? []) as { id: string; competition_format: string; venue_id: string | null }[]).filter(
    (e) => e.competition_format === 'knockout' || e.competition_format === 'zones_knockout'
  );
  if (cupEvents.length === 0) return out;
  const cupEventIds = cupEvents.map((e) => e.id);
  const venueIds = Array.from(new Set(cupEvents.map((e) => e.venue_id).filter((v): v is string => !!v)));
  const [venuesRes, groupsRes, userRes] = await Promise.all([
    venueIds.length > 0 ? supabase.from('venues').select('id, name').in('id', venueIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    supabase
      .from('event_tiebreak_groups')
      .select('id, event_id, group_origin')
      .in('event_id', cupEventIds)
      .in('group_origin', ['knockout_bracket', 'knockout_second_chance'])
      .in('status', ['active', 'resolved', 'failed']),
    supabase.from('users').select('gender').eq('id', userId).maybeSingle(),
  ]);
  const groups = (groupsRes.data ?? []) as { id: string; event_id: string; group_origin: string }[];
  const slotsRes =
    groups.length > 0
      ? await supabase
          .from('knockout_slots')
          .select('group_id, round_key, participant_a_id, participant_b_id, is_bye, winner_participant_id')
          .in('group_id', groups.map((g) => g.id))
      : { data: [] as never[] };
  const slotsByGroup = new Map<string, CupSlotInput[]>();
  for (const s of (slotsRes.data ?? []) as (CupSlotInput & { group_id: string })[]) {
    if (!slotsByGroup.has(s.group_id)) slotsByGroup.set(s.group_id, []);
    slotsByGroup.get(s.group_id)!.push(s);
  }
  const groupsByEvent = new Map<string, CupGroupInput[]>();
  for (const g of groups) {
    if (!groupsByEvent.has(g.event_id)) groupsByEvent.set(g.event_id, []);
    groupsByEvent.get(g.event_id)!.push({ origin: g.group_origin, slots: slotsByGroup.get(g.id) ?? [] });
  }
  const venueName = new Map(((venuesRes.data ?? []) as { id: string; name: string }[]).map((v) => [v.id, v.name]));
  const gender = ((userRes.data as { gender?: Gender | null } | null)?.gender ?? null) as Gender | null;
  const eventById = new Map(cupEvents.map((e) => [e.id, e]));
  for (const entry of entries) {
    const ev = eventById.get(entry.event_id);
    if (!ev) continue;
    const reached = cupReachedInstance({
      participantId: entry.participant_id,
      groups: groupsByEvent.get(ev.id) ?? [],
      isZones: ev.competition_format === 'zones_knockout',
    });
    if (!reached) continue;
    out.set(
      entry.event_id,
      cupReachedText(reached, {
        mainName: cupPrimaName(ev.venue_id ? venueName.get(ev.venue_id) : null),
        consueloName: CUP_CONSUELO_NAME,
        gendered: (m, fe) => resolveGenderedText(gender, m, fe),
      })
    );
  }
  return out;
}

/**
 * Combinaciones de colores del jugador en el workspace: una sola lectura de v_player_color_combo_stats (la vista ya deja
 * afuera venganzas, Gigantes de Dos Cabezas y eventos de prueba, e incluye top cut y desempates). Si falla, vacío.
 * El orden y la elección de las 3 mejores están en lib/colorCombos.ts.
 */
type ComboResult = { mostUsed: ColorCombo[]; bestWinrate: ColorCombo[] };
const NO_COMBOS: ComboResult = { mostUsed: [], bestWinrate: [] };

async function loadColorCombos(userId: string, workspaceId: string): Promise<ComboResult> {
  try {
    const res = await supabase
      .from('v_player_color_combo_stats')
      .select('combo, decks_count, games_played, games_won')
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId);
    if (res.error) return NO_COMBOS;
    return pickColorCombos((res.data ?? []) as ComboViewRow[]);
  } catch {
    return NO_COMBOS;
  }
}

/** Fila de hasta 3 combinaciones, una al lado de la otra; los huecos se rellenan para que el ancho de cada una no cambie. */
function ComboRow({ items, mode }: { items: ColorCombo[]; mode: 'used' | 'winrate' }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.comboRow}>
      {[0, 1, 2].map((i) => {
        const c = items[i];
        if (!c) return <View key={i} style={styles.comboItem} />;
        return (
          <View key={c.key} style={styles.comboItem}>
            <View style={styles.comboIcons}>
              {c.colors.map((col, j) => (
                <ManaSymbol key={`${col}-${j}`} color={col} size={MANA_SIZE_XS} />
              ))}
            </View>
            {mode === 'used' ? (
              <Text style={styles.comboValue}>{c.decks} {c.decks === 1 ? 'vez' : 'veces'}</Text>
            ) : (
              <>
                <Text style={[styles.comboValue, styles.comboWr]}>{c.winrate}%</Text>
                <Text style={styles.comboSub}>{c.played} part.</Text>
              </>
            )}
          </View>
        );
      })}
    </View>
  );
}

// ── Componente ────────────────────────────────────────────────────────────────

type Props = {
  userId: string;
  workspaceId: string;
};

export default function CrossEventStats({ userId, workspaceId }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [loading, setLoading] = useState(true);
  const [aggStats, setAggStats] = useState<AggStats | null>(null);
  const [colorStats, setColorStats] = useState<ColorStat[]>([]);
  const [history, setHistory] = useState<EventEntry[]>([]);
  const [h2h, setH2H] = useState<H2HEntry[]>([]);
  const [streaks, setStreaks] = useState<Streaks | null>(null);
  const [combos, setCombos] = useState<ComboResult>(NO_COMBOS);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [statsRes, colorsRes, historyRes, h2hRes, streaksRes, combosRes] = await Promise.all([
        supabase
          .from('v_player_workspace_stats')
          .select('pairings_won, pairings_lost, total_matches_won, total_matches_lost')
          .eq('user_id', userId)
          .eq('workspace_id', workspaceId)
          .maybeSingle(),
        supabase
          .from('v_player_color_stats')
          .select('color, times_played, percentage, games_played, game_winrate')
          .eq('user_id', userId)
          .eq('workspace_id', workspaceId)
          .order('times_played', { ascending: false }),
        supabase
          .from('v_participant_event_placement')
          .select('event_id, participant_id, event_name, placement, total_players, event_status')
          .eq('user_id', userId)
          .eq('workspace_id', workspaceId)
          // 'playing' = el draft ya terminó (draft_ended_at) y se está en los enfrentamientos, sin posición final; 'completed' y
          // 'concluded' (dado por concluido) = terminados, con posiciones finales. Quedan afuera 'scheduled' (no empezó),
          // 'drafting' (todavía drafteando), 'cancelled' y, en la vista, los borrados.
          .in('event_status', ['playing', 'completed', 'concluded'])
          .order('scheduled_for', { ascending: false })
          .limit(3),
        supabase
          .from('v_head_to_head_stats')
          .select('opponent_user_id, total_pairings, pairings_won, pairings_lost, draft_matches_won, draft_matches_lost, revenge_matches_won, revenge_matches_lost, total_matches_won, total_matches_lost')
          .eq('user_id', userId)
          .eq('workspace_id', workspaceId)
          .order('total_pairings', { ascending: false }),
        supabase
          .from('v_player_streaks')
          .select('longest_win_streak, longest_loss_streak')
          .eq('user_id', userId)
          .eq('workspace_id', workspaceId)
          .maybeSingle(),
        loadColorCombos(userId, workspaceId),
      ]);

      if (cancelled) return;

      // Colores por evento (para historial)
      const rawHistory = (historyRes.data ?? []) as Array<{
        event_id: string; participant_id: string; event_name: string;
        placement: number; total_players: number; event_status: string;
      }>;
      const participantIds = rawHistory.map(e => e.participant_id);
      const eventIds = Array.from(new Set(rawHistory.map(e => e.event_id)));

      const [colorsRowsRes, podiumsByEvent, cupReachedByEvent] = await Promise.all([
        participantIds.length > 0
          ? supabase.from('participant_colors').select('participant_id, color').in('participant_id', participantIds)
          : Promise.resolve({ data: [] as { participant_id: string; color: string }[], error: null }),
        // 1°/2°/3° salen del podio real del evento (eventPodium.ts, la misma fuente que
        // StandingsScreen y el cierre de temporada) en vez del rank por winrate de fase regular
        // que usa v_participant_event_placement — ese rank ignora el bracket de top4, así que a
        // veces "premia" a alguien de la liga que después perdió el mata-mata. El resto del campo
        // (4° en adelante) sigue con el placement de la vista, sin tocar: eventPodium solo calcula
        // podio (1-3), no un ranking completo.
        eventIds.length > 0 ? fetchEventPodiums(eventIds) : Promise.resolve(new Map<string, EventPodiumResult>()),
        loadCupReachedTexts(userId, rawHistory),
      ]);

      let colorsByPart: Record<string, MtgColor[]> = {};
      if (!cancelled) {
        (colorsRowsRes.data ?? []).forEach((r: { participant_id: string; color: string }) => {
          if (!colorsByPart[r.participant_id]) colorsByPart[r.participant_id] = [];
          colorsByPart[r.participant_id].push(r.color as MtgColor);
        });
      }

      // Nombres de oponentes (para H2H)
      const rawH2H = (h2hRes.data ?? []) as Array<{
        opponent_user_id: string; total_pairings: number;
        pairings_won: number; pairings_lost: number;
        draft_matches_won: number; draft_matches_lost: number;
        revenge_matches_won: number; revenge_matches_lost: number;
        total_matches_won: number; total_matches_lost: number;
      }>;
      const opponentIds = rawH2H.map(h => h.opponent_user_id);
      let opponentNames: Record<string, string> = {};
      if (opponentIds.length > 0) {
        const { data: uRows } = await supabase
          .from('users')
          .select('id, display_name, username')
          .in('id', opponentIds);
        if (!cancelled) {
          (uRows ?? []).forEach((u: { id: string; display_name?: string; username?: string }) => {
            opponentNames[u.id] = u.display_name || u.username || 'Jugador';
          });
        }
      }

      if (cancelled) return;

      setAggStats((statsRes.data as AggStats | null) ?? null);
      setColorStats((colorsRes.data as ColorStat[] | null) ?? []);
      setHistory(rawHistory.map(e => {
        const podiumStep = podiumsByEvent.get(e.event_id)?.podium.steps.find(
          (s) => s.players.some((p) => p.userId === userId)
        );
        return {
          ...e,
          placement: podiumStep?.rank ?? e.placement,
          colors: colorsByPart[e.participant_id] ?? [],
          reached: cupReachedByEvent.get(e.event_id) ?? null,
          inProgress: e.event_status === 'playing',
        };
      }));
      setH2H(rawH2H.map(h => ({ ...h, opponent_name: opponentNames[h.opponent_user_id] ?? 'Jugador' })));
      setStreaks((streaksRes.data as Streaks | null) ?? null);
      setCombos(combosRes);
      setLoading(false);
    }

    void load();
    return () => { cancelled = true; };
  }, [userId, workspaceId]);

  if (loading) {
    return (
      <View style={styles.loadingBox}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const totalPairings = (aggStats?.pairings_won ?? 0) + (aggStats?.pairings_lost ?? 0);
  const pairingWinPct = totalPairings > 0
    ? Math.round((aggStats!.pairings_won / totalPairings) * 100) : null;
  const totalMatches = (aggStats?.total_matches_won ?? 0) + (aggStats?.total_matches_lost ?? 0);
  const matchWinPct = totalMatches > 0
    ? Math.round((aggStats!.total_matches_won / totalMatches) * 100) : null;

  // Colores ordenados por WR% para la sección Win Rate
  const colorsByWr = [...colorStats]
    .filter(c => c.games_played > 0 && c.game_winrate !== null)
    .sort((a, b) => (b.game_winrate ?? 0) - (a.game_winrate ?? 0));

  return (
    <>
      {/* ── Estadísticas ───────────────────────────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Estadísticas</Text>
        {totalPairings > 0 || totalMatches > 0 ? (
          <>
            <View style={styles.statRow}>
              <Text style={styles.statLabel}>Enfrentamientos</Text>
              <Text style={styles.statValue}>
                {aggStats!.pairings_won}G – {aggStats!.pairings_lost}P
                {pairingWinPct !== null ? `  (${pairingWinPct}%)` : ''}
              </Text>
            </View>
            <View style={styles.statRow}>
              <Text style={styles.statLabel}>Partidas totales</Text>
              <Text style={styles.statValue}>
                {aggStats!.total_matches_won}G – {aggStats!.total_matches_lost}P
                {matchWinPct !== null ? `  (${matchWinPct}%)` : ''}
              </Text>
            </View>
          </>
        ) : (
          <Text style={styles.emptyText}>Sin partidas registradas</Text>
        )}
      </View>

      {/* ── Colores jugados ────────────────────────────────────────────── */}
      {colorStats.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Colores jugados</Text>
          <View style={styles.colorsRow}>
            {colorStats.map(c => (
              <View key={c.color} style={styles.colorItem}>
                <ManaSymbol color={c.color} size={MANA_SIZE_LG} />
                <Text style={styles.colorLabel}>{c.color}</Text>
                <Text style={styles.colorPct}>{c.percentage}%</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* ── Win Rate por color ─────────────────────────────────────────── */}
      {colorsByWr.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Win Rate</Text>
          <View style={styles.colorsRow}>
            {colorsByWr.map(c => (
              <View key={c.color} style={styles.colorItem}>
                <ManaSymbol color={c.color} size={MANA_SIZE_LG} />
                <Text style={styles.colorLabel}>{c.color}</Text>
                <Text style={styles.colorWr}>{c.game_winrate}%</Text>
                <Text style={styles.colorPct}>{c.games_played} part.</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* ── Combinaciones de colores ───────────────────────────────────── */}
      {combos.mostUsed.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Combinación de colores más usada</Text>
          <ComboRow items={combos.mostUsed} mode="used" />
        </View>
      )}
      {combos.bestWinrate.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Combinación de colores con más winrate</Text>
          <ComboRow items={combos.bestWinrate} mode="winrate" />
        </View>
      )}

      {/* ── Últimos 3 draft ────────────────────────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Últimos 3 draft</Text>
        {history.length > 0 ? (
          history.map(e => (
            <View key={e.event_id} style={styles.historyRow}>
              <View style={styles.historyLeft}>
                <Text style={styles.historyName} numberOfLines={1}>{e.event_name}</Text>
                {e.colors.length > 0 && (
                  <View style={styles.historyColors}>
                    {e.colors.map((c, i) => (
                      <ManaSymbol key={`${c}-${i}`} color={c} size={MANA_SIZE_SM} />
                    ))}
                  </View>
                )}
              </View>
              <Text style={styles.historyPlacement}>{e.inProgress ? 'Inc' : e.reached ?? `${e.placement}° de ${e.total_players}`}</Text>
            </View>
          ))
        ) : (
          <Text style={styles.emptyText}>Sin drafts completados</Text>
        )}
      </View>

      {/* ── Historial vs rivales ───────────────────────────────────────── */}
      {h2h.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Historial vs rivales</Text>

          {/* Cabecera de tabla */}
          <View style={styles.h2hHeaderRow}>
            <View style={styles.h2hPlayerCol} />
            {/* Oficiales: agrupa Bo3 + MaM */}
            <View style={styles.h2hDraftHeaderGroup}>
              <Text style={styles.h2hGroupLabel}>Oficiales</Text>
              <View style={styles.h2hGroupSubs}>
                <Text style={styles.h2hColSub}>Bo3</Text>
                <Text style={styles.h2hColSub}>MaM</Text>
              </View>
            </View>
            <View style={styles.h2hSingleCol}>
              <Text style={styles.h2hGroupLabel}>Veng.</Text>
              <Text style={styles.h2hColSub}>MaM</Text>
            </View>
            <View style={styles.h2hSingleCol}>
              <Text style={styles.h2hGroupLabel}>Total</Text>
              <Text style={styles.h2hColSub}>MaM</Text>
            </View>
          </View>

          {/* Filas por rival */}
          {h2h.map(h => (
            <View key={h.opponent_user_id} style={styles.h2hRow}>
              <View style={styles.h2hPlayerCol}>
                <PlayerAvatar
                  userId={h.opponent_user_id}
                  size="small"
                  withColorBorder={false}
                  outsideEvent
                  style={styles.h2hAvatar}
                />
                <Text style={styles.h2hName} numberOfLines={1}>{h.opponent_name}</Text>
              </View>
              {/* Oficiales: Bo3 y MaM side by side */}
              <View style={styles.h2hDraftGroup}>
                <CellStat won={h.pairings_won}      lost={h.pairings_lost}      />
                <CellStat won={h.draft_matches_won} lost={h.draft_matches_lost} />
              </View>
              {/* Venganza */}
              <View style={styles.h2hSingleCol}>
                <CellStat won={h.revenge_matches_won} lost={h.revenge_matches_lost} />
              </View>
              {/* Total MaM */}
              <View style={styles.h2hSingleCol}>
                <CellStat won={h.total_matches_won} lost={h.total_matches_lost} />
              </View>
            </View>
          ))}
        </View>
      )}

      {/* ── Rachas ─────────────────────────────────────────────────────── */}
      {streaks && (streaks.longest_win_streak > 0 || streaks.longest_loss_streak > 0) && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Rachas</Text>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Mayor racha de victorias</Text>
            <Text style={styles.statValue}>{streaks.longest_win_streak}</Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Mayor racha de derrotas</Text>
            <Text style={styles.statValue}>{streaks.longest_loss_streak}</Text>
          </View>
        </View>
      )}

      {/* ── Pokemones ──────────────────────────────────────────────────── */}
      <PokemonReceivedSection userId={userId} workspaceId={workspaceId} />
    </>
  );
}

const H2H_DRAFT_W = 104; // ancho total del grupo Oficiales (2 × 52)
const H2H_SUB_W   = 52;  // ancho de cada subcolumna dentro de Draft
const H2H_SINGLE_W = 56; // ancho de Venganza y Total

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    loadingBox: { paddingVertical: 32, alignItems: 'center' },
    section: { marginTop: 24 },
    sectionTitle: {
      fontSize: 12,
      fontWeight: '600',
      color: c.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      marginBottom: 12,
    },
    statRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    statLabel: { fontSize: 15, color: c.textBody },
    statValue: { fontSize: 15, fontWeight: '600', color: c.text },
    emptyText: { fontSize: 14, color: c.textMuted, fontStyle: 'italic' },

    // Colores
    colorsRow: { flexDirection: 'row', gap: 16, flexWrap: 'wrap' },
    colorItem: { alignItems: 'center', gap: 4 },
    colorLabel: { fontSize: 12, fontWeight: '700', color: c.textBody },
    colorPct: { fontSize: 11, color: c.textSecondary },
    colorWr:  { fontSize: 11, fontWeight: '700', color: c.accent },

    // Combinaciones de colores (3 por fila)
    comboRow: { flexDirection: 'row', gap: 8 },
    comboItem: { flex: 1, minWidth: 0, alignItems: 'center', gap: 4 },
    comboIcons: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 1 },
    comboValue: { fontSize: 12, fontWeight: '600', color: c.text, textAlign: 'center' },
    comboWr: { color: c.accent, fontWeight: '700' },
    comboSub: { fontSize: 11, color: c.textSecondary, textAlign: 'center' },

    // Historial drafts
    historyRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    historyLeft: { flex: 1, marginRight: 8 },
    historyName: { fontSize: 15, color: c.textBody, marginBottom: 4 },
    historyColors: { flexDirection: 'row', gap: 4 },
    historyPlacement: { fontSize: 15, fontWeight: '700', color: c.text, flexShrink: 1, maxWidth: '55%', textAlign: 'right' },

    // H2H tabla
    h2hHeaderRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      paddingBottom: 6,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    h2hRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    h2hPlayerCol: { flex: 1, flexDirection: 'row', alignItems: 'center' },
    h2hAvatar: { marginRight: 6 },
    h2hName: { flex: 1, fontSize: 13, color: c.text, fontWeight: '500' },

    // Grupo Oficiales (Bo3 + MaM)
    h2hDraftHeaderGroup: {
      width: H2H_DRAFT_W,
      alignItems: 'center',
    },
    h2hDraftGroup: {
      width: H2H_DRAFT_W,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
    },
    h2hGroupLabel: {
      fontSize: 11,
      fontWeight: '600',
      color: c.textSecondary,
      textAlign: 'center',
    },
    h2hGroupSubs: { flexDirection: 'row', width: H2H_DRAFT_W },
    h2hColSub: {
      width: H2H_SUB_W,
      fontSize: 10,
      color: c.textMuted,
      textAlign: 'center',
    },

    // Columna simple (Venganza, Total)
    h2hSingleCol: { width: H2H_SINGLE_W, alignItems: 'center' },

    // Celda de dato
    h2hCell: { width: H2H_SUB_W, alignItems: 'center' },
    h2hCellRecord: { fontSize: 11, fontWeight: '600', color: c.text, textAlign: 'center' },
    h2hCellPct:    { fontSize: 10, color: c.textSecondary, textAlign: 'center' },
  });

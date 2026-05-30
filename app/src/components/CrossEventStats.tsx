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
  pairings_played: number;
  bo3_winrate: number | null;
};

type EventEntry = {
  event_id: string;
  participant_id: string;
  event_name: string;
  placement: number;
  total_players: number;
  colors: MtgColor[];
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
  const p = pct(won, lost);
  return (
    <View style={styles.h2hCell}>
      <Text style={styles.h2hCellRecord}>{won}G-{lost}P</Text>
      {p !== null && <Text style={styles.h2hCellPct}>{p}%</Text>}
    </View>
  );
}

// ── Componente ────────────────────────────────────────────────────────────────

type Props = {
  userId: string;
  workspaceId: string;
};

export default function CrossEventStats({ userId, workspaceId }: Props) {
  const [loading, setLoading] = useState(true);
  const [aggStats, setAggStats] = useState<AggStats | null>(null);
  const [colorStats, setColorStats] = useState<ColorStat[]>([]);
  const [history, setHistory] = useState<EventEntry[]>([]);
  const [h2h, setH2H] = useState<H2HEntry[]>([]);
  const [streaks, setStreaks] = useState<Streaks | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [statsRes, colorsRes, historyRes, h2hRes, streaksRes] = await Promise.all([
        supabase
          .from('v_player_workspace_stats')
          .select('pairings_won, pairings_lost, total_matches_won, total_matches_lost')
          .eq('user_id', userId)
          .eq('workspace_id', workspaceId)
          .maybeSingle(),
        supabase
          .from('v_player_color_stats')
          .select('color, times_played, percentage, pairings_played, bo3_winrate')
          .eq('user_id', userId)
          .eq('workspace_id', workspaceId)
          .order('times_played', { ascending: false }),
        supabase
          .from('v_participant_event_placement')
          .select('event_id, participant_id, event_name, placement, total_players')
          .eq('user_id', userId)
          .eq('workspace_id', workspaceId)
          .eq('event_status', 'completed')
          .order('scheduled_for', { ascending: false })
          .limit(10),
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
      ]);

      if (cancelled) return;

      // Colores por evento (para historial)
      const rawHistory = (historyRes.data ?? []) as Array<{
        event_id: string; participant_id: string; event_name: string;
        placement: number; total_players: number;
      }>;
      const participantIds = rawHistory.map(e => e.participant_id);
      let colorsByPart: Record<string, MtgColor[]> = {};
      if (participantIds.length > 0) {
        const { data: cRows } = await supabase
          .from('participant_colors')
          .select('participant_id, color')
          .in('participant_id', participantIds);
        if (!cancelled) {
          (cRows ?? []).forEach((r: { participant_id: string; color: string }) => {
            if (!colorsByPart[r.participant_id]) colorsByPart[r.participant_id] = [];
            colorsByPart[r.participant_id].push(r.color as MtgColor);
          });
        }
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
      setHistory(rawHistory.map(e => ({ ...e, colors: colorsByPart[e.participant_id] ?? [] })));
      setH2H(rawH2H.map(h => ({ ...h, opponent_name: opponentNames[h.opponent_user_id] ?? 'Jugador' })));
      setStreaks((streaksRes.data as Streaks | null) ?? null);
      setLoading(false);
    }

    void load();
    return () => { cancelled = true; };
  }, [userId, workspaceId]);

  if (loading) {
    return (
      <View style={styles.loadingBox}>
        <ActivityIndicator color="#3B82F6" />
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
    .filter(c => c.pairings_played > 0 && c.bo3_winrate !== null)
    .sort((a, b) => (b.bo3_winrate ?? 0) - (a.bo3_winrate ?? 0));

  return (
    <>
      {/* ── Estadísticas ───────────────────────────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Estadísticas</Text>
        {totalPairings > 0 || totalMatches > 0 ? (
          <>
            <View style={styles.statRow}>
              <Text style={styles.statLabel}>Partidas Bo3</Text>
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
                <Text style={styles.colorWr}>{c.bo3_winrate}%</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* ── Historial de drafts ────────────────────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Historial de drafts</Text>
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
              <Text style={styles.historyPlacement}>{e.placement}° de {e.total_players}</Text>
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
    </>
  );
}

const H2H_DRAFT_W = 104; // ancho total del grupo Oficiales (2 × 52)
const H2H_SUB_W   = 52;  // ancho de cada subcolumna dentro de Draft
const H2H_SINGLE_W = 56; // ancho de Venganza y Total

const styles = StyleSheet.create({
  loadingBox: { paddingVertical: 32, alignItems: 'center' },
  section: { marginTop: 24 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
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
    borderBottomColor: '#E5E7EB',
  },
  statLabel: { fontSize: 15, color: '#374151' },
  statValue: { fontSize: 15, fontWeight: '600', color: '#111' },
  emptyText: { fontSize: 14, color: '#9CA3AF', fontStyle: 'italic' },

  // Colores
  colorsRow: { flexDirection: 'row', gap: 16, flexWrap: 'wrap' },
  colorItem: { alignItems: 'center', gap: 4 },
  colorLabel: { fontSize: 12, fontWeight: '700', color: '#374151' },
  colorPct: { fontSize: 11, color: '#6B7280' },
  colorWr:  { fontSize: 11, fontWeight: '700', color: '#3B82F6' },

  // Historial drafts
  historyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  historyLeft: { flex: 1, marginRight: 8 },
  historyName: { fontSize: 15, color: '#374151', marginBottom: 4 },
  historyColors: { flexDirection: 'row', gap: 4 },
  historyPlacement: { fontSize: 15, fontWeight: '700', color: '#111' },

  // H2H tabla
  h2hHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  h2hRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  h2hPlayerCol: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  h2hAvatar: { marginRight: 6 },
  h2hName: { flex: 1, fontSize: 13, color: '#111', fontWeight: '500' },

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
    color: '#6B7280',
    textAlign: 'center',
  },
  h2hGroupSubs: { flexDirection: 'row', width: H2H_DRAFT_W },
  h2hColSub: {
    width: H2H_SUB_W,
    fontSize: 10,
    color: '#9CA3AF',
    textAlign: 'center',
  },

  // Columna simple (Venganza, Total)
  h2hSingleCol: { width: H2H_SINGLE_W, alignItems: 'center' },

  // Celda de dato
  h2hCell: { width: H2H_SUB_W, alignItems: 'center' },
  h2hCellRecord: { fontSize: 11, fontWeight: '600', color: '#111', textAlign: 'center' },
  h2hCellPct:    { fontSize: 10, color: '#6B7280', textAlign: 'center' },
});

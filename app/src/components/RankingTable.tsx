import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import PlayerAvatar from './PlayerAvatar';
import ProDeCManaC from './ProDeCManaC';
import { formatPointsPerEvent, type RankingRow } from '../lib/ranking';
import { useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';

/** Anchos de columna. Las columnas de la tabla y el espaciador del indicador de ProDeC salen de acá. */
const COL = { pos: 26, name: 140, stat: 44, pct: 50, ratio: 52 } as const;

/**
 * Ancho de todo lo que va ANTES del grupo ProDeC: # + Jugador + 8 columnas "stat"
 * (Pts, #PE, 🥇, 🥈, 🥉, EJ, PJ, VJ) + 1 columna "ratio" (Pts/PE) + 3 columnas "pct" (WRE, WRP,
 * WRV). Si se agrega o quita una columna principal, actualizar este cálculo.
 */
const MAIN_COLUMNS_WIDTH = COL.pos + COL.name + 8 * COL.stat + COL.ratio + 3 * COL.pct;

/** El grupo ProDeC: 4 columnas "stat" (Pts, 🥇, 🥈, 🥉) + 1 "ratio" (Pts/PE). */
const PRODEC_COLUMNS_WIDTH = 4 * COL.stat + COL.ratio;

type Props = {
  rows: RankingRow[];
  emptyText: string;
  legendText: string;
  onPressRow: (row: RankingRow) => void;
  /** Contenido arriba de la tabla (p. ej. encabezado de la temporada). */
  header?: React.ReactNode;
};

export default function RankingTable({ rows, emptyText, legendText, onPressRow, header }: Props) {
  const styles = useThemedStyles(createStyles);
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll} horizontal={false}>
      {header}
      <ScrollView horizontal contentContainerStyle={styles.tableWrap}>
        <View>
          <View style={styles.groupRow}>
            <View style={{ width: MAIN_COLUMNS_WIDTH }} />
            <View style={{ width: PRODEC_COLUMNS_WIDTH }}>
              <View style={styles.prodecLabelRow}>
                <Text style={styles.prodecLabel}>ProDe</Text>
                <ProDeCManaC size={20} />
              </View>
              <View style={styles.prodecLine} />
            </View>
          </View>
          <View style={styles.headerRow}>
            <Text style={[styles.cell, styles.posCol, styles.headerTxt]}>#</Text>
            <Text style={[styles.cell, styles.nameCol, styles.headerTxt, styles.leftAlign]}>Jugador</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt]}>Pts</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt]}>#PE</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt]}>🥇</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt]}>🥈</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt]}>🥉</Text>
            <Text style={[styles.cell, styles.ratioCol, styles.headerTxt]}>Pts/PE</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt]}>EJ</Text>
            <Text style={[styles.cell, styles.pctCol, styles.headerTxt]}>WRE</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt]}>PJ</Text>
            <Text style={[styles.cell, styles.pctCol, styles.headerTxt]}>WRP</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt]}>VJ</Text>
            <Text style={[styles.cell, styles.pctCol, styles.headerTxt]}>WRV</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt, styles.prodecFirstCol]}>Pts</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt]}>🥇</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt]}>🥈</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt]}>🥉</Text>
            <Text style={[styles.cell, styles.ratioCol, styles.headerTxt]}>Pts/PE</Text>
          </View>
          {rows.length === 0 ? (
            <Text style={styles.emptyText}>{emptyText}</Text>
          ) : (
            rows.map((r, idx) => (
              <TouchableOpacity key={r.userId} style={styles.row} activeOpacity={0.7} onPress={() => onPressRow(r)}>
                <Text style={[styles.cell, styles.posCol]}>{idx + 1}</Text>
                <View style={[styles.nameCol, styles.nameCell]}>
                  <PlayerAvatar userId={r.userId} size="tiny" withColorBorder={false} outsideEvent style={styles.avatar} />
                  <Text style={styles.nameTxt} numberOfLines={1}>
                    {r.name}
                  </Text>
                </View>
                <Text style={[styles.cell, styles.statCol, styles.pointsTxt]}>{r.points}</Text>
                <Text style={[styles.cell, styles.statCol]}>{r.completedEvents}</Text>
                <Text style={[styles.cell, styles.statCol, styles.goldTxt]}>{r.championships}</Text>
                <Text style={[styles.cell, styles.statCol, styles.silverTxt]}>{r.secondPlaces}</Text>
                <Text style={[styles.cell, styles.statCol, styles.bronzeTxt]}>{r.thirdPlaces}</Text>
                <Text style={[styles.cell, styles.ratioCol]}>{formatPointsPerEvent(r.points, r.completedEvents)}</Text>
                <Text style={[styles.cell, styles.statCol]}>{r.ej}</Text>
                <Text style={[styles.cell, styles.pctCol]}>{r.wre != null ? `${r.wre}%` : '-'}</Text>
                <Text style={[styles.cell, styles.statCol]}>{r.pj}</Text>
                <Text style={[styles.cell, styles.pctCol]}>{r.wrp != null ? `${r.wrp}%` : '-'}</Text>
                <Text style={[styles.cell, styles.statCol]}>{r.vj}</Text>
                <Text style={[styles.cell, styles.pctCol]}>{r.wrv != null ? `${r.wrv}%` : '-'}</Text>
                <Text style={[styles.cell, styles.statCol, styles.pointsTxt, styles.prodecFirstCol]}>{r.prodecPoints}</Text>
                <Text style={[styles.cell, styles.statCol, styles.goldTxt]}>{r.prodecFirst}</Text>
                <Text style={[styles.cell, styles.statCol, styles.silverTxt]}>{r.prodecSecond}</Text>
                <Text style={[styles.cell, styles.statCol, styles.bronzeTxt]}>{r.prodecThird}</Text>
                <Text style={[styles.cell, styles.ratioCol]}>{formatPointsPerEvent(r.prodecPoints, r.completedEvents)}</Text>
              </TouchableOpacity>
            ))
          )}
        </View>
      </ScrollView>
      <Text style={styles.legendTxt}>{legendText}</Text>
    </ScrollView>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    scroll: { padding: 16, paddingBottom: 40 },
    tableWrap: { paddingBottom: 8 },
    groupRow: { flexDirection: 'row', marginBottom: 2 },
    prodecLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
    prodecLabel: { fontSize: 13, fontWeight: '800', color: c.text },
    prodecLine: { height: 2, backgroundColor: c.textMuted, borderRadius: 1 },
    headerRow: {
      flexDirection: 'row',
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      paddingBottom: 8,
      marginBottom: 4,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.divider,
    },
    cell: { textAlign: 'center', color: c.text, fontWeight: '600', fontSize: 12 },
    headerTxt: { fontWeight: '700', color: c.textSecondary, fontSize: 11, textTransform: 'uppercase' },
    leftAlign: { textAlign: 'left' },
    posCol: { width: COL.pos, minWidth: COL.pos },
    nameCol: { width: COL.name, minWidth: COL.name },
    nameCell: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    avatar: { marginRight: 2 },
    nameTxt: { fontSize: 13, fontWeight: '600', color: c.text, flexShrink: 1 },
    statCol: { width: COL.stat, minWidth: COL.stat },
    pctCol: { width: COL.pct, minWidth: COL.pct, fontSize: 11 },
    ratioCol: { width: COL.ratio, minWidth: COL.ratio },
    /** Separador vertical fino al inicio del grupo ProDeC (el ancho de la columna no cambia: border-box). */
    prodecFirstCol: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: c.borderStrong },
    pointsTxt: { color: c.accent, fontWeight: '700' },
    // Medallas oro/plata/bronce: colores de contenido, iguales en ambos modos.
    goldTxt: { color: '#CA8A04' },
    silverTxt: { color: '#9CA3AF' },
    bronzeTxt: { color: '#B45309' },
    emptyText: { fontSize: 14, color: c.textMuted, fontStyle: 'italic', paddingVertical: 24 },
    legendTxt: { marginTop: 14, color: c.textSecondary, fontSize: 12, lineHeight: 17 },
  });

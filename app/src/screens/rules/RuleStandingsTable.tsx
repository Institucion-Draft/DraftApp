import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export type RuleStandingsRow = {
  id: string;
  name: string;
  /** Modo 'winrate': partidos jugados/ganados. */
  pj?: number;
  pg?: number;
  /** Modo 'points': ganadas/empatadas/perdidas y puntos. */
  pe?: number;
  pp?: number;
  pts?: number;
  /** Resalta la fila (fondo amarillo, mismo tono que "disputa el 4to puesto" en Standings). */
  highlight?: boolean;
  /**
   * Posición a mostrar en la columna '#'. Por default es el índice+1 (orden de la fila en el
   * array) — pero cuando dos filas comparten posición real (empate sin resolver todavía), pasar
   * el mismo número explícito en ambas para que la tabla lo refleje.
   */
  rank?: number;
};

type Props = {
  mode: 'winrate' | 'points';
  rows: RuleStandingsRow[];
  /**
   * Etiquetas de las columnas "ganados"/"total" en modo 'winrate'. Default PG/PJ (partidos
   * ganados/jugados, BO1). Para BO3 pasar { won: 'EG', total: 'EC' } (enfrentamientos
   * ganados/completados) — mismo cálculo, otro nombre de unidad.
   */
  winrateLabels?: { won: string; total: string };
};

export default function RuleStandingsTable({ mode, rows, winrateLabels }: Props) {
  const wonLabel = winrateLabels?.won ?? 'PG';
  const totalLabel = winrateLabels?.total ?? 'PJ';
  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={[styles.cell, styles.posCol]}>#</Text>
        <Text style={[styles.cell, styles.nameCol, styles.leftAlign]}>Jugador</Text>
        {mode === 'winrate' ? (
          <>
            <Text style={[styles.cell, styles.statCol]}>{wonLabel}</Text>
            <Text style={[styles.cell, styles.statCol]}>{totalLabel}</Text>
            <Text style={[styles.cell, styles.pctCol]}>%</Text>
          </>
        ) : (
          <>
            <Text style={[styles.cell, styles.statCol]}>PG</Text>
            <Text style={[styles.cell, styles.statCol]}>PE</Text>
            <Text style={[styles.cell, styles.statCol]}>PP</Text>
            <Text style={[styles.cell, styles.statCol]}>Pts</Text>
          </>
        )}
      </View>
      {rows.map((row, idx) => {
        const winrate = mode === 'winrate' && row.pj ? Math.round(((row.pg ?? 0) / row.pj) * 100) : null;
        return (
          <View key={row.id} style={[styles.row, row.highlight && styles.rowHighlight]}>
            <Text style={[styles.cell, styles.posCol]}>{row.rank ?? idx + 1}</Text>
            <Text style={[styles.cell, styles.nameCol, styles.leftAlign]}>{row.name}</Text>
            {mode === 'winrate' ? (
              <>
                <Text style={[styles.cell, styles.statCol]}>{row.pg}</Text>
                <Text style={[styles.cell, styles.statCol]}>{row.pj}</Text>
                <Text style={[styles.cell, styles.pctCol]} numberOfLines={1}>
                  {winrate}%
                </Text>
              </>
            ) : (
              <>
                <Text style={[styles.cell, styles.statCol]}>{row.pg}</Text>
                <Text style={[styles.cell, styles.statCol]}>{row.pe}</Text>
                <Text style={[styles.cell, styles.statCol]}>{row.pp}</Text>
                <Text style={[styles.cell, styles.statCol]}>{row.pts}</Text>
              </>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 4 },
  header: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    paddingBottom: 8,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  rowHighlight: { backgroundColor: '#FEF3C7' },
  cell: { textAlign: 'center', color: '#111', fontWeight: '700', fontSize: 12 },
  leftAlign: { textAlign: 'left' },
  posCol: { width: 22, minWidth: 22 },
  nameCol: { flex: 1, minWidth: 90 },
  statCol: { width: 32, minWidth: 32, fontSize: 11 },
  pctCol: { width: 40, minWidth: 40, fontSize: 10 },
});

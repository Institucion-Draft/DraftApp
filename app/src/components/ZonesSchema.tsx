import React, { useMemo } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';
import type { ZoneOption } from '../lib/zonesPlanner';
import { zonesSchemaLayout, zonesSchemaModel, type CupNames } from '../lib/zonesPlannerText';

/** Alto de cada fila de lista y de la barra (px). */
const ROW_H = 12;
const BAR_H = 7;
/** Hueco entre columnas (donde van las flechas de interzonal). */
const GAP = 24;
/** Ancho FIJO de la columna de etiquetas (independiente de la cantidad de zonas); las columnas se reparten el resto. */
const LABEL_W = 96;
const LABEL_MARGIN = 8;
const BRACKET_W = 6;
/** Padding horizontal de la pantalla (ZonesDrawScreen: scroll con 16) y ancho máximo de una columna. */
const SCREEN_PAD = 16;
const COL_MAX_W = 56;
/** Alto de línea de las etiquetas y caracteres que entran por línea en el ancho disponible (11 px de letra). */
const LABEL_LINE_H = 13;
const LABEL_CHARS_PER_LINE = 12;

type Props = {
  option: ZoneOption;
  names: CupNames;
};

/** "Copa Quito" -> { head: 'Copa', tail: 'Quito' }; "Copa" -> { head: 'Copa', tail: '' }. */
function splitCupName(name: string): { head: string; tail: string } {
  const m = name.match(/^Copa\s*(.*)$/);
  return m ? { head: 'Copa', tail: m[1].trim() } : { head: name, tail: '' };
}

/** Líneas estimadas de una etiqueta: "Copa" + el nombre (que puede envolver). */
function labelLines(name: { head: string; tail: string }): number {
  return 1 + (name.tail ? Math.max(1, Math.ceil(name.tail.length / LABEL_CHARS_PER_LINE)) : 0);
}

/**
 * Esquema de una configuración de zonas: una lista por zona (sólo barras, sin nombres ni números), con las filas
 * que pasan seguro a la Copa en amarillo, las candidatas a "mejor del puesto siguiente" con borde punteado, flechas
 * de interzonal entre columnas y las etiquetas de Copa / Consuelo a la derecha (dos líneas: "Copa" y el nombre).
 */
export default function ZonesSchema({ option, names }: Props) {
  const styles = useThemedStyles(createStyles);
  const { width: screenW } = useWindowDimensions();
  const m = useMemo(() => zonesSchemaModel(option), [option]);
  const k = m.sizes.length;
  const maxSize = m.sizes[0] ?? 0;
  const height = maxSize * ROW_H;

  // Etiquetas con ancho fijo; las columnas de zonas se reparten el resto.
  const avail = screenW - SCREEN_PAD * 2 - LABEL_W - LABEL_MARGIN;
  const colW = Math.max(18, Math.min(COL_MAX_W, Math.floor((avail - (k - 1) * GAP) / k)));
  const colsWidth = k * colW + (k - 1) * GAP;

  const prima = splitCupName(names.prima);
  const consuelo = splitCupName(names.consuelo);
  const consueloName = { head: consuelo.head, tail: consuelo.tail };
  const layout = zonesSchemaLayout(m, ROW_H, labelLines(prima) * LABEL_LINE_H, labelLines(consueloName) * LABEL_LINE_H);
  const totalH = height + layout.padTop + layout.padBottom;

  return (
    <View style={styles.wrap} accessibilityLabel="Esquema de zonas">
      <View style={[styles.cols, { width: colsWidth, height, marginTop: layout.padTop }]}>
        {m.sizes.map((size, col) => (
          <View key={col} style={[styles.col, { left: col * (colW + GAP), width: colW }]}>
            {Array.from({ length: size }, (_, row) => {
              const sure = row < m.qualifiers;
              const wild = !sure && row === m.qualifiers && m.wildcardRow[col];
              return (
                <View key={row} style={styles.rowSlot}>
                  <View style={[styles.bar, sure && styles.barSure, wild && styles.barWild]} />
                </View>
              );
            })}
          </View>
        ))}
        {m.arrows.map(([a, b], n) => {
          const minSize = Math.min(m.sizes[a], m.sizes[b]);
          const frac = m.arrows.length === 1 ? 0.5 : n === 0 ? 0.33 : 0.67;
          // Altura: en el borde entre dos filas (nunca sobre el centro de una fila).
          const boundary = Math.min(Math.max(1, Math.round(minSize * frac)), Math.max(1, minSize - 1));
          return (
            <View
              key={`${a}-${b}`}
              style={[styles.arrow, { left: a * (colW + GAP) + colW, width: GAP, top: boundary * ROW_H - 9 }]}
            >
              <Text style={styles.arrowTxt}>↔</Text>
            </View>
          );
        })}
      </View>

      <View style={[styles.labels, { height: totalH }]}>
        <View style={[styles.bracket, styles.bracketCopa, { top: layout.padTop + layout.copaBracket.top, height: layout.copaBracket.height }]} />
        <View style={[styles.labelBox, { top: layout.padTop + layout.copaLabel.top }]}>
          <Text style={[styles.label, styles.labelCopa]}>{prima.head}</Text>
          {prima.tail ? <Text style={[styles.label, styles.labelCopa]}>{prima.tail}</Text> : null}
        </View>
        {layout.consuelo ? (
          <>
            <View
              style={[
                styles.bracket,
                styles.bracketConsuelo,
                { top: layout.padTop + layout.consuelo.bracket.top, height: layout.consuelo.bracket.height },
              ]}
            />
            <View style={[styles.labelBox, { top: layout.padTop + layout.consuelo.label.top }]}>
              <Text style={styles.label}>{consuelo.head}</Text>
              {consuelo.tail ? <Text style={styles.label}>{consuelo.tail}</Text> : null}
            </View>
          </>
        ) : null}
      </View>
    </View>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center', marginTop: 16, paddingVertical: 8 },
    cols: { position: 'relative' },
    col: { position: 'absolute', top: 0 },
    rowSlot: { height: ROW_H, justifyContent: 'center' },
    bar: { height: BAR_H, borderRadius: 3, backgroundColor: c.border, borderWidth: 1, borderColor: 'transparent' },
    // Amarillo: token de logros (oro), legible en claro y oscuro. La etiqueta "Copa {sede}" usa el mismo token.
    barSure: { backgroundColor: c.achievement.solid },
    barWild: {
      backgroundColor: 'transparent',
      borderColor: c.achievement.solid,
      borderStyle: 'dashed',
    },
    arrow: { position: 'absolute', height: 18, alignItems: 'center', justifyContent: 'center' },
    arrowTxt: { fontSize: 16, lineHeight: 18, color: c.textSecondary },
    labels: { marginLeft: LABEL_MARGIN, width: LABEL_W, position: 'relative' },
    bracket: { position: 'absolute', left: 0, width: BRACKET_W, borderWidth: 1.5, borderLeftWidth: 0, borderRadius: 2 },
    bracketCopa: { borderColor: c.achievement.solid },
    bracketConsuelo: { borderColor: c.textMuted },
    labelBox: { position: 'absolute', left: BRACKET_W + 6, right: 0 },
    label: { fontSize: 11, lineHeight: LABEL_LINE_H, fontWeight: '600', color: c.textSecondary },
    labelCopa: { color: c.achievement.solid, fontWeight: '800' },
  });

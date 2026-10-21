import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import PokemonSprite from './PokemonSprite';
import { fetchReceivedPokemon } from '../lib/pokemonReceivedApi';
import {
  formatShortDateAR,
  formatTypeShare,
  lastReceived,
  lastRowLayout,
  topTypeShare,
  type ReceivedRow,
} from '../lib/pokemonReceived';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';

type Props = { userId: string; workspaceId: string };

/** Sección "Pokemones" del perfil: últimos 5 asignados, tipo más asignado y acceso al historial. Sin datos, no se muestra. */
export default function PokemonReceivedSection({ userId, workspaceId }: Props) {
  const styles = useThemedStyles(createStyles);
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const [rows, setRows] = useState<ReceivedRow[] | null>(null);
  // Ancho disponible de la fila: se mide al dibujar; mientras tanto se estima con el padding de 24 px de los perfiles.
  const { width: windowWidth } = useWindowDimensions();
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  const L = lastRowLayout(rowWidth ?? windowWidth - 48);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    fetchReceivedPokemon(userId, workspaceId)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, workspaceId]);

  const last = useMemo(() => (rows ? lastReceived(rows, 5) : []), [rows]);
  const share = useMemo(() => (rows ? topTypeShare(rows) : null), [rows]);

  if (!rows || rows.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Pokemones</Text>

      <Text style={styles.subTitle}>Últimos 5 asignados</Text>
      <View style={styles.lastRow} onLayout={(e) => setRowWidth(e.nativeEvent.layout.width)}>
        {last.map((r) => (
          <View key={r.id} style={[styles.cell, { width: L.cell }]}>
            <PokemonSprite row={r} size={L.sprite} />
            <Text style={styles.date} numberOfLines={1}>
              {formatShortDateAR(r.eventDate)}
            </Text>
          </View>
        ))}
      </View>

      {share ? (
        <View style={styles.typeBlock}>
          <Text style={styles.subTitle}>Tipo más asignado</Text>
          {formatTypeShare(share).map((line) => (
            <Text key={line} style={styles.typeLine}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}

      <TouchableOpacity style={styles.link} onPress={() => navigation.navigate('PokemonHistory', { userId, workspaceId })}>
        <Text style={styles.linkText}>Historial completo</Text>
      </TouchableOpacity>
    </View>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    section: { marginTop: 24 },
    sectionTitle: {
      fontSize: 12,
      fontWeight: '600',
      color: c.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      marginBottom: 12,
    },
    subTitle: { fontSize: 13, color: c.textSecondary, marginBottom: 6 },
    lastRow: { flexDirection: 'row', alignItems: 'flex-start' },
    cell: { alignItems: 'center' },
    date: { fontSize: 10, color: c.textSecondary, marginTop: 4, textAlign: 'center' },
    typeBlock: { marginTop: 14 },
    typeLine: { fontSize: 15, fontWeight: '600', color: c.text, paddingVertical: 2 },
    link: { marginTop: 14, alignSelf: 'flex-start' },
    linkText: { fontSize: 15, fontWeight: '600', color: c.accent },
  });

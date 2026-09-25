import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import PlayerAvatar, { type PlayerAvatarSize } from './PlayerAvatar';
import type { SeasonPodiumPlayer, SeasonPodiumStep } from '../lib/seasonPodium';
import { useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';

/** Mismo ancho de columna y alturas de peldaño que el podio de un evento (StandingsScreen/ProDeC). */
const COL_WIDTH = 132;
const AVATAR_ROW_GAP = 6;
const AVATAR_DIAM_MEDIUM = 48;
const AVATAR_DIAM_SMALL = 32;

function rowMinWidth(n: number, diameter: number): number {
  return n <= 0 ? 0 : diameter * n + AVATAR_ROW_GAP * (n - 1);
}

/** Tamaño de avatar según cuántos comparten el peldaño (los empates pueden juntar a varios). */
function avatarSizeFor(n: number): PlayerAvatarSize {
  if (n <= 1) return 'large';
  if (n === 2) return COL_WIDTH < rowMinWidth(2, AVATAR_DIAM_MEDIUM) ? 'small' : 'medium';
  if (n <= 4) return COL_WIDTH < rowMinWidth(n, AVATAR_DIAM_SMALL) ? 'tiny' : 'small';
  return 'tiny';
}

const PEDESTAL: Record<1 | 2 | 3, { height: number; bg: string; light: boolean }> = {
  1: { height: 124, bg: '#FCD34D', light: false },
  2: { height: 90, bg: '#D1D5DB', light: false },
  3: { height: 70, bg: '#B45309', light: true },
};

type Props = {
  steps: SeasonPodiumStep[];
  onPressPlayer?: (player: SeasonPodiumPlayer) => void;
};

export default function SeasonPodium({ steps, onPressPlayer }: Props) {
  const styles = useThemedStyles(createStyles);
  if (steps.length === 0) return null;

  const renderColumn = (rank: 1 | 2 | 3) => {
    const step = steps.find((s) => s.rank === rank);
    const players = step?.players ?? [];
    const size = players.length > 0 ? avatarSizeFor(players.length) : ('large' as PlayerAvatarSize);
    const ped = PEDESTAL[rank];
    return (
      <View key={rank} style={styles.col}>
        <View style={styles.avatarArea}>
          <View style={styles.avatarRow}>
            {players.map((p) => (
              <TouchableOpacity
                key={p.userId}
                activeOpacity={onPressPlayer ? 0.75 : 1}
                disabled={!onPressPlayer}
                onPress={() => onPressPlayer?.(p)}
                style={styles.playerStack}
                accessibilityRole={onPressPlayer ? 'button' : undefined}
                accessibilityLabel={`${rank}° puesto: ${p.name}`}
              >
                <PlayerAvatar userId={p.userId} size={size} withColorBorder={false} outsideEvent />
              </TouchableOpacity>
            ))}
          </View>
        </View>
        {players.length > 0 ? (
          <View style={styles.names}>
            {players.map((p) => (
              <Text key={p.userId} style={styles.nameTxt} numberOfLines={1}>
                {p.name}
              </Text>
            ))}
          </View>
        ) : null}
        <View style={[styles.base, { height: ped.height, backgroundColor: ped.bg }]}>
          <Text style={[styles.baseRank, ped.light && styles.baseLight]}>{rank}</Text>
          {step ? <Text style={[styles.basePts, ped.light && styles.baseLight]}>{step.points} pts</Text> : null}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.section}>
      <View style={styles.row}>
        {renderColumn(2)}
        {renderColumn(1)}
        {renderColumn(3)}
      </View>
    </View>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    section: { marginBottom: 20 },
    row: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      justifyContent: 'center',
      gap: 10,
      paddingHorizontal: 4,
    },
    col: {
      flexDirection: 'column',
      justifyContent: 'flex-end',
      alignItems: 'center',
      width: COL_WIDTH,
    },
    avatarArea: {
      width: '100%',
      justifyContent: 'flex-end',
      alignItems: 'center',
      minHeight: 96,
      marginBottom: 2,
    },
    avatarRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'center',
      alignItems: 'flex-end',
      gap: AVATAR_ROW_GAP,
      width: '100%',
    },
    playerStack: { alignItems: 'center' },
    names: { width: '100%', alignItems: 'center', marginBottom: 4 },
    nameTxt: { fontSize: 12, fontWeight: '700', color: c.text, maxWidth: COL_WIDTH },
    base: {
      width: '100%',
      borderRadius: 8,
      marginTop: 2,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(0,0,0,0.12)',
    },
    // Texto sobre los peldaños oro/plata/bronce (PEDESTAL): el fondo es fijo, así que el texto también.
    baseRank: { fontSize: 26, fontWeight: '800', color: '#111' },
    basePts: { fontSize: 12, fontWeight: '700', color: '#374151', marginTop: 2 },
    baseLight: { color: '#fff' },
  });

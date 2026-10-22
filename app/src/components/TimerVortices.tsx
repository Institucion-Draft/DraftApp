import React from 'react';
import { StyleSheet, View } from 'react-native';
import { TABLE, Vortex } from './SeatingTable';
import { TIMER_VORTEX_GAP, TIMER_VORTEX_SIZE, timerVortexDirections, type PackDirection } from '../lib/eventSeating';
import { useTheme } from '../theme';

const SIZE = TIMER_VORTEX_SIZE;

type Props = {
  /** Sentido del PRIMER sobre (event_seating.direction). */
  firstDirection: PackDirection;
  /** Número de sobre actual (1, 2, 3...), el mismo que muestra el cronómetro ("Sobre N"). */
  packNumber: number;
  /** Giran sólo mientras sea true. */
  spinning: boolean;
};

/**
 * Tres mini vórtices (🃏 sobres, 🧉 mate, 🚬 cigarro) para el cronómetro del draft. Sutiles: chicos, semitransparentes y
 * sin capturar toques. Se actualizan solos al cambiar `packNumber`. Colores y dibujo: los mismos de la pantalla de la mesa.
 */
export default function TimerVortices({ firstDirection, packNumber, spinning }: Props) {
  const { mode } = useTheme();
  const pal = TABLE[mode === 'dark' ? 'dark' : 'light'];
  const d = timerVortexDirections(firstDirection, packNumber);
  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={styles.row}>
        <Vortex emoji="🃏" color={pal.packs} direction={d.packs} size={SIZE} active={spinning} />
        <Vortex emoji="🧉" color={pal.mate} direction={d.mate} size={SIZE} active={spinning} />
        <Vortex emoji="🚬" color={pal.mate} direction={d.cigar} size={SIZE} active={spinning} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Esquina superior derecha de la fila de arriba (a la derecha de "← Volver"): hueco libre, no desplaza nada. El envoltorio
  // ocupa el alto de la fila y centra la hilera, que es más alta: sobresale parejo por arriba y por abajo sin mover otros elementos.
  wrap: { position: 'absolute', right: 0, top: 0, bottom: 0, justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: TIMER_VORTEX_GAP, opacity: 0.75 },
});

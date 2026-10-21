import React, { useState } from 'react';
import { Image, StyleSheet, View, useWindowDimensions } from 'react-native';
import { defaultAvatarPublicUrl } from '../lib/avatarUrl';
import { gen3Starters, startersLayout } from '../lib/gen3Starters';

/**
 * Los tres iniciales de Gen 3 en fila, sólo sprites. Cada PNG (96x96) se dibuja a 88 px y se recorta a la zona
 * del sprite para no sumar aire transparente; los márgenes negativos compensan el espacio fijo del cartel
 * (título y botones) sólo para esta fila. Un sprite que no carga desaparece sin romper el resto.
 */
export default function Gen3StartersRow() {
  const { width } = useWindowDimensions();
  const L = startersLayout(width);
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const items = gen3Starters()
    .map((s) => ({ ...s, uri: defaultAvatarPublicUrl(s.storagePath) }))
    .filter((s) => s.uri && !failed[s.species]);
  if (items.length === 0) return null;
  return (
    <View style={[styles.row, { gap: L.gap }]}>
      {items.map((s) => (
        <View key={s.species} style={{ width: L.clipWidth, height: L.clipHeight, overflow: 'hidden' }}>
          <Image
            source={{ uri: s.uri as string }}
            style={{ width: L.size, height: L.size, marginLeft: L.offsetX, marginTop: L.offsetY }}
            resizeMode="contain"
            onError={() => setFailed((f) => ({ ...f, [s.species]: true }))}
          />
        </View>
      ))}
    </View>
  );
}

// marginTop/marginBottom negativos: el título deja 6 px debajo y los botones suben 16 px de margen propio;
// con estos valores el aire queda en ~5 px arriba y abajo sin tocar el aspecto de los demás carteles.
const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginTop: -2, marginBottom: -11 },
});

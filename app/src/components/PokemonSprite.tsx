import React, { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { defaultAvatarPublicUrl } from '../lib/avatarUrl';
import { pokemonSpritePath, type ReceivedRow } from '../lib/pokemonReceived';

type Props = { row: Pick<ReceivedRow, 'storagePath' | 'storagePathShiny' | 'isShiny'>; size?: number };

/** Sprite de un Pokémon asignado (shiny si corresponde), con ✨ si lo es. Si la imagen no carga queda el fondo vacío. */
export default function PokemonSprite({ row, size = 44 }: Props) {
  const [failed, setFailed] = useState(false);
  const uri = defaultAvatarPublicUrl(pokemonSpritePath(row));
  return (
    <View style={[styles.box, { width: size, height: size }]}>
      {uri && !failed ? (
        <Image source={{ uri }} style={{ width: size, height: size }} resizeMode="contain" onError={() => setFailed(true)} />
      ) : null}
      {row.isShiny ? <Text style={styles.shiny}>✨</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Fondo claro fijo: es contenido del sprite (igual que en PlayerAvatar), no UI del tema.
  box: { borderRadius: 8, backgroundColor: '#f3f4f6', overflow: 'visible' },
  shiny: { position: 'absolute', top: -4, right: -4, fontSize: 14 },
});

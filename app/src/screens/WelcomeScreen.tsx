import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  TouchableWithoutFeedback,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '../contexts/AuthContext';
import type { RootStackParamList } from '../navigation/rootStackParams';

type Props = NativeStackScreenProps<RootStackParamList, 'Welcome'>;

const WELCOME_MANA_COLORS = [
  { key: 'W', bg: '#EDE0C4', border: '#D1D5DB' },
  { key: 'U', bg: '#6BB8ED' },
  { key: 'B', bg: '#6E6762' },
  { key: 'R', bg: '#ED7850' },
  { key: 'G', bg: '#5BB875' },
] as const;

export default function WelcomeScreen({ navigation }: Props) {
  const { session } = useAuth();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const logoBase = Math.round(windowWidth - 48);
  const logoScale = 1.3;
  /** Sube DraftApp + círculos sin mover el ícono (padding transparente bajo el círculo en el PNG). */
  const captionGap = 18;
  const captionPullUp = Math.round(logoBase * 0.14);
  const captionMarginTop = captionGap - captionPullUp;
  const [showTapHint, setShowTapHint] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowTapHint(true), 2000);
    return () => clearTimeout(timer);
  }, []);

  const handlePress = () => {
    if (!showTapHint) return;
    navigation.reset({
      index: 0,
      routes: [{ name: session ? 'Main' : 'Auth' }],
    });
  };

  return (
    <TouchableWithoutFeedback onPress={showTapHint ? handlePress : undefined} accessible={false}>
      <View
        style={[
          styles.container,
          { paddingTop: insets.top, paddingBottom: insets.bottom },
        ]}
      >
        <View style={styles.hero}>
          <View style={styles.brandBlock}>
            <Image
              source={require('../../assets/icon.png')}
              style={[
                styles.logo,
                {
                  width: logoBase,
                  height: logoBase,
                  transform: [{ scale: logoScale }],
                },
              ]}
              resizeMode="contain"
            />
            <View style={[styles.captionBlock, { marginTop: captionMarginTop }]}>
              <Text style={styles.title}>DraftApp</Text>
              <View style={styles.colorRow}>
                {WELCOME_MANA_COLORS.map((c) => (
                  <View
                    key={c.key}
                    style={[
                      styles.colorDot,
                      { backgroundColor: c.bg },
                      'border' in c ? styles.colorDotBordered : null,
                      'border' in c ? { borderColor: c.border } : null,
                    ]}
                  />
                ))}
              </View>
            </View>
          </View>
        </View>
        {showTapHint ? (
          <Text style={styles.hint}>Tocá en cualquier lugar para arrancar a draftear</Text>
        ) : (
          <View style={styles.hintPlaceholder} />
        )}
      </View>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  hero: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  brandBlock: {
    alignItems: 'center',
  },
  captionBlock: {
    alignItems: 'center',
  },
  logo: {
    marginBottom: 0,
  },
  title: {
    fontSize: 34,
    fontWeight: '800',
    color: '#111827',
    textAlign: 'center',
    lineHeight: 38,
    includeFontPadding: false,
  },
  colorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    marginTop: 8,
  },
  colorDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
  },
  colorDotBordered: {
    borderWidth: 1,
  },
  hint: {
    fontSize: 16,
    fontWeight: '400',
    color: '#6B7280',
    textAlign: 'center',
    paddingHorizontal: 32,
    marginBottom: 48,
  },
  hintPlaceholder: {
    height: 48,
    marginBottom: 48,
  },
});

import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../navigation/mainStackParams';
import RoundRobinRulesContent from './rules/roundRobinRulesContent';
import SwissRulesContent from './rules/swissRulesContent';
import { useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';

type Props = NativeStackScreenProps<MainStackParamList, 'CompetitionRules'>;
type ModalityTab = 'round_robin' | 'swiss' | 'two_headed_giant';

const TABS: { value: ModalityTab; label: string }[] = [
  { value: 'round_robin', label: 'Todos contra todos' },
  { value: 'swiss', label: 'Rondas suizas' },
  { value: 'two_headed_giant', label: 'Gigante de dos cabezas' },
];

export default function CompetitionRulesScreen(_props: Props) {
  const styles = useThemedStyles(createStyles);
  const [tab, setTab] = useState<ModalityTab>('round_robin');

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      <View style={styles.segmented}>
        {TABS.map((opt) => {
          const selected = tab === opt.value;
          return (
            <TouchableOpacity
              key={opt.value}
              style={[styles.segment, selected && styles.segmentSelected]}
              onPress={() => setTab(opt.value)}
            >
              <Text style={[styles.segmentTxt, selected && styles.segmentTxtSelected]}>{opt.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {tab === 'round_robin' ? (
        <RoundRobinRulesContent />
      ) : tab === 'swiss' ? (
        <SwissRulesContent />
      ) : (
        <View style={styles.placeholderWrap}>
          <Text style={styles.placeholderTxt}>Próximamente</Text>
        </View>
      )}
    </ScrollView>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    scroll: { padding: 24, paddingBottom: 40 },
    segmented: {
      flexDirection: 'row',
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 8,
      overflow: 'hidden',
      marginBottom: 20,
    },
    segment: { flex: 1, paddingVertical: 12, paddingHorizontal: 4, alignItems: 'center', backgroundColor: c.card },
    segmentSelected: { backgroundColor: c.accent },
    segmentTxt: { fontSize: 13, color: c.text, fontWeight: '600', textAlign: 'center' },
    segmentTxtSelected: { color: c.onAccent },
    placeholderWrap: { alignItems: 'center', paddingVertical: 40 },
    placeholderTxt: { fontSize: 15, color: c.textMuted, fontWeight: '500' },
  });

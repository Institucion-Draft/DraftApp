import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../navigation/mainStackParams';
import RoundRobinRulesContent from './rules/roundRobinRulesContent';

type Props = NativeStackScreenProps<MainStackParamList, 'CompetitionRules'>;
type ModalityTab = 'round_robin' | 'swiss';

const TABS: { value: ModalityTab; label: string }[] = [
  { value: 'round_robin', label: 'Todos contra todos' },
  { value: 'swiss', label: 'Rondas suizas' },
];

export default function CompetitionRulesScreen(_props: Props) {
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
      ) : (
        <View style={styles.placeholderWrap}>
          <Text style={styles.placeholderTxt}>Próximamente</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  scroll: { padding: 24, paddingBottom: 40 },
  segmented: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: 20,
  },
  segment: { flex: 1, paddingVertical: 12, alignItems: 'center', backgroundColor: '#fafafa' },
  segmentSelected: { backgroundColor: '#3B82F6' },
  segmentTxt: { fontSize: 15, color: '#111', fontWeight: '600' },
  segmentTxtSelected: { color: '#fff' },
  placeholderWrap: { alignItems: 'center', paddingVertical: 40 },
  placeholderTxt: { fontSize: 15, color: '#9CA3AF', fontWeight: '500' },
});

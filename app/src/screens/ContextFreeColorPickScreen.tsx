import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import type { MtgColor } from '../lib/database.types';
import { defaultAvatarPublicUrl } from '../lib/avatarUrl';

type Props = NativeStackScreenProps<MainStackParamList, 'ContextFreeColorPick'>;

const COLOR_OPTIONS: { key: MtgColor; label: string; bg: string; textColor: string }[] = [
  { key: 'W', label: 'Blanco', bg: '#F8FAFC', textColor: '#111827' },
  { key: 'U', label: 'Azul', bg: '#DBEAFE', textColor: '#1E3A8A' },
  { key: 'B', label: 'Negro', bg: '#1F2937', textColor: '#F9FAFB' },
  { key: 'R', label: 'Rojo', bg: '#FEE2E2', textColor: '#991B1B' },
  { key: 'G', label: 'Verde', bg: '#DCFCE7', textColor: '#166534' },
];

const STARTING_LIFE = 20;

type UserName = { id: string; display_name: string; username: string };
type PresenceAvatar = {
  user_id: string;
  is_shiny: boolean;
  default_avatars: { storage_path: string; storage_path_shiny: string | null } | null;
};

export default function ContextFreeColorPickScreen({ navigation, route }: Props) {
  const { workspaceId, userAId, userBId, encounterType } = route.params;
  const [userA, setUserA] = useState<UserName | null>(null);
  const [userB, setUserB] = useState<UserName | null>(null);
  const [avatarUrlA, setAvatarUrlA] = useState<string | null>(null);
  const [avatarUrlB, setAvatarUrlB] = useState<string | null>(null);
  const [colorsA, setColorsA] = useState<MtgColor[]>([]);
  const [colorsB, setColorsB] = useState<MtgColor[]>([]);
  const [starterUserId, setStarterUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [usersRes, presenceRes] = await Promise.all([
        supabase
          .from('users')
          .select('id, display_name, username')
          .in('id', [userAId, userBId]),
        supabase
          .from('playground_presence')
          .select('user_id, is_shiny, default_avatars ( storage_path, storage_path_shiny )')
          .eq('workspace_id', workspaceId)
          .in('user_id', [userAId, userBId]),
      ]);
      const rows = usersRes.data ?? [];
      setUserA(rows.find((r) => r.id === userAId) ?? null);
      setUserB(rows.find((r) => r.id === userBId) ?? null);

      const presRows = (presenceRes.data ?? []) as unknown as PresenceAvatar[];
      const getAvatarUrl = (userId: string): string | null => {
        const p = presRows.find((r) => r.user_id === userId);
        if (!p?.default_avatars) return null;
        const path =
          p.is_shiny && p.default_avatars.storage_path_shiny
            ? p.default_avatars.storage_path_shiny
            : p.default_avatars.storage_path;
        return defaultAvatarPublicUrl(path);
      };
      setAvatarUrlA(getAvatarUrl(userAId));
      setAvatarUrlB(getAvatarUrl(userBId));
      setLoading(false);
    })();
  }, [userAId, userBId, workspaceId]);

  const toggleColor = (
    setColors: React.Dispatch<React.SetStateAction<MtgColor[]>>,
    color: MtgColor
  ) => {
    setColors((prev) =>
      prev.includes(color) ? prev.filter((c) => c !== color) : [...prev, color]
    );
  };

  const sortColors = (colors: MtgColor[]): MtgColor[] =>
    COLOR_OPTIONS.map((o) => o.key).filter((k) => colors.includes(k));

  const handleStart = async () => {
    setSaving(true);
    try {
      const { data: encData, error: encError } = await supabase
        .from('context_free_encounters')
        .insert({
          workspace_id: workspaceId,
          user_a_id: userAId,
          user_b_id: userBId,
          encounter_type: encounterType,
          colors_a: sortColors(colorsA),
          colors_b: sortColors(colorsB),
        })
        .select('id')
        .single();

      if (encError || !encData) {
        setSaving(false);
        Alert.alert('Error', 'No se pudo crear el encuentro.');
        return;
      }

      const encounterId = encData.id;

      const { data: matchData, error: matchError } = await supabase
        .from('context_free_matches')
        .insert({
          encounter_id: encounterId,
          match_number: 1,
          starting_life_a: STARTING_LIFE,
          starting_life_b: STARTING_LIFE,
          started_by_user_id: starterUserId,
        })
        .select('id')
        .single();

      if (matchError || !matchData) {
        setSaving(false);
        Alert.alert('Error', 'No se pudo crear la partida.');
        return;
      }

      navigation.replace('ContextFreeLifeTracker', {
        matchId: matchData.id,
        encounterId,
        workspaceId,
      });
    } catch (e) {
      setSaving(false);
      if (__DEV__) console.error('ContextFreeColorPick handleStart error:', e);
      Alert.alert('Error', 'Ocurrió un error inesperado.');
    }
  };

  const nameA = userA?.display_name || userA?.username || 'Jugador A';
  const nameB = userB?.display_name || userB?.username || 'Jugador B';

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  const renderColorPicker = (
    label: string,
    selected: MtgColor[],
    setColors: React.Dispatch<React.SetStateAction<MtgColor[]>>
  ) => (
    <View style={styles.pickerSection}>
      <Text style={styles.pickerLabel}>{label}</Text>
      <View style={styles.colorRow}>
        {COLOR_OPTIONS.map((opt) => {
          const active = selected.includes(opt.key);
          return (
            <TouchableOpacity
              key={opt.key}
              style={[
                styles.colorChip,
                { backgroundColor: opt.bg },
                active && styles.colorChipActive,
              ]}
              onPress={() => toggleColor(setColors, opt.key)}
              activeOpacity={0.7}
            >
              <Text style={[styles.colorChipText, { color: opt.textColor }]}>{opt.key}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={styles.colorHint}>
        {selected.length === 0
          ? 'Sin colores seleccionados'
          : sortColors(selected).join('')}
      </Text>
    </View>
  );

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>
        {encounterType === 'bo1' ? 'Partida sin contexto' : 'Enfrentamiento sin contexto'}
      </Text>

      {renderColorPicker(nameA, colorsA, setColorsA)}
      {renderColorPicker(nameB, colorsB, setColorsB)}

      <View style={styles.starterSection}>
        <Text style={styles.starterLabel}>¿Quién empieza?</Text>
        <View style={styles.starterRow}>
          {[
            { id: userAId, name: nameA, avatarUrl: avatarUrlA },
            { id: userBId, name: nameB, avatarUrl: avatarUrlB },
          ].map(({ id, name, avatarUrl }) => {
            const selected = starterUserId === id;
            return (
              <TouchableOpacity
                key={id}
                style={[styles.starterOption, selected && styles.starterOptionSelected]}
                onPress={() => setStarterUserId(selected ? null : id)}
                activeOpacity={0.7}
              >
                {avatarUrl ? (
                  <Image
                    source={{ uri: avatarUrl }}
                    style={styles.starterAvatar}
                    resizeMode="contain"
                  />
                ) : (
                  <View style={styles.starterAvatarPh} />
                )}
                <Text
                  style={[styles.starterName, selected && styles.starterNameSelected]}
                  numberOfLines={1}
                >
                  {name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <TouchableOpacity
        style={[styles.startBtn, saving && styles.startBtnDisabled]}
        onPress={handleStart}
        disabled={saving}
      >
        {saving ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.startBtnText}>Comenzar</Text>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#fff' },
  content: { paddingHorizontal: 24, paddingTop: 24, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  heading: {
    fontSize: 22,
    fontWeight: '800',
    color: '#111',
    textAlign: 'center',
    marginBottom: 24,
  },
  pickerSection: {
    marginBottom: 20,
    backgroundColor: '#F9FAFB',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  pickerLabel: { fontSize: 15, fontWeight: '700', color: '#111', marginBottom: 12 },
  colorRow: { flexDirection: 'row', gap: 8 },
  colorChip: {
    width: 48,
    height: 48,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  colorChipActive: { borderColor: '#3B82F6' },
  colorChipText: { fontSize: 16, fontWeight: '800' },
  colorHint: { fontSize: 12, color: '#9CA3AF', marginTop: 8 },
  starterSection: {
    marginBottom: 20,
    backgroundColor: '#F9FAFB',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  starterLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111',
    marginBottom: 12,
  },
  starterRow: { flexDirection: 'row', gap: 10 },
  starterOption: {
    flex: 1,
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#E5E7EB',
    paddingVertical: 12,
    paddingHorizontal: 8,
    backgroundColor: '#fff',
  },
  starterOptionSelected: {
    borderColor: '#3B82F6',
    backgroundColor: '#EFF6FF',
  },
  starterAvatar: { width: 52, height: 52, marginBottom: 6 },
  starterAvatarPh: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#E5E7EB',
    marginBottom: 6,
  },
  starterName: { fontSize: 13, fontWeight: '600', color: '#374151', textAlign: 'center' },
  starterNameSelected: { color: '#1D4ED8' },
  startBtn: {
    backgroundColor: '#3B82F6',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  startBtnDisabled: { opacity: 0.6 },
  startBtnText: { color: '#fff', fontSize: 17, fontWeight: '700' },
});

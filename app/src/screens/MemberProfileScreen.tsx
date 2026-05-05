import React, { useCallback, useLayoutEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import PlayerAvatar from '../components/PlayerAvatar';

type Props = NativeStackScreenProps<MainStackParamList, 'MemberProfile'>;

export default function MemberProfileScreen({ navigation, route }: Props) {
  const { userId, workspaceId } = route.params;
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [isOrganizer, setIsOrganizer] = useState(false);

  const load = useCallback(async () => {
    const [userRes, roleRes] = await Promise.all([
      supabase.from('users').select('display_name, username').eq('id', userId).maybeSingle(),
      supabase
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .maybeSingle(),
    ]);

    if (userRes.error) {
      Alert.alert('Error', userRes.error.message ?? 'No se pudo cargar el perfil.');
      setDisplayName('');
      setLoading(false);
      return;
    }
    const row = userRes.data as { display_name?: string; username?: string } | null;
    const name = row?.display_name || row?.username || 'Sin nombre';
    setDisplayName(name);
    setIsOrganizer(roleRes.data?.role === 'organizer');
    if (roleRes.error && __DEV__) {
      console.error('MemberProfile role', roleRes.error);
    }
    setLoading(false);
  }, [userId, workspaceId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load();
    }, [load])
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'WorkspaceDetail', { workspaceId }),
    });
  }, [navigation, workspaceId]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <View style={styles.avatarBlock}>
        <PlayerAvatar userId={userId} size="large" withColorBorder={false} outsideEvent />
      </View>
      <Text style={styles.name}>{displayName}</Text>
      {isOrganizer ? (
        <View style={styles.badge}>
          <Text style={styles.badgeTxt}>Organizador</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  scroll: { padding: 24, paddingBottom: 40, backgroundColor: '#fff', flexGrow: 1 },
  avatarBlock: { alignItems: 'center', marginBottom: 20 },
  name: { fontSize: 22, fontWeight: '700', color: '#111', textAlign: 'center', marginBottom: 14 },
  badge: {
    alignSelf: 'center',
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 999,
  },
  badgeTxt: { color: '#1D4ED8', fontSize: 14, fontWeight: '700' },
});

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  RefreshControl,
  TouchableOpacity,
  Pressable,
  ActivityIndicator,
  Alert,
  Animated,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import { avatarPublicUrl } from '../lib/avatarUrl';
import PlayerAvatar from '../components/PlayerAvatar';
import { fetchWorkspaceSeasons, phaseSubtitle, syncWorkspaceSeasons, type SeasonRow } from '../lib/seasons';
import { formatEventMode } from '../lib/eventMode';
import { useTheme, useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';

type Props = NativeStackScreenProps<MainStackParamList, 'WorkspaceDetail'>;

type WorkspaceRow = {
  id: string;
  name: string;
  description: string | null;
  avatar_path: string | null;
};

type UserEmbed = {
  username: string;
  display_name: string;
  custom_avatar_path: string | null;
  default_avatars: { storage_path: string } | { storage_path: string }[] | null;
};

type MemberRow = {
  role: 'organizer' | 'member';
  user_id: string;
  users: UserEmbed | UserEmbed[] | null;
};

type TodayEvent = {
  id: string;
  name: string;
  status: string;
  event_type: string | null;
  competition_format: string | null;
  top_size: number | null;
  match_format: string | null;
};

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

export default function WorkspaceDetailScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { workspaceId } = route.params;
  const { user } = useAuth();
  const [workspace, setWorkspace] = useState<WorkspaceRow | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [pendingJoinCount, setPendingJoinCount] = useState(0);
  const [seasons, setSeasons] = useState<SeasonRow[]>([]);
  const [todayEvents, setTodayEvents] = useState<TodayEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const initialFocusRef = useRef(true);

  const load = useCallback(async () => {
    if (!user?.id) return;

    const { data: ws, error: wsError } = await supabase
      .from('workspaces')
      .select('id, name, description, avatar_path')
      .eq('id', workspaceId)
      .maybeSingle();

    if (wsError) {
      Alert.alert('Error', 'No se pudo cargar el grupo de Draft.');
      setWorkspace(null);
      setMembers([]);
      setPendingJoinCount(0);
      return;
    }
    setWorkspace(ws);

    const { data: myRow } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .maybeSingle();

    const organizer = myRow?.role === 'organizer';
    setIsOrganizer(organizer);

    const pendingPromise = organizer
      ? supabase
          .from('workspace_join_requests')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId)
          .eq('status', 'pending')
      : Promise.resolve({ count: 0 as number | null, error: null });

    const { data: memData, error: memError } = await supabase
      .from('workspace_members')
      .select(
        `
        role,
        user_id,
        users!workspace_members_user_id_fkey (
          username,
          display_name,
          custom_avatar_path,
          default_avatars (storage_path)
        )
      `
      )
      .eq('workspace_id', workspaceId)
      .order('joined_at', { ascending: true });

    const pendingRes = await pendingPromise;
    if (!pendingRes.error) {
      setPendingJoinCount(pendingRes.count ?? 0);
    } else {
      setPendingJoinCount(0);
    }

    if (memError) {
      if (__DEV__) {
        console.error('Error cargando miembros del workspace:', memError);
      }
      Alert.alert(
        'Error',
        memError.message ?? 'No se pudieron cargar los miembros.'
      );
      setMembers([]);
      return;
    }

    setMembers((memData ?? []) as MemberRow[]);
  }, [workspaceId, user?.id]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const first = initialFocusRef.current;
        if (first) {
          setLoading(true);
          initialFocusRef.current = false;
        }
        await load();
        if (!cancelled && first) setLoading(false);
      })();
      return () => {
        cancelled = true;
      };
    }, [load])
  );

  // Disparador client-orchestrated de temporadas: crea la actual y la próxima si faltan y cierra
  // las que ya se puedan cerrar, y después lee el estado. Idempotente, corre en cada foco.
  const loadSeasons = useCallback(async () => {
    await syncWorkspaceSeasons(workspaceId);
    setSeasons(await fetchWorkspaceSeasons(workspaceId));
  }, [workspaceId]);

  // Eventos programados para hoy (día calendario del dispositivo), sin cancelados ni eliminados.
  const loadTodayEvents = useCallback(async () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const { data, error } = await supabase
      .from('draft_events')
      .select('id, name, status, event_type, competition_format, top_size, match_format')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .neq('status', 'cancelled')
      .gte('scheduled_for', start.toISOString())
      .lt('scheduled_for', end.toISOString())
      .order('scheduled_for', { ascending: true });
    if (error) {
      if (__DEV__) console.warn('[workspace] eventos de hoy', error.message);
      setTodayEvents([]);
      return;
    }
    setTodayEvents((data ?? []) as TodayEvent[]);
  }, [workspaceId]);

  useFocusEffect(
    useCallback(() => {
      void loadSeasons();
      void loadTodayEvents();
    }, [loadSeasons, loadTodayEvents])
  );

  // Fade in/out del badge HOY: misma animación que el "ES HOY!" de la lista de eventos
  // (opacidad 1 -> 0.4 -> 1, 700 ms cada tramo, en loop). Solo corre si hay eventos de hoy.
  const pulse = useRef(new Animated.Value(1)).current;
  const hasTodayEvents = todayEvents.length > 0;
  useEffect(() => {
    if (!hasTodayEvents) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(1);
    };
  }, [hasTodayEvents, pulse]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: workspace?.name ?? 'Detalle del grupo',
      headerLeft: hierarchicalHeaderBack(navigation, 'WorkspacesList'),
      headerRight:
        user?.id != null
          ? () => (
              <View style={styles.headerRightRow}>
                <Pressable
                  onPress={() => navigation.navigate('Settings', { workspaceId })}
                  hitSlop={12}
                  style={styles.headerSettingsBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Configuración"
                >
                  <Text style={styles.headerSettingsIcon}>⚙️</Text>
                </Pressable>
                <Pressable
                  onPress={() =>
                    navigation.navigate('MyProfile', {
                      from: 'WorkspaceDetail',
                      workspaceId,
                    })
                  }
                  hitSlop={12}
                  style={styles.headerAvatarBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Mi perfil"
                >
                  <PlayerAvatar
                    userId={user.id}
                    size="small"
                    withColorBorder={false}
                    outsideEvent
                  />
                </Pressable>
              </View>
            )
          : undefined,
    });
  }, [navigation, workspace?.name, user?.id, workspaceId, styles]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([load(), loadSeasons(), loadTodayEvents()]);
    setRefreshing(false);
  }, [load, loadSeasons, loadTodayEvents]);

  const wsAvatar = workspace ? avatarPublicUrl(workspace.avatar_path) : null;

  // La lista viene ordenada por starts_at: la primera "upcoming" es la próxima.
  const currentSeason = seasons.find((s) => s.phase === 'active') ?? null;
  const seasonButtonSeason = currentSeason ?? seasons.find((s) => s.phase === 'upcoming') ?? null;
  const showSeasonHistory = seasons.some((s) => s.phase === 'finishing' || s.phase === 'closed');

  if (loading && !workspace) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (!workspace) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>No se encontró el grupo.</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      <View style={styles.hero}>
        {wsAvatar ? (
          <Image source={{ uri: wsAvatar }} style={styles.heroAvatar} />
        ) : (
          <View style={[styles.heroAvatar, styles.heroAvatarPh]}>
            <Text style={styles.heroAvatarLetter}>
              {workspace.name.slice(0, 1).toUpperCase()}
            </Text>
          </View>
        )}
        <Text style={styles.heroTitle}>{workspace.name}</Text>
        {workspace.description?.trim() ? (
          <Text style={styles.heroDesc}>{workspace.description.trim()}</Text>
        ) : (
          <Text style={styles.muted}>Sin descripción.</Text>
        )}
      </View>

      <View style={styles.groupSection}>
        <View style={styles.eventsCard}>
          <Text style={styles.eventsTitle}>Eventos</Text>
          {todayEvents.map((e) => (
            <TouchableOpacity
              key={e.id}
              style={styles.todayCard}
              activeOpacity={0.75}
              onPress={() => navigation.navigate('EventDetail', { eventId: e.id, workspaceId })}
              accessibilityRole="button"
              accessibilityLabel={`Evento de hoy: ${e.name}`}
            >
              <View style={styles.todayBody}>
                <View style={styles.todayNameRow}>
                  <Text style={styles.todayName} numberOfLines={1}>
                    {e.name}
                  </Text>
                </View>
                <View style={styles.todayModeRow}>
                  <Animated.View style={[styles.todayBadge, styles.todayBadgeFloating, { opacity: pulse }]}>
                    <Text style={styles.todayBadgeText}>HOY</Text>
                  </Animated.View>
                  <Text style={styles.todaySub} numberOfLines={1}>
                    {formatEventMode(e.event_type, e.competition_format, e.top_size, e.match_format)}
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          ))}
          <View style={styles.groupRow}>
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={() => navigation.navigate('EventsList', { workspaceId })}
              accessibilityRole="button"
            >
              <Text style={styles.primaryBtnText}>Todos los eventos</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.outlineBtn}
              onPress={() => navigation.navigate('CreateEvent', { workspaceId, from: 'WorkspaceDetail' })}
              accessibilityRole="button"
            >
              <Text style={styles.outlineBtnText}>Crear evento</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      <View style={styles.groupSection}>
        <View style={styles.casualCard}>
          <Text style={styles.casualTitle}>🎲 Partidas sin contexto</Text>
          <View style={styles.groupRow}>
            <TouchableOpacity
              style={styles.casualBtn}
              onPress={() => navigation.navigate('Playground', { workspaceId })}
              accessibilityRole="button"
            >
              <Text style={styles.casualBtnText}>Jugar contra otros usuarios</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.casualBtn}
              onPress={() => Alert.alert('Próximamente', 'El contador de vida estará disponible pronto.')}
              accessibilityRole="button"
            >
              <Text style={styles.casualBtnText}>Contador de vida</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      <View style={styles.groupSection}>
        <View style={styles.rankingCard}>
          <Text style={styles.rankingTitle}>🏆 Ranking</Text>
          {seasonButtonSeason ? (
            <TouchableOpacity
              style={[styles.rankingHeroBtn, !currentSeason && styles.disabledBtn]}
              disabled={!currentSeason}
              onPress={() =>
                currentSeason &&
                navigation.navigate('WorkspaceSeason', { workspaceId, seasonId: currentSeason.season_id })
              }
              accessibilityRole="button"
              accessibilityState={{ disabled: !currentSeason }}
            >
              <Text style={styles.rankingHeroText}>🏁 Temporada {seasonButtonSeason.name}</Text>
              <Text style={styles.rankingHeroSub}>{phaseSubtitle(seasonButtonSeason)}</Text>
            </TouchableOpacity>
          ) : null}
          <View style={styles.rankingSmallRow}>
            <TouchableOpacity
              style={styles.rankingSmallBtn}
              onPress={() => navigation.navigate('WorkspaceRanking', { workspaceId })}
              accessibilityRole="button"
            >
              <Text style={styles.rankingSmallText}>🌎 Global</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.rankingSmallBtn, !showSeasonHistory && styles.disabledBtn]}
              disabled={!showSeasonHistory}
              onPress={() => navigation.navigate('WorkspaceSeasonHistory', { workspaceId })}
              accessibilityRole="button"
              accessibilityState={{ disabled: !showSeasonHistory }}
            >
              <Text style={styles.rankingSmallText}>📜 Historial</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      <View style={styles.groupSection}>
        <View style={styles.pillRow}>
          <TouchableOpacity
            style={styles.pill}
            onPress={() => navigation.navigate('CubesList', { workspaceId })}
            accessibilityRole="button"
          >
            <Text style={styles.pillText}>🧊 Cubos</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.pill}
            onPress={() => navigation.navigate('VenuesList', { workspaceId })}
            accessibilityRole="button"
          >
            <Text style={styles.pillText}>🏠 Sedes</Text>
          </TouchableOpacity>
        </View>
      </View>

      {isOrganizer ? (
        <View style={styles.orgSection}>
          <Text style={styles.sectionTitle}>Acciones de organizador</Text>
          <TouchableOpacity
            style={styles.orgBtn}
            onPress={() =>
              navigation.navigate('GenerateInvite', { workspaceId })
            }
          >
            <Text style={styles.orgBtnText}>Generar link de invitación</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.orgBtn}
            onPress={() =>
              navigation.navigate('IncomingJoinRequests', { workspaceId })
            }
          >
            <View style={styles.orgBtnRow}>
              <Text style={styles.orgBtnText}>Ver solicitudes pendientes</Text>
              {pendingJoinCount > 0 ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{pendingJoinCount}</Text>
                </View>
              ) : null}
            </View>
          </TouchableOpacity>
        </View>
      ) : null}

      <Text style={styles.sectionTitle}>Miembros ({members.length})</Text>
      {members.map((m) => {
        const u = relationOne(m.users);
        const label = u?.display_name || u?.username || 'Sin nombre';
        const isSelf = user?.id != null && m.user_id === user.id;
        const rowInner = (
          <>
            <PlayerAvatar
              userId={m.user_id}
              size="small"
              withColorBorder={false}
              outsideEvent
              style={{ marginRight: 12 }}
            />
            <View style={styles.memberBody}>
              <Text style={styles.memberName}>{label}</Text>
              <Text style={styles.memberRole}>
                {m.role === 'organizer' ? 'Organizador' : 'Miembro'}
              </Text>
            </View>
          </>
        );
        if (isSelf) {
          return (
            <TouchableOpacity
              key={m.user_id}
              style={styles.memberRow}
              activeOpacity={0.7}
              onPress={() =>
                navigation.navigate('MyProfile', {
                  from: 'WorkspaceDetail',
                  workspaceId,
                })
              }
              accessibilityRole="button"
              accessibilityLabel="Mi perfil"
            >
              {rowInner}
            </TouchableOpacity>
          );
        }
        return (
          <TouchableOpacity
            key={m.user_id}
            style={styles.memberRow}
            activeOpacity={0.7}
            onPress={() =>
              navigation.navigate('MemberProfile', { userId: m.user_id, workspaceId })
            }
            accessibilityRole="button"
            accessibilityLabel={`Perfil de ${label}`}
          >
            {rowInner}
          </TouchableOpacity>
        );
      })}

      <View style={styles.diarySection}>
        <TouchableOpacity
          style={styles.diaryBtn}
          onPress={() => navigation.navigate('WorkspaceDiary', { workspaceId })}
          accessibilityRole="button"
          accessibilityLabel="Bugs y sugerencias"
        >
          <Text style={styles.diaryBtnIcon}>🐛💡</Text>
          <Text style={styles.diaryBtnText}>Bugs y sugerencias</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    headerAvatarBtn: {
      marginRight: 4,
      justifyContent: 'center',
      alignItems: 'center',
    },
    headerRightRow: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    headerSettingsBtn: {
      marginRight: 14,
      justifyContent: 'center',
      alignItems: 'center',
    },
    headerSettingsIcon: {
      fontSize: 22,
    },
    scroll: {
      flex: 1,
      backgroundColor: c.background,
    },
    scrollContent: {
      paddingBottom: 32,
    },
    centered: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: c.background,
    },
    hero: {
      paddingHorizontal: 24,
      paddingTop: 16,
      paddingBottom: 20,
      alignItems: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.divider,
    },
    heroAvatar: {
      width: 88,
      height: 88,
      borderRadius: 16,
      marginBottom: 12,
      backgroundColor: c.backgroundAlt,
    },
    heroAvatarPh: {
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.status.info.subtle,
    },
    heroAvatarLetter: {
      fontSize: 36,
      fontWeight: '700',
      color: c.status.info.text,
    },
    heroTitle: {
      fontSize: 22,
      fontWeight: '700',
      color: c.text,
      textAlign: 'center',
      marginBottom: 8,
    },
    heroDesc: {
      fontSize: 15,
      color: c.textSecondary,
      textAlign: 'center',
      lineHeight: 22,
    },
    groupSection: {
      paddingHorizontal: 24,
      paddingTop: 12,
      paddingBottom: 8,
    },
    todayCard: {
      backgroundColor: c.background,
      borderWidth: 1,
      borderColor: c.accent,
      borderRadius: 10,
      padding: 12,
      marginBottom: 10,
    },
    todayBadge: {
      backgroundColor: c.accent,
      borderRadius: 5,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    /** Superpuesto a la izquierda de la línea del modo, sin desplazar su centrado. */
    todayBadgeFloating: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      justifyContent: 'center',
    },
    todayBadgeText: {
      color: c.onAccent,
      fontSize: 10,
      fontWeight: '800',
      letterSpacing: 0.5,
    },
    todayBody: {
      width: '100%',
      alignItems: 'center',
    },
    /** Contenedor relativo de la línea del nombre, centrada sobre el ancho total. */
    todayNameRow: {
      width: '100%',
      alignItems: 'center',
    },
    todayName: {
      fontSize: 15,
      fontWeight: '700',
      color: c.text,
      textAlign: 'center',
    },
    /** Contenedor relativo de la línea del modo: el badge se ancla solo a esta fila. */
    todayModeRow: {
      width: '100%',
      alignItems: 'center',
    },
    todaySub: {
      fontSize: 12,
      color: c.textSecondary,
      marginTop: 2,
      textAlign: 'center',
    },
    // --- Eventos: máxima jerarquía ---
    eventsCard: {
      backgroundColor: c.status.info.subtle,
      borderWidth: 1,
      borderColor: c.status.info.border,
      borderRadius: 12,
      padding: 12,
    },
    eventsTitle: {
      fontSize: 17,
      fontWeight: '800',
      color: c.status.info.text,
      marginBottom: 10,
      textAlign: 'center',
    },
    primaryBtn: {
      flex: 1,
      backgroundColor: c.status.info.border,
      borderWidth: 1,
      borderColor: c.status.info.solid,
      borderRadius: 8,
      minHeight: 48,
      paddingHorizontal: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryBtnText: {
      color: c.status.info.text,
      fontSize: 15,
      fontWeight: '700',
      textAlign: 'center',
    },
    outlineBtn: {
      flex: 1,
      backgroundColor: c.status.info.subtle,
      borderWidth: 1,
      borderColor: c.accent,
      borderRadius: 8,
      minHeight: 48,
      paddingHorizontal: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    outlineBtnText: {
      color: c.status.info.text,
      fontSize: 15,
      fontWeight: '700',
      textAlign: 'center',
    },
    // --- Partidas sin contexto: jerarquía media, casual ---
    casualCard: {
      backgroundColor: c.status.success.subtle,
      borderWidth: 1,
      borderColor: c.status.success.border,
      borderRadius: 12,
      padding: 12,
    },
    casualTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: c.text,
      marginBottom: 10,
    },
    groupRow: {
      flexDirection: 'row',
      gap: 8,
    },
    casualBtn: {
      flex: 1,
      backgroundColor: c.background,
      borderWidth: 1,
      borderColor: c.status.success.border,
      borderRadius: 8,
      paddingVertical: 12,
      paddingHorizontal: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    casualBtnText: {
      color: c.status.success.text,
      fontSize: 15,
      fontWeight: '700',
      textAlign: 'center',
    },
    // --- Ranking: festivo/competitivo ---
    rankingCard: {
      backgroundColor: c.status.warning.subtle,
      borderWidth: 1,
      borderColor: c.status.warning.border,
      borderRadius: 14,
      padding: 12,
    },
    rankingTitle: {
      fontSize: 15,
      fontWeight: '800',
      color: c.status.warning.text,
      marginBottom: 10,
      textAlign: 'center',
    },
    rankingHeroBtn: {
      backgroundColor: c.status.warning.border,
      borderWidth: 1,
      borderColor: c.status.warning.solid,
      borderRadius: 10,
      paddingVertical: 14,
      paddingHorizontal: 12,
      alignItems: 'center',
    },
    rankingHeroText: {
      color: c.status.warning.text,
      fontSize: 16,
      fontWeight: '800',
      textAlign: 'center',
    },
    rankingHeroSub: {
      color: c.status.warning.text,
      fontSize: 12,
      marginTop: 3,
      textAlign: 'center',
    },
    rankingSmallRow: {
      flexDirection: 'row',
      gap: 8,
      marginTop: 8,
    },
    rankingSmallBtn: {
      flex: 1,
      backgroundColor: c.background,
      borderWidth: 1,
      borderColor: c.status.warning.border,
      borderRadius: 8,
      paddingVertical: 11,
      paddingHorizontal: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rankingSmallText: {
      color: c.status.warning.text,
      fontSize: 14,
      fontWeight: '700',
      textAlign: 'center',
    },
    disabledBtn: {
      opacity: 0.55,
    },
    // --- Cubos y sedes: accesorio ---
    pillRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    pill: {
      height: 40,
      paddingHorizontal: 16,
      borderRadius: 20,
      backgroundColor: c.card,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pillText: {
      color: c.textBody,
      fontSize: 13,
      fontWeight: '500',
    },
    muted: {
      fontSize: 15,
      color: c.textSecondary,
      textAlign: 'center',
    },
    orgSection: {
      paddingHorizontal: 24,
      paddingVertical: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.divider,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '700',
      color: c.text,
      marginBottom: 12,
      paddingHorizontal: 24,
      marginTop: 20,
    },
    orgBtn: {
      backgroundColor: c.status.info.subtle,
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderRadius: 8,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: c.status.info.border,
    },
    orgBtnRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
    },
    orgBtnText: {
      color: c.accent,
      fontSize: 15,
      fontWeight: '600',
      textAlign: 'center',
    },
    badge: {
      marginLeft: 10,
      minWidth: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: c.status.error.solid,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 6,
    },
    badgeText: {
      color: c.status.error.onSolid,
      fontSize: 12,
      fontWeight: '700',
    },
    memberRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 24,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.divider,
    },
    memberBody: {
      flex: 1,
      minWidth: 0,
    },
    memberName: {
      fontSize: 16,
      fontWeight: '600',
      color: c.text,
    },
    memberRole: {
      fontSize: 13,
      color: c.textSecondary,
      marginTop: 2,
    },
    diarySection: {
      paddingHorizontal: 24,
      paddingTop: 24,
    },
    diaryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: c.backgroundAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      paddingVertical: 12,
    },
    diaryBtnIcon: {
      fontSize: 16,
    },
    diaryBtnText: {
      color: c.textBody,
      fontSize: 15,
      fontWeight: '600',
    },
  });

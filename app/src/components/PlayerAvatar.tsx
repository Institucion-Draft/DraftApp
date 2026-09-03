import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Image, Animated, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { supabase } from '../lib/supabase';
import { avatarPublicUrl, defaultAvatarPublicUrl } from '../lib/avatarUrl';
import type { MtgColor } from '../lib/database.types';
import { MTG_COLOR_HEX } from './ColorFlag';

export type PlayerAvatarSize = 'tiny' | 'small' | 'medium' | 'large' | 'xlarge';

const SIZE_PT: Record<PlayerAvatarSize, number> = {
  tiny: 24,
  small: 32,
  medium: 48,
  large: 80,
  xlarge: 120,
};

const CORNER_RATIO = 0.15;

const NEUTRAL_BORDER = '#9CA3AF';
const PLACEHOLDER_BG = '#9CA3AF';
/** Contorno fino del anillo de colores (visible sobre W/C y fondos claros). */
const RING_OUTLINE = '#1F2937';
const RING_OUTLINE_W = 1;

const OUTSIDE_EVENT_PALETTE = [
  '#4F46E5',
  '#2563EB',
  '#059669',
  '#D97706',
  '#DC2626',
  '#7C3AED',
  '#0D9488',
  '#BE185D',
];

type AvatarImageCacheEntry = { imageUri: string | null; isShiny: boolean };
const avatarImageCache = new Map<string, AvatarImageCacheEntry>();

function hashUserIdToAvatarColor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i += 1) {
    h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return OUTSIDE_EVENT_PALETTE[h % OUTSIDE_EVENT_PALETTE.length];
}

type Props = {
  userId: string;
  participantId?: string;
  size: PlayerAvatarSize;
  withColorBorder?: boolean;
  borderWidth?: number;
  style?: StyleProp<ViewStyle>;
  /** Fuera de eventos: inicial sobre color (sin Pokémon); custom sigue mostrando imagen. */
  outsideEvent?: boolean;
  /** Si true y el participante es shiny, animación de estrellas ~1.5s. */
  showShinyAnimation?: boolean;
  /**
   * En pares 2HG: 'left' suprime el borde derecho; 'right' suprime el borde izquierdo.
   * Los colores se distribuyen sobre los 3 lados visibles.
   */
  giantSide?: 'left' | 'right';
  /** Colores pre-cargados por el llamador (evita consulta a participant_colors). */
  memberColors?: MtgColor[];
  /** Cuando true, usa member_b_rotated_avatar_id / member_b_is_shiny del participante. */
  isMemberB?: boolean;
};

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

const SHINY_STAR_COUNT = 5;

function ShinyStarBurst({ active, outerSize }: { active: boolean; outerSize: number }) {
  const opacities = useRef(Array.from({ length: SHINY_STAR_COUNT }, () => new Animated.Value(0))).current;
  const finalFlashOpacity = useRef(new Animated.Value(0)).current;
  const pad = Math.max(10, Math.round(outerSize * 0.14));
  const fontSize = Math.max(12, Math.round(outerSize * 0.22));
  const starOffsets = useMemo(
    () => [
      { top: -pad, left: outerSize / 2 - fontSize / 2 },
      { top: outerSize * 0.12, right: -pad },
      { bottom: outerSize * 0.18, right: -pad - 2 },
      { bottom: -pad + 2, left: outerSize / 2 - fontSize / 2 },
      { top: outerSize * 0.22, left: -pad - 2 },
    ],
    [outerSize, pad, fontSize]
  );
  const finalFlashOffset = useMemo(
    () => ({ top: -pad, right: -pad - 2 }),
    [pad]
  );

  useEffect(() => {
    if (!active) {
      opacities.forEach((o) => o.setValue(0));
      finalFlashOpacity.setValue(0);
      return;
    }
    const buildOrbit = () =>
      Animated.parallel(
        opacities.map((opacity, i) =>
          Animated.sequence([
            Animated.delay(i * 120),
            Animated.timing(opacity, { toValue: 1, duration: 280, useNativeDriver: true }),
            Animated.timing(opacity, { toValue: 0, duration: 520, useNativeDriver: true }),
          ])
        )
      );
    const anim = Animated.sequence([
      buildOrbit(),
      buildOrbit(),
      Animated.delay(300),
      Animated.timing(finalFlashOpacity, { toValue: 1, duration: 150, useNativeDriver: true }),
      Animated.delay(400),
      Animated.timing(finalFlashOpacity, { toValue: 0, duration: 250, useNativeDriver: true }),
    ]);
    anim.start();
    return () => {
      anim.stop();
      opacities.forEach((o) => o.setValue(0));
      finalFlashOpacity.setValue(0);
    };
  }, [active, opacities, finalFlashOpacity]);

  if (!active) return null;

  return (
    <View pointerEvents="none" style={styles.shinyBurstLayer}>
      {starOffsets.map((pos, i) => (
        <Animated.Text
          key={i}
          style={[
            styles.shinyStar,
            pos,
            { fontSize, opacity: opacities[i], zIndex: 999 },
          ]}
        >
          ⭐
        </Animated.Text>
      ))}
      <Animated.Text
        style={[
          styles.shinyStar,
          finalFlashOffset,
          { fontSize, opacity: finalFlashOpacity, zIndex: 999 },
        ]}
      >
        ⭐
      </Animated.Text>
    </View>
  );
}

/** Punto en el perímetro (t ∈ [0,1)), recorrido en sentido horario desde arriba-izquierda del tramo recto superior. */
function pointOnRoundRectPerimeter(
  t: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  br: number
): { x: number; y: number } {
  const rr = Math.min(br, bw / 2, bh / 2);
  const T = bw - 2 * rr;
  const Rgt = bh - 2 * rr;
  const A = (Math.PI / 2) * rr;
  const L = 2 * T + 2 * Rgt + 4 * A;
  if (L <= 0) return { x: bx + bw / 2, y: by + bh / 2 };
  let s = ((t % 1) + 1) % 1;
  s *= L;

  if (s < T) {
    return { x: bx + rr + s, y: by };
  }
  s -= T;
  if (s < A) {
    const ang = -Math.PI / 2 + (s / A) * (Math.PI / 2);
    const cx = bx + bw - rr;
    const cy = by + rr;
    return { x: cx + rr * Math.cos(ang), y: cy + rr * Math.sin(ang) };
  }
  s -= A;
  if (s < Rgt) {
    return { x: bx + bw, y: by + rr + s };
  }
  s -= Rgt;
  if (s < A) {
    const ang = 0 + (s / A) * (Math.PI / 2);
    const cx = bx + bw - rr;
    const cy = by + bh - rr;
    return { x: cx + rr * Math.cos(ang), y: cy + rr * Math.sin(ang) };
  }
  s -= A;
  if (s < T) {
    return { x: bx + bw - rr - s, y: by + bh };
  }
  s -= T;
  if (s < A) {
    const ang = Math.PI / 2 + (s / A) * (Math.PI / 2);
    const cx = bx + rr;
    const cy = by + bh - rr;
    return { x: cx + rr * Math.cos(ang), y: cy + rr * Math.sin(ang) };
  }
  s -= A;
  if (s < Rgt) {
    return { x: bx, y: by + bh - rr - s };
  }
  s -= Rgt;
  const ang = Math.PI + (s / A) * (Math.PI / 2);
  const cx = bx + rr;
  const cy = by + rr;
  return { x: cx + rr * Math.cos(ang), y: cy + rr * Math.sin(ang) };
}

function perimeterSegmentPath(
  bx: number,
  by: number,
  bw: number,
  bh: number,
  br: number,
  t0: number,
  t1: number,
  steps: number
): string {
  const pts: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const u = i / steps;
    const t = t0 + u * (t1 - t0);
    const p = pointOnRoundRectPerimeter(t, bx, by, bw, bh, br);
    pts.push(`${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
  }
  return `M ${pts[0]} L ${pts.slice(1).join(' L ')}`;
}

export default function PlayerAvatar({
  userId,
  participantId,
  size,
  withColorBorder = false,
  borderWidth = 3,
  style,
  outsideEvent = false,
  showShinyAnimation = false,
  giantSide,
  memberColors,
  isMemberB = false,
}: Props) {
  const diameter = SIZE_PT[size];
  const bw = withColorBorder ? borderWidth : 0;
  const outer = diameter + 2 * bw;
  const rInner = diameter * CORNER_RATIO;

  const strokeX = bw / 2;
  const strokeY = bw / 2;
  const strokeW = outer - bw;
  const strokeH = outer - bw;
  const rStroke = Math.min(rInner + bw / 2, strokeW / 2, strokeH / 2);

  /** Borde exterior del anillo de color (borde del SVG / fondo). */
  const outerRingOutlineRx = Math.min(rStroke + bw / 2, (outer - RING_OUTLINE_W) / 2);

  const _initCacheKey = !outsideEvent && participantId != null && participantId !== ''
    ? `${participantId}|${isMemberB ? 'b' : 'a'}`
    : null;
  const _initCached = _initCacheKey != null ? avatarImageCache.get(_initCacheKey) : undefined;

  const [loading, setLoading] = useState(_initCached === undefined);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [imageUri, setImageUri] = useState<string | null>(_initCached?.imageUri ?? null);
  const [borderColors, setBorderColors] = useState<MtgColor[]>([]);
  const [imageFailed, setImageFailed] = useState(false);
  const [isShiny, setIsShiny] = useState(_initCached?.isShiny ?? false);

  useEffect(() => {
    let cancelled = false;
    const key = !outsideEvent && participantId != null && participantId !== ''
      ? `${participantId}|${isMemberB ? 'b' : 'a'}`
      : null;
    const hasCached = key != null && avatarImageCache.has(key);
    if (!hasCached) {
      setLoading(true);
      setIsShiny(false);
    }
    setImageFailed(false);

    void (async () => {
      const userPromise = supabase
        .from('users')
        .select(
          `
          display_name,
          username,
          custom_avatar_path,
          default_avatars (storage_path)
        `
        )
        .eq('id', userId)
        .maybeSingle();

      const partPromise =
        !outsideEvent && participantId != null && participantId !== ''
          ? isMemberB
            ? supabase
                .from('event_participants')
                .select(
                  withColorBorder
                    ? `
                  member_b_rotated_avatar_id,
                  member_b_is_shiny,
                  default_avatars!event_participants_member_b_rotated_avatar_id_fkey (storage_path, storage_path_shiny),
                  participant_colors (color, member)
                `
                    : `
                  member_b_rotated_avatar_id,
                  member_b_is_shiny,
                  default_avatars!event_participants_member_b_rotated_avatar_id_fkey (storage_path, storage_path_shiny)
                `
                )
                .eq('id', participantId)
                .maybeSingle()
            : supabase
                .from('event_participants')
                .select(
                  withColorBorder
                    ? `
                rotated_avatar_id,
                is_shiny,
                default_avatars!event_participants_rotated_avatar_id_fkey (storage_path, storage_path_shiny),
                participant_colors (color, member)
              `
                    : `
                rotated_avatar_id,
                is_shiny,
                default_avatars!event_participants_rotated_avatar_id_fkey (storage_path, storage_path_shiny)
              `
                )
                .eq('id', participantId)
                .maybeSingle()
          : Promise.resolve({ data: null, error: null });

      const [uRes, pRes] = await Promise.all([userPromise, partPromise]);

      if (cancelled) return;

      const u = uRes.data;
      setDisplayName(u?.display_name?.trim() ?? '');
      setUsername(((u as { username?: string | null } | null)?.username ?? '').trim());

      const custom = u?.custom_avatar_path ?? null;
      const userDefaultDa = relationOne(
        u?.default_avatars as { storage_path: string } | { storage_path: string }[] | null
      );
      const userDefaultPath = userDefaultDa?.storage_path ?? null;

      let shinyFlag = false;
      let rotatedStoragePath: string | null = null;
      let colors: MtgColor[] = [];

      if (!pRes.error && pRes.data) {
        const p = pRes.data as {
          is_shiny?: boolean;
          member_b_is_shiny?: boolean | null;
          default_avatars?: {
            storage_path: string;
            storage_path_shiny?: string | null;
          } | {
            storage_path: string;
            storage_path_shiny?: string | null;
          }[] | null;
          participant_colors?: { color: string; member?: string | null } | { color: string; member?: string | null }[] | null;
        };
        shinyFlag = isMemberB ? !!p.member_b_is_shiny : !!p.is_shiny;
        setIsShiny(shinyFlag);
        const rotDa = relationOne(p.default_avatars);
        const shinyPath = rotDa?.storage_path_shiny ?? null;
        const normalPath = rotDa?.storage_path ?? null;
        rotatedStoragePath = shinyFlag && shinyPath ? shinyPath : normalPath;
        if (memberColors !== undefined) {
          colors = [...memberColors];
        } else if (withColorBorder && p.participant_colors != null) {
          const rows = Array.isArray(p.participant_colors)
            ? p.participant_colors
            : [p.participant_colors];
          colors = rows
            .filter((r) => isMemberB ? r.member === 'b' : (r.member == null || r.member === 'a'))
            .map((r) => r.color as MtgColor);
        }
      } else if (memberColors !== undefined) {
        colors = [...memberColors];
      }

      let uri: string | null = null;
      if (custom) {
        uri = avatarPublicUrl(custom);
      } else if (!outsideEvent) {
        if (participantId && rotatedStoragePath) {
          uri = defaultAvatarPublicUrl(rotatedStoragePath);
        } else if (userDefaultPath) {
          uri = defaultAvatarPublicUrl(userDefaultPath);
        }
      }

      if (key) {
        avatarImageCache.set(key, { imageUri: uri, isShiny: shinyFlag });
      }
      setImageUri(uri);
      setBorderColors(colors);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, participantId, withColorBorder, outsideEvent, memberColors, isMemberB]);

  const playShinyBurst = showShinyAnimation && isShiny && !loading && !outsideEvent;

  const initial = useMemo(() => {
    const n = (displayName.trim() || username.trim());
    if (n.length > 0) return n.slice(0, 1).toUpperCase();
    return '?';
  }, [displayName, username]);

  const outsidePhBg = useMemo(() => hashUserIdToAvatarColor(userId), [userId]);

  const showPlaceholder = loading || imageFailed || !imageUri;
  const spriteIsShiny = isShiny && !showPlaceholder && !outsideEvent && !!participantId;
  const fontSize = Math.max(10, Math.round(diameter * 0.42));

  const T_p = strokeW - 2 * rStroke;
  const Rgt_p = strokeH - 2 * rStroke;
  const A_p = (Math.PI / 2) * rStroke;
  const L_p = 2 * T_p + 2 * Rgt_p + 4 * A_p;
  const tRightStart = L_p > 0 ? T_p / L_p : 0.18;
  const tRightEnd = L_p > 0 ? (T_p + 2 * A_p + Rgt_p) / L_p : 0.5;
  const tLeftStart = L_p > 0 ? (2 * T_p + 2 * A_p + Rgt_p) / L_p : 0.68;
  const giantVisStart = giantSide === 'left' ? tRightEnd : 0;
  const giantVisLen = giantSide === 'left' ? 1 - tRightEnd + tRightStart : tLeftStart;

  const ring = withColorBorder ? (
    <Svg width={outer} height={outer} style={StyleSheet.absoluteFill}>
      {giantSide != null ? (
        // Modo gigante: dibuja los 3 lados visibles como arcos; sin contorno exterior.
        (() => {
          const n = Math.max(borderColors.length, 1);
          return Array.from({ length: n }).map((_, i) => {
            const c = borderColors[i];
            const t0 = giantVisStart + (i / n) * giantVisLen;
            const t1 = giantVisStart + ((i + 1) / n) * giantVisLen;
            const d = perimeterSegmentPath(strokeX, strokeY, strokeW, strokeH, rStroke, t0, t1, 28);
            return (
              <Path
                key={`seg-${i}`}
                d={d}
                stroke={c != null ? MTG_COLOR_HEX[c] : NEUTRAL_BORDER}
                strokeWidth={bw}
                fill="none"
                strokeLinecap="butt"
                strokeLinejoin="miter"
              />
            );
          });
        })()
      ) : borderColors.length === 0 || borderColors.length === 1 ? (
        <Rect
          x={strokeX}
          y={strokeY}
          width={strokeW}
          height={strokeH}
          rx={rStroke}
          ry={rStroke}
          fill="none"
          stroke={
            borderColors.length === 1 ? MTG_COLOR_HEX[borderColors[0]] : NEUTRAL_BORDER
          }
          strokeWidth={bw}
        />
      ) : (
        borderColors.map((c, i) => {
          const n = borderColors.length;
          const t0 = i / n;
          const t1 = (i + 1) / n;
          const d = perimeterSegmentPath(
            strokeX,
            strokeY,
            strokeW,
            strokeH,
            rStroke,
            t0,
            t1,
            28
          );
          return (
            <Path
              key={`seg-${i}`}
              d={d}
              stroke={MTG_COLOR_HEX[c]}
              strokeWidth={bw}
              fill="none"
              strokeLinecap="butt"
              strokeLinejoin="miter"
            />
          );
        })
      )}
      {/* Contorno exterior: mismo perímetro que el borde externo del anillo de color. */}
      {giantSide == null ? (
        <Rect
          x={RING_OUTLINE_W / 2}
          y={RING_OUTLINE_W / 2}
          width={outer - RING_OUTLINE_W}
          height={outer - RING_OUTLINE_W}
          rx={outerRingOutlineRx}
          ry={outerRingOutlineRx}
          fill="none"
          stroke={RING_OUTLINE}
          strokeWidth={RING_OUTLINE_W}
        />
      ) : null}
    </Svg>
  ) : null;

  return (
    <View style={[styles.root, { width: outer, height: outer }, style]}>
      {ring}
      <View
        style={[
          styles.imageClip,
          {
            left: bw,
            top: bw,
            width: diameter,
            height: diameter,
            borderRadius: rInner,
            zIndex: 1,
            ...(bw > 0
              ? {
                  borderWidth: RING_OUTLINE_W,
                  borderColor: RING_OUTLINE,
                }
              : {}),
          },
        ]}
      >
        {showPlaceholder ? (
          <View
            style={[
              styles.ph,
              {
                width: diameter,
                height: diameter,
                borderRadius: rInner,
                backgroundColor: outsideEvent ? outsidePhBg : PLACEHOLDER_BG,
              },
            ]}
          >
            <Text style={[styles.phText, { fontSize }]}>{loading ? '?' : initial}</Text>
          </View>
        ) : (
          <View
            style={[
              styles.spriteFrame,
              {
                width: diameter,
                height: diameter,
                borderRadius: rInner,
              },
            ]}
          >
            <Image
              source={{ uri: imageUri as string }}
              style={
                spriteIsShiny
                  ? {
                      width: diameter,
                      height: diameter,
                      backgroundColor: '#f3f4f6',
                      transform: [{ scale: 1.3 }],
                    }
                  : {
                      width: diameter,
                      height: diameter,
                      borderRadius: rInner,
                      backgroundColor: '#f3f4f6',
                      transform: [{ scale: 1.3 }],
                    }
              }
              resizeMode={spriteIsShiny ? 'contain' : 'cover'}
              onError={() => setImageFailed(true)}
            />
          </View>
        )}
      </View>
      <ShinyStarBurst active={playShinyBurst} outerSize={outer} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    overflow: 'visible',
  },
  imageClip: {
    position: 'absolute',
    overflow: 'hidden',
    backgroundColor: 'transparent',
  },
  spriteFrame: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: '#f3f4f6',
  },
  ph: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  phText: {
    fontWeight: '700',
    color: '#fff',
  },
  shinyBurstLayer: {
    ...StyleSheet.absoluteFill,
    overflow: 'visible',
    zIndex: 999,
  },
  shinyStar: {
    position: 'absolute',
    textAlign: 'center',
  },
});

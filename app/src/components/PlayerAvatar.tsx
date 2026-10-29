import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Image, Animated, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { supabase } from '../lib/supabase';
import { avatarPublicUrl, defaultAvatarPublicUrl } from '../lib/avatarUrl';
import type { MtgColor } from '../lib/database.types';
import { MTG_COLOR_HEX } from './ColorFlag';
import { useTheme } from '../theme';
import { DITTO_TRANSFORM_DURATION_MS } from '../lib/dittoMirror';

export type PlayerAvatarSize = 'tiny' | 'small' | 'medium' | 'large' | 'xlarge';

const SIZE_PT: Record<PlayerAvatarSize, number> = {
  tiny: 24,
  small: 32,
  medium: 48,
  large: 80,
  xlarge: 120,
};

const CORNER_RATIO = 0.15;

/** Anillo neutro (jugador sin colores declarados): es contenido del anillo, igual en ambos modos. */
const NEUTRAL_BORDER = '#9CA3AF';
/**
 * Contorno fino del anillo de colores: toma `colors.text` del tema (oscuro en claro, para que W/C se
 * vean; claro en oscuro, para que el anillo B no se pierda contra el fondo).
 * Nota: el fondo #f3f4f6 detrás del sprite de Pokémon (`spriteFrame` y su `Image`) es FIJO en ambos
 * modos a propósito: los sprites están dibujados para fondo claro.
 */
const RING_OUTLINE_W = 1;

/**
 * Color de identidad del jugador fuera de eventos (se elige por hash del userId): es contenido, no UI
 * de tema, así que es igual en ambos modos (la inicial blanca `phText` contrasta sobre todos).
 */
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
  /**
   * Diámetro real en puntos; pisa al de `size`. Para espacios que no coinciden con ninguno de los
   * tamaños fijos (p. ej. el cuadro de la Copa): el sprite se dibuja a ese tamaño, sin escalar la vista.
   */
  diameter?: number;
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
  /**
   * Ditto en el life tracker: el sprite (y su estado shiny) se resuelve desde este otro participante/miembro en
   * vez del propio. El anillo de colores sigue siendo el del participante real. Sólo cuando se pasa.
   */
  mirrorOf?: { participantId: string; isMemberB?: boolean };
  /**
   * Con `mirrorOf`: si el espejo aparece estando ya montado el avatar con otro sprite, hace la transformación
   * (fundido cruzado + squish + destello) en vez de cambiar de golpe. Sin esto el cambio es directo.
   */
  animateMirror?: boolean;
};

/** Clave del caché de imagen; el espejo va en la clave para no pisar el sprite del participante real. */
function avatarCacheKey(
  participantId: string | undefined,
  isMemberB: boolean,
  mirrorPid: string | undefined,
  mirrorIsB: boolean
): string | null {
  if (participantId == null || participantId === '') return null;
  const base = `${participantId}|${isMemberB ? 'b' : 'a'}`;
  return mirrorPid ? `${base}>${mirrorPid}|${mirrorIsB ? 'b' : 'a'}` : base;
}

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
  diameter: diameterProp,
  outsideEvent = false,
  showShinyAnimation = false,
  giantSide,
  memberColors,
  isMemberB = false,
  mirrorOf,
  animateMirror = false,
}: Props) {
  const mirrorPid = mirrorOf?.participantId || undefined;
  const mirrorIsB = !!mirrorOf?.isMemberB;
  const { colors } = useTheme();
  const diameter = diameterProp ?? SIZE_PT[size];
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

  const _initCacheKey = !outsideEvent
    ? avatarCacheKey(participantId, isMemberB, mirrorPid, mirrorIsB)
    : null;
  const _initCached = _initCacheKey != null ? avatarImageCache.get(_initCacheKey) : undefined;

  const [loading, setLoading] = useState(_initCached === undefined);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [imageUri, setImageUri] = useState<string | null>(_initCached?.imageUri ?? null);
  const [borderColors, setBorderColors] = useState<MtgColor[]>([]);
  const [imageFailed, setImageFailed] = useState(false);
  const [isShiny, setIsShiny] = useState(_initCached?.isShiny ?? false);
  // Transformación de Ditto: sprite anterior (debajo) mientras el nuevo aparece por fundido.
  const [transitionFrom, setTransitionFrom] = useState<{ uri: string; shiny: boolean } | null>(null);
  const [mirrorBurst, setMirrorBurst] = useState(false);
  const displayedRef = useRef<{ uri: string; shiny: boolean } | null>(null);
  const morphFade = useRef(new Animated.Value(0)).current;
  const morphScaleX = useRef(new Animated.Value(1)).current;
  const morphScaleY = useRef(new Animated.Value(1)).current;
  const morphFlash = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let cancelled = false;
    const key = !outsideEvent ? avatarCacheKey(participantId, isMemberB, mirrorPid, mirrorIsB) : null;
    const hasCached = key != null && avatarImageCache.has(key);
    // Si va a haber transformación, se sigue viendo el sprite anterior mientras carga el nuevo (sin "?").
    const keepOld = animateMirror && !!mirrorPid && displayedRef.current != null;
    if (!hasCached && !keepOld) {
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

      const fetchPart = (pid: string, memberB: boolean, withColors: boolean) =>
        memberB
          ? supabase
              .from('event_participants')
              .select(
                withColors
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
              .eq('id', pid)
              .maybeSingle()
          : supabase
              .from('event_participants')
              .select(
                withColors
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
              .eq('id', pid)
              .maybeSingle();

      const partPromise =
        !outsideEvent && participantId != null && participantId !== ''
          ? fetchPart(participantId, isMemberB, withColorBorder)
          : Promise.resolve({ data: null, error: null });

      // Espejo (Ditto en el life tracker): sólo el sprite y el shiny salen de otro participante; los colores no.
      const mirrorPromise =
        !outsideEvent && participantId != null && participantId !== '' && mirrorPid
          ? fetchPart(mirrorPid, mirrorIsB, false)
          : Promise.resolve({ data: null, error: null });

      const [uRes, pRes, mRes] = await Promise.all([userPromise, partPromise, mirrorPromise]);

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
        let spriteDa = relationOne(p.default_avatars);
        if (mirrorPid && !mRes.error && mRes.data) {
          // Si el espejo no tiene Pokémon (o la consulta falla) se queda el sprite propio.
          const m = mRes.data as unknown as typeof p;
          const mirrorDa = relationOne(m.default_avatars);
          if (mirrorDa) {
            spriteDa = mirrorDa;
            shinyFlag = mirrorIsB ? !!m.member_b_is_shiny : !!m.is_shiny;
          }
        }
        setIsShiny(shinyFlag);
        const rotDa = spriteDa;
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

      // Transformación Ditto -> sprite del rival: sólo si el espejo recién aparece y el sprite realmente cambia.
      const from = displayedRef.current;
      const willMorph = animateMirror && !!mirrorPid && !!uri && !!from && from.uri !== uri;
      if (willMorph && uri && from) {
        try {
          await Image.prefetch(uri);
        } catch {
          // Si falla el prefetch igual se transforma; la imagen carga mientras se funde.
        }
        if (cancelled) return;
        morphFade.setValue(0);
        morphScaleX.setValue(1);
        morphScaleY.setValue(1);
        morphFlash.setValue(0);
        setTransitionFrom(from);
        const k = DITTO_TRANSFORM_DURATION_MS / 700;
        const ms = (n: number) => Math.round(n * k);
        Animated.parallel([
          // Fundido cruzado en el momento del destello (150-350 ms).
          Animated.sequence([
            Animated.delay(ms(150)),
            Animated.timing(morphFade, { toValue: 1, duration: ms(200), useNativeDriver: true }),
          ]),
          // Squish: se achica a lo ancho / estira a lo alto, rebota al revés y vuelve.
          Animated.sequence([
            Animated.timing(morphScaleX, { toValue: 0.8, duration: ms(200), useNativeDriver: true }),
            Animated.timing(morphScaleX, { toValue: 1.12, duration: ms(250), useNativeDriver: true }),
            Animated.timing(morphScaleX, { toValue: 1, duration: ms(250), useNativeDriver: true }),
          ]),
          Animated.sequence([
            Animated.timing(morphScaleY, { toValue: 1.15, duration: ms(200), useNativeDriver: true }),
            Animated.timing(morphScaleY, { toValue: 0.9, duration: ms(250), useNativeDriver: true }),
            Animated.timing(morphScaleY, { toValue: 1, duration: ms(250), useNativeDriver: true }),
          ]),
          // Destello blanco breve.
          Animated.sequence([
            Animated.timing(morphFlash, { toValue: 0.95, duration: ms(150), useNativeDriver: true }),
            Animated.delay(ms(100)),
            Animated.timing(morphFlash, { toValue: 0, duration: ms(250), useNativeDriver: true }),
          ]),
        ]).start(({ finished }) => {
          if (!finished) return;
          setTransitionFrom(null);
          // Si el sprite copiado es shiny, las estrellas salen recién ahora, ya transformado.
          if (shinyFlag) setMirrorBurst(true);
        });
      }
      setImageUri(uri);
      setBorderColors(colors);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, participantId, withColorBorder, outsideEvent, memberColors, isMemberB, mirrorPid, mirrorIsB, animateMirror]);

  useEffect(() => {
    if (!mirrorBurst) return undefined;
    const id = setTimeout(() => setMirrorBurst(false), 4000);
    return () => clearTimeout(id);
  }, [mirrorBurst]);

  const playShinyBurst =
    (showShinyAnimation && isShiny && !loading && !outsideEvent && transitionFrom == null) || mirrorBurst;

  const initial = useMemo(() => {
    const n = (displayName.trim() || username.trim());
    if (n.length > 0) return n.slice(0, 1).toUpperCase();
    return '?';
  }, [displayName, username]);

  const outsidePhBg = useMemo(() => hashUserIdToAvatarColor(userId), [userId]);

  const showPlaceholder = loading || imageFailed || !imageUri;
  const spriteIsShiny = isShiny && !showPlaceholder && !outsideEvent && !!participantId;
  useEffect(() => {
    if (!showPlaceholder && imageUri) displayedRef.current = { uri: imageUri, shiny: spriteIsShiny };
  }, [showPlaceholder, imageUri, spriteIsShiny]);
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
          stroke={colors.text}
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
                  borderColor: colors.text,
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
                backgroundColor: outsideEvent ? outsidePhBg : colors.textMuted,
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
            {(() => {
              const sprite = (uri: string, shiny: boolean) => (
                <Image
                  source={{ uri }}
                  style={
                    shiny
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
                  resizeMode={shiny ? 'contain' : 'cover'}
                  onError={() => setImageFailed(true)}
                />
              );
              if (transitionFrom == null) return sprite(imageUri as string, spriteIsShiny);
              return (
                <Animated.View
                  style={{
                    width: diameter,
                    height: diameter,
                    transform: [{ scaleX: morphScaleX }, { scaleY: morphScaleY }],
                  }}
                >
                  {sprite(transitionFrom.uri, transitionFrom.shiny)}
                  <Animated.View style={[StyleSheet.absoluteFill, { opacity: morphFade }]}>
                    {sprite(imageUri as string, spriteIsShiny)}
                  </Animated.View>
                  <Animated.View
                    pointerEvents="none"
                    style={[StyleSheet.absoluteFill, { backgroundColor: '#fff', opacity: morphFlash }]}
                  />
                </Animated.View>
              );
            })()}
          </View>
        )}
      </View>
      <ShinyStarBurst active={playShinyBurst} outerSize={outer} />
    </View>
  );
}

export type PreloadAvatarSeat = { participantId: string; userId: string; member: 'a' | 'b' };

type PreloadDefaultAvatar = { storage_path: string; storage_path_shiny?: string | null };
type PreloadAvatarRow = {
  is_shiny?: boolean;
  member_b_is_shiny?: boolean | null;
  default_avatars?: PreloadDefaultAvatar | PreloadDefaultAvatar[] | null;
};

/** Resuelve el sprite de un participante (sin colores ni espejo) y lo deja en `avatarImageCache`, con la imagen ya precargada. */
async function preloadAvatar(seat: PreloadAvatarSeat): Promise<void> {
  const isB = seat.member === 'b';
  const key = avatarCacheKey(seat.participantId, isB, undefined, false);
  if (key == null) return;
  let entry = avatarImageCache.get(key);
  if (!entry) {
    const userPromise = supabase
      .from('users')
      .select('custom_avatar_path, default_avatars (storage_path)')
      .eq('id', seat.userId)
      .maybeSingle();
    const partPromise = isB
      ? supabase
          .from('event_participants')
          .select(
            'member_b_rotated_avatar_id, member_b_is_shiny, default_avatars!event_participants_member_b_rotated_avatar_id_fkey (storage_path, storage_path_shiny)'
          )
          .eq('id', seat.participantId)
          .maybeSingle()
      : supabase
          .from('event_participants')
          .select(
            'rotated_avatar_id, is_shiny, default_avatars!event_participants_rotated_avatar_id_fkey (storage_path, storage_path_shiny)'
          )
          .eq('id', seat.participantId)
          .maybeSingle();
    const [uRes, pRes] = await Promise.all([userPromise, partPromise]);
    // Con un error no se cachea nada: el avatar real lo vuelve a pedir.
    if (uRes.error || pRes.error) return;
    const u = uRes.data as unknown as { custom_avatar_path?: string | null; default_avatars?: { storage_path: string } | { storage_path: string }[] | null } | null;
    const p = pRes.data as unknown as PreloadAvatarRow | null;
    const shiny = isB ? !!p?.member_b_is_shiny : !!p?.is_shiny;
    const da = relationOne(p?.default_avatars);
    const rotatedPath = shiny && da?.storage_path_shiny ? da.storage_path_shiny : (da?.storage_path ?? null);
    const userDefaultPath = relationOne(u?.default_avatars)?.storage_path ?? null;
    let uri: string | null = null;
    if (u?.custom_avatar_path) uri = avatarPublicUrl(u.custom_avatar_path);
    else if (rotatedPath) uri = defaultAvatarPublicUrl(rotatedPath);
    else if (userDefaultPath) uri = defaultAvatarPublicUrl(userDefaultPath);
    entry = { imageUri: uri, isShiny: shiny };
    avatarImageCache.set(key, entry);
  }
  if (entry.imageUri) {
    try {
      await Image.prefetch(entry.imageUri);
    } catch {
      // Si falla el prefetch la imagen carga igual al mostrarse.
    }
  }
}

/**
 * Precarga los avatares de todos los que se sientan (datos + imagen) antes de la ruleta. Nunca rechaza y no espera más de
 * `timeoutMs`: si algún avatar tarda, la ruleta arranca igual con lo que haya.
 */
export async function preloadAvatars(seats: PreloadAvatarSeat[], timeoutMs = 2000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([Promise.all(seats.map((s) => preloadAvatar(s).catch(() => undefined))), timeout]);
  if (timer) clearTimeout(timer);
}

/**
 * Avatar liviano para la ruleta: se dibuja de forma SÍNCRONA desde `avatarImageCache` (sin efectos ni consultas), así que
 * cambia en el mismo render que el nombre. Misma apariencia que PlayerAvatar sin anillo de colores. Sin entrada en el
 * caché muestra "?" (la ruleta precarga todo antes de arrancar).
 */
export function RouletteAvatar({
  participantId,
  isMemberB,
  diameter,
  letter,
}: {
  participantId: string;
  isMemberB: boolean;
  diameter: number;
  /** Inicial que se muestra si el jugador no tiene imagen. */
  letter: string;
}) {
  const { colors } = useTheme();
  const key = avatarCacheKey(participantId, isMemberB, undefined, false);
  const entry = key != null ? avatarImageCache.get(key) : undefined;
  const rInner = diameter * CORNER_RATIO;
  const shiny = !!entry?.isShiny;
  const clip = { left: 0, top: 0, width: diameter, height: diameter, borderRadius: rInner, zIndex: 1 };
  return (
    <View style={{ width: diameter, height: diameter }}>
      <View style={[styles.imageClip, clip]}>
        {entry?.imageUri ? (
          <View style={[styles.spriteFrame, { width: diameter, height: diameter, borderRadius: rInner }]}>
            <Image
              source={{ uri: entry.imageUri }}
              fadeDuration={0}
              style={
                shiny
                  ? { width: diameter, height: diameter, backgroundColor: '#f3f4f6', transform: [{ scale: 1.3 }] }
                  : { width: diameter, height: diameter, borderRadius: rInner, backgroundColor: '#f3f4f6', transform: [{ scale: 1.3 }] }
              }
              resizeMode={shiny ? 'contain' : 'cover'}
            />
          </View>
        ) : (
          <View style={[styles.ph, { width: diameter, height: diameter, borderRadius: rInner, backgroundColor: colors.textMuted }]}>
            <Text style={[styles.phText, { fontSize: Math.max(10, Math.round(diameter * 0.42)) }]}>{entry ? letter : '?'}</Text>
          </View>
        )}
      </View>
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

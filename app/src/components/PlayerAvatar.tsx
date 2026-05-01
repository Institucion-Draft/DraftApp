import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Image, type StyleProp, type ViewStyle } from 'react-native';
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

type Props = {
  userId: string;
  participantId?: string;
  size: PlayerAvatarSize;
  withColorBorder?: boolean;
  borderWidth?: number;
  style?: StyleProp<ViewStyle>;
};

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
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

  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [borderColors, setBorderColors] = useState<MtgColor[]>([]);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setImageFailed(false);

    void (async () => {
      const userPromise = supabase
        .from('users')
        .select(
          `
          display_name,
          custom_avatar_path,
          default_avatars (storage_path)
        `
        )
        .eq('id', userId)
        .maybeSingle();

      const partPromise =
        participantId != null && participantId !== ''
          ? supabase
              .from('event_participants')
              .select(
                withColorBorder
                  ? `
                rotated_avatar_id,
                default_avatars (storage_path),
                participant_colors (color)
              `
                  : `
                rotated_avatar_id,
                default_avatars (storage_path)
              `
              )
              .eq('id', participantId)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null });

      const [uRes, pRes] = await Promise.all([userPromise, partPromise]);

      if (cancelled) return;

      const u = uRes.data;
      setDisplayName(u?.display_name?.trim() ?? '');

      const custom = u?.custom_avatar_path ?? null;
      const userDefaultDa = relationOne(
        u?.default_avatars as { storage_path: string } | { storage_path: string }[] | null
      );
      const userDefaultPath = userDefaultDa?.storage_path ?? null;

      let rotatedStoragePath: string | null = null;
      let colors: MtgColor[] = [];

      if (!pRes.error && pRes.data) {
        const p = pRes.data as {
          default_avatars?: { storage_path: string } | { storage_path: string }[] | null;
          participant_colors?: { color: string } | { color: string }[] | null;
        };
        const rotDa = relationOne(p.default_avatars);
        rotatedStoragePath = rotDa?.storage_path ?? null;
        if (withColorBorder && p.participant_colors != null) {
          const rows = Array.isArray(p.participant_colors)
            ? p.participant_colors
            : [p.participant_colors];
          colors = rows.map((r) => r.color as MtgColor);
        }
      }

      let uri: string | null = null;
      if (custom) {
        uri = avatarPublicUrl(custom);
      } else if (participantId && rotatedStoragePath) {
        uri = defaultAvatarPublicUrl(rotatedStoragePath);
      } else if (userDefaultPath) {
        uri = defaultAvatarPublicUrl(userDefaultPath);
      }

      setImageUri(uri);
      setBorderColors(colors);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, participantId, withColorBorder]);

  const initial = useMemo(() => {
    const n = displayName.trim();
    if (n.length > 0) return n.slice(0, 1).toUpperCase();
    return '?';
  }, [displayName]);

  const showPlaceholder = loading || imageFailed || !imageUri;
  const fontSize = Math.max(10, Math.round(diameter * 0.42));

  const ring = withColorBorder ? (
    <Svg width={outer} height={outer} style={StyleSheet.absoluteFill}>
      {borderColors.length === 0 || borderColors.length === 1 ? (
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
    </Svg>
  ) : null;

  return (
    <View style={[{ width: outer, height: outer }, style]}>
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
              },
            ]}
          >
            <Text style={[styles.phText, { fontSize }]}>{loading ? '?' : initial}</Text>
          </View>
        ) : (
          <Image
            source={{ uri: imageUri as string }}
            style={{
              width: diameter,
              height: diameter,
              borderRadius: rInner,
              backgroundColor: '#f3f4f6',
              transform: [{ scale: 1.3 }],
            }}
            resizeMode="cover"
            onError={() => setImageFailed(true)}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  imageClip: {
    position: 'absolute',
    overflow: 'hidden',
    backgroundColor: 'transparent',
  },
  ph: {
    backgroundColor: PLACEHOLDER_BG,
    alignItems: 'center',
    justifyContent: 'center',
  },
  phText: {
    fontWeight: '700',
    color: '#fff',
  },
});

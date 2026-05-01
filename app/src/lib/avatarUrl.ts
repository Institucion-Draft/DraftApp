import { supabase, supabaseUrl } from './supabase';

/**
 * Bucket público para rutas guardadas en avatar_path / custom_avatar_path.
 * Si en tu proyecto el bucket tiene otro nombre, cambiá esta constante.
 */
const AVATAR_BUCKET = 'avatars';

/**
 * `default_avatars.storage_path` incluye el prefijo del bucket (ej. `default-avatars/unown.png`).
 * URL pública: `{origin}/storage/v1/object/public/{storage_path}` sin volver a prefijar el bucket.
 */
export function avatarPublicUrl(
  relativeOrAbsolute: string | null | undefined
): string | null {
  if (!relativeOrAbsolute) return null;
  if (/^https?:\/\//i.test(relativeOrAbsolute)) return relativeOrAbsolute;
  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(relativeOrAbsolute);
  return data.publicUrl;
}

export function defaultAvatarPublicUrl(
  relativeOrAbsolute: string | null | undefined
): string | null {
  if (!relativeOrAbsolute) return null;
  if (/^https?:\/\//i.test(relativeOrAbsolute)) return relativeOrAbsolute;
  const base = supabaseUrl.replace(/\/$/, '');
  const path = relativeOrAbsolute.replace(/^\/+/, '');
  const encoded = path
    .split('/')
    .filter((seg) => seg.length > 0)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `${base}/storage/v1/object/public/${encoded}`;
}

import { supabase } from './supabase';

/**
 * Bucket público para rutas guardadas en avatar_path / custom_avatar_path.
 * Si en tu proyecto el bucket tiene otro nombre, cambiá esta constante.
 */
const AVATAR_BUCKET = 'avatars';

export function avatarPublicUrl(
  relativeOrAbsolute: string | null | undefined
): string | null {
  if (!relativeOrAbsolute) return null;
  if (/^https?:\/\//i.test(relativeOrAbsolute)) return relativeOrAbsolute;
  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(relativeOrAbsolute);
  return data.publicUrl;
}

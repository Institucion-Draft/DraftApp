-- =====================================================================
-- Canje de código de invitación (RPC atómica, bypass RLS controlado)
-- Migration: 0002_redeem_invite_code
-- =====================================================================
CREATE OR REPLACE FUNCTION public.redeem_invite_code(p_code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_inv   public.workspace_invites%rowtype;
  v_now   timestamptz := now();
  v_code  text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Tenés que iniciar sesión para canjear un código.';
  END IF;

  IF p_code IS NULL OR btrim(p_code) = '' THEN
    RAISE EXCEPTION 'Ingresá un código de invitación.';
  END IF;

  v_code := upper(regexp_replace(trim(p_code), '[^A-Z0-9]', '', 'g'));
  IF v_code !~ '^[A-Z0-9]{6,10}$' THEN
    RAISE EXCEPTION 'Formato de código inválido.';
  END IF;

  SELECT wi.*
  INTO v_inv
  FROM public.workspace_invites wi
  WHERE wi.code = v_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No encontramos un código con ese valor.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.workspaces w
    WHERE w.id = v_inv.workspace_id
      AND w.deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Este workspace ya no está disponible.';
  END IF;

  IF v_inv.is_revoked THEN
    RAISE EXCEPTION 'Este código ya no es válido.';
  END IF;

  IF v_inv.expires_at IS NOT NULL AND v_inv.expires_at <= v_now THEN
    RAISE EXCEPTION 'Este código expiró.';
  END IF;

  IF v_inv.max_uses IS NOT NULL AND v_inv.uses_count >= v_inv.max_uses THEN
    RAISE EXCEPTION 'Este código ya no tiene usos disponibles.';
  END IF;

  -- Ya es miembro: idempotente, no incrementa usos
  IF EXISTS (
    SELECT 1
    FROM public.workspace_members wm
    WHERE wm.workspace_id = v_inv.workspace_id
      AND wm.user_id = v_uid
  ) THEN
    RETURN v_inv.workspace_id;
  END IF;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_inv.workspace_id, v_uid, 'member');

  UPDATE public.workspace_invites
  SET uses_count = uses_count + 1
  WHERE id = v_inv.id;

  RETURN v_inv.workspace_id;
END;
$$;

COMMENT ON FUNCTION public.redeem_invite_code(text) IS
  'Canjea un código de invitación válido: agrega al usuario como member e incrementa uses_count. Devuelve el workspace_id.';

REVOKE ALL ON FUNCTION public.redeem_invite_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invite_code(text) TO authenticated;
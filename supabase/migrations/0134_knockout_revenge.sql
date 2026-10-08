-- 0134_knockout_revenge.sql
-- Copa (sólo llaves): venganzas entre cualquier par de jugadores del evento, incluso entre dos que nunca
-- se enfrentaron en el cuadro (por ejemplo, dos eliminados que esperan).
--
-- Reglas de negocio:
--   * La venganza nunca es oficial, no suma puntos ni logros, y no cambia el cuadro ni el podio.
--   * Una partida que arranca como venganza termina como venganza (match_type no cambia nunca).
--   * Se juega mientras el evento está en juego (status = 'playing'), sin esperar a que termine la copa.
--
-- Hasta ahora una venganza necesitaba una fila de pairings; en la Copa sólo existen las de los cruces de
-- llaves (stage = 'bracket'), y un jugador no puede insertar pairings (política sólo para quien administra).
--
-- Alcance:
--   1. pairings_stage_valid admite también 'revenge' (zone, interzonal, bracket, revenge o null).
--   2. ensure_revenge_pairing(p_event_id, p_participant_a, p_participant_b) -> uuid (security definer):
--      ordena los dos ids (a < b); valida que el evento sea una Copa (competition_format = 'knockout') en
--      status 'playing'; que los dos sean role = 'player' del evento y no tengan left_event_at; que quien
--      llama sea uno de los dos jugadores o quien administra el evento (can_manage_event); y que NO exista
--      un cruce de llaves pendiente entre ellos (fila de event_tiebreak_bracket_matches del grupo
--      knockout_bracket vigente, entre esos dos, sin winner_participant_id). Hace
--      insert ... on conflict (event_id, participant_a_id, participant_b_id) do nothing y devuelve el id
--      del pairing existente o del nuevo; stage = 'revenge' sólo si lo crea. Execute sólo para authenticated.
--   3. knockout_materialize: cuerpo de 0130 idéntico, más un update que deja el pairing del cruce con
--      stage = 'bracket' cuando ya existía como 'revenge' (porque hubo una venganza antes del cruce).
--   4. classify_match_type: cuerpo de 0001 (la única migración que la define) con una rama nueva: en eventos
--      Copa, todo match 'draft' o 'final' se convierte en 'revenge'. 'tiebreak' no se toca.
--
-- NO toca eventos ni pairings existentes: sólo agrega un valor permitido, una función y reemplaza dos.
-- Los pairings de Copa ya sorteados siguen con stage = 'bracket'.

-- ===========================================================================
-- 1. pairings_stage_valid: se agrega 'revenge'
-- ===========================================================================
alter table public.pairings
  drop constraint if exists pairings_stage_valid;

alter table public.pairings
  add constraint pairings_stage_valid
    check (stage is null or stage in ('zone', 'interzonal', 'bracket', 'revenge'));

-- ===========================================================================
-- 2. ensure_revenge_pairing
-- ===========================================================================
create or replace function public.ensure_revenge_pairing(
  p_event_id uuid,
  p_participant_a uuid,
  p_participant_b uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event record;
  v_a uuid;
  v_b uuid;
  v_group_id uuid;
  v_pairing_id uuid;
begin
  if p_participant_a is null or p_participant_b is null or p_participant_a = p_participant_b then
    raise exception 'ensure_revenge_pairing: hay que elegir dos jugadores distintos.'
      using errcode = '22023';
  end if;

  -- pairings_participants_ordered exige participant_a_id < participant_b_id.
  v_a := least(p_participant_a, p_participant_b);
  v_b := greatest(p_participant_a, p_participant_b);

  select de.id, de.workspace_id, de.competition_format, de.status
  into v_event
  from public.draft_events de
  where de.id = p_event_id and de.deleted_at is null;

  if v_event.id is null then
    raise exception 'ensure_revenge_pairing: el evento no existe.';
  end if;

  if v_event.competition_format <> 'knockout' then
    raise exception 'ensure_revenge_pairing: el evento no es una Copa (sólo llaves).';
  end if;

  if v_event.status <> 'playing' then
    raise exception 'ensure_revenge_pairing: las venganzas se juegan mientras el evento está en juego (el evento está en %).', v_event.status;
  end if;

  -- Los dos tienen que ser jugadores de este evento y no haberse ido.
  if (
    select count(*)
    from public.event_participants ep
    where ep.event_id = p_event_id
      and ep.id in (v_a, v_b)
      and ep.role = 'player'
      and ep.left_event_at is null
  ) <> 2 then
    raise exception 'ensure_revenge_pairing: los dos tienen que ser jugadores del evento y no haberse ido.'
      using errcode = '22023';
  end if;

  -- Quien llama: uno de los dos jugadores, o quien administra el evento.
  if not (
    public.can_manage_event(v_event.workspace_id, v_event.id)
    or exists (
      select 1
      from public.event_participants ep
      where ep.id in (v_a, v_b) and ep.user_id = auth.uid()
    )
  ) then
    raise exception 'ensure_revenge_pairing: no tenés permisos para armar esta venganza.'
      using errcode = '42501';
  end if;

  -- Cruce de llaves pendiente entre los dos: ahí corre la serie de llaves, no una venganza.
  select g.id into v_group_id
  from public.event_tiebreak_groups g
  where g.event_id = p_event_id and g.group_origin = 'knockout_bracket' and g.status <> 'superseded'
  limit 1;

  if v_group_id is not null and exists (
    select 1
    from public.event_tiebreak_bracket_matches bm
    where bm.group_id = v_group_id
      and bm.winner_participant_id is null
      and least(bm.participant_a_id, bm.participant_b_id) = v_a
      and greatest(bm.participant_a_id, bm.participant_b_id) = v_b
  ) then
    raise exception 'ensure_revenge_pairing: tienen un cruce de llaves pendiente entre ellos.'
      using errcode = '23514';
  end if;

  insert into public.pairings (event_id, participant_a_id, participant_b_id, stage)
  values (p_event_id, v_a, v_b, 'revenge')
  on conflict (event_id, participant_a_id, participant_b_id) do nothing
  returning id into v_pairing_id;

  if v_pairing_id is null then
    -- Ya existía (un cruce de llaves resuelto o una venganza anterior): se reutiliza, sin tocar su stage.
    select p.id into v_pairing_id
    from public.pairings p
    where p.event_id = p_event_id and p.participant_a_id = v_a and p.participant_b_id = v_b;
  end if;

  return v_pairing_id;
end;
$$;

revoke execute on function public.ensure_revenge_pairing(uuid, uuid, uuid) from public, anon;
grant execute on function public.ensure_revenge_pairing(uuid, uuid, uuid) to authenticated;

-- ===========================================================================
-- 3. knockout_materialize: el pairing de un cruce que ya existía como venganza pasa a 'bracket'
--    (cuerpo de 0130; el único agregado es el update marcado en el cuerpo)
-- ===========================================================================
create or replace function public.knockout_materialize(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_slot record;
  v_current uuid;
  v_bm_id uuid;
  v_pairing_id uuid;
  v_pa uuid;
  v_pb uuid;
  v_a_left boolean;
  v_b_left boolean;
  v_progress boolean;
begin
  select g.event_id into v_event_id from public.event_tiebreak_groups g where g.id = p_group_id;
  if v_event_id is null then
    return;
  end if;

  loop
    v_progress := false;

    for v_slot in
      select s.id, s.round_key, s.participant_a_id, s.participant_b_id
      from public.knockout_slots s
      where s.group_id = p_group_id
        and not s.is_bye
        and s.bracket_match_id is null
        and s.participant_a_id is not null
        and s.participant_b_id is not null
      order by case s.round_key
                 when 'round_of_16' then 1 when 'quarter' then 2 when 'semi' then 3
                 when 'final' then 4 else 5 end,
               s."position"
    loop
      -- Un walkover anidado puede haber materializado este slot mientras iterábamos.
      select s.bracket_match_id into v_current
      from public.knockout_slots s where s.id = v_slot.id for update;
      if v_current is not null then
        continue;
      end if;

      insert into public.event_tiebreak_bracket_matches
        (group_id, bracket_phase, participant_a_id, participant_b_id)
      values (p_group_id, v_slot.round_key, v_slot.participant_a_id, v_slot.participant_b_id)
      returning id into v_bm_id;

      v_pa := least(v_slot.participant_a_id, v_slot.participant_b_id);
      v_pb := greatest(v_slot.participant_a_id, v_slot.participant_b_id);

      insert into public.pairings (event_id, participant_a_id, participant_b_id, stage)
      values (v_event_id, v_pa, v_pb, 'bracket')
      on conflict (event_id, participant_a_id, participant_b_id) do nothing;

      select p.id into v_pairing_id
      from public.pairings p
      where p.event_id = v_event_id and p.participant_a_id = v_pa and p.participant_b_id = v_pb;

      -- Si el par ya tenía un pairing de venganza (ensure_revenge_pairing, 0134), pasa a ser el pairing
      -- del cruce de llaves. Las partidas de venganza que ya tenga NO cuentan para la serie: la serie
      -- sólo cuenta partidas match_type = 'tiebreak' (knockout_advance, knockout_walkover_row).
      update public.pairings set stage = 'bracket' where id = v_pairing_id and stage = 'revenge';

      update public.event_tiebreak_bracket_matches set pairing_id = v_pairing_id where id = v_bm_id;
      update public.knockout_slots set bracket_match_id = v_bm_id where id = v_slot.id;
      v_progress := true;

      select exists (select 1 from public.event_participants where id = v_slot.participant_a_id and left_event_at is not null),
             exists (select 1 from public.event_participants where id = v_slot.participant_b_id and left_event_at is not null)
      into v_a_left, v_b_left;

      if v_a_left and not v_b_left then
        perform public.knockout_walkover_row(v_bm_id, v_slot.participant_b_id);
      elsif v_b_left and not v_a_left then
        perform public.knockout_walkover_row(v_bm_id, v_slot.participant_a_id);
      end if;
    end loop;

    exit when not v_progress;
  end loop;
end;
$$;

-- ===========================================================================
-- 4. classify_match_type: en eventos Copa, todo 'draft' o 'final' es una venganza
--    (cuerpo de 0001; el trigger on_match_insert_classify de 0001 no cambia)
-- ===========================================================================
create or replace function public.classify_match_type()
returns trigger
language plpgsql
security definer
as $$
declare
  v_pairing public.pairings%rowtype;
  v_event public.draft_events%rowtype;
begin
  if new.match_type not in ('draft', 'final') then
    return new;
  end if;

  select * into v_pairing from public.pairings where id = new.pairing_id;
  select * into v_event from public.draft_events where id = v_pairing.event_id;

  -- Copa (sólo llaves): ninguna partida es oficial; todo 'draft' o 'final' es una venganza (0134).
  -- 'tiebreak' (la serie de llaves) no se toca: ya salió por el return de arriba.
  if v_event.competition_format = 'knockout' then
    new.match_type := 'revenge';
    return new;
  end if;

  if new.match_type <> 'draft' then
    return new;
  end if;

  if v_pairing.official_winner_participant_id is not null then
    new.match_type := 'revenge';
  elsif v_event.scoring_mode is not null then
    new.match_type := 'revenge';
  end if;

  return new;
end;
$$;

-- 0138_zones_revenge.sql
-- Grupos + Copa (competition_format = 'zones_knockout'): venganzas entre cualquier par de inscriptos. SIN UI.
--
-- ensure_revenge_pairing (hoy exclusiva de la Copa sólo llaves) pasa a aceptar también 'zones_knockout', con el
-- sorteo de zonas ya hecho (zones_drawn_at no nulo) y en los mismos estados que en la Copa (playing, completed y
-- concluded), sin exigir que ninguno de los dos siga en el evento. Para un par de inscriptos de cualquier zona:
--   * si ya existe un pairing entre ambos (zona, interzonal, cruce de llaves o venganza anterior) se devuelve esa
--     fila, SIN tocar su stage ni su resultado oficial;
--   * si no existe (zonas distintas sin interzonal), se crea con stage 'revenge' (ordenado a < b, on conflict do
--     nothing).
-- La Copa (sólo llaves) queda exactamente igual.
--
-- Consecuencias que obligan a ajustar dos funciones vivas, de forma mínima:
--   * classify_match_type: un pairing con stage 'revenge' no tiene partida oficial, así que la primera partida
--     'draft' (que en otros pairings es el oficial) tiene que salir como 'revenge'. Se agrega "or stage = 'revenge'"
--     a la rama de la Copa; los demás formatos y stages no cambian.
--   * apply_walkover_for_participant ("Me voy", 0099): trataba como partido oficial pendiente a cualquier pairing sin
--     resolver, y un pairing 'revenge' nunca tiene oficial: le habría insertado walkovers 'revenge' falsos al rival.
--     Se agrega "and stage is distinct from 'revenge'". Para stage null (todos los demás formatos) no cambia nada.
--
-- El stage 'revenge' no entra en ninguna parte de la fase de grupos: zone_standings y zones_check_phase_complete
-- sólo leen stage 'zone' / 'interzonal', y el trigger de cierre sólo se dispara para esos stages (0137).
--
-- Reemplazos (cuerpo de la última migración que define cada función; md5 del texto entre los $$ del archivo de
-- origen, con sus saltos de línea originales):
--   ensure_revenge_pairing        7ada1b5378ff7fd7f04aa56303fbfe83  (3614 caracteres con LF; con CRLF: aea4ddf04e2945b03cf207dcd22439a2, 3708)  [0135]
--   classify_match_type           098e26073d3db6a505fefda0f22a280b  (885 caracteres con LF; con CRLF: 6b86c561b44835e0d677cb462739f360, 916)  [0134]
--   apply_walkover_for_participant 7744dacf754c59b817fc85c63c07a05d  (3306 caracteres con LF; con CRLF: 7e66dd6fb71f86cc173fc505cbb855f9, 3399)  [0099]

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
  v_pairing_id uuid;
begin
  if p_participant_a is null or p_participant_b is null or p_participant_a = p_participant_b then
    raise exception 'ensure_revenge_pairing: hay que elegir dos jugadores distintos.'
      using errcode = '22023';
  end if;

  -- pairings_participants_ordered exige participant_a_id < participant_b_id.
  v_a := least(p_participant_a, p_participant_b);
  v_b := greatest(p_participant_a, p_participant_b);

  select de.id, de.workspace_id, de.competition_format, de.status, de.zones_drawn_at
  into v_event
  from public.draft_events de
  where de.id = p_event_id and de.deleted_at is null;

  if v_event.id is null then
    raise exception 'ensure_revenge_pairing: el evento no existe.';
  end if;

  -- 0138: también Grupos + Copa. La Copa (sólo llaves) queda exactamente igual.
  if v_event.competition_format not in ('knockout', 'zones_knockout') then
    raise exception 'ensure_revenge_pairing: el evento no es una Copa (sólo llaves ni grupos + llaves).';
  end if;

  -- 0135: el chequeo de 0134 (status <> 'playing') pasa a admitir también 'completed' y 'concluded': las
  -- venganzas no caducan con el evento, pero sólo existen una vez terminado el draft (se rechazan 'scheduled',
  -- 'drafting' y 'cancelled').
  if v_event.status not in ('playing', 'completed', 'concluded') then
    raise exception 'ensure_revenge_pairing: las venganzas se juegan una vez terminado el draft (el evento está en %).', v_event.status
      using errcode = '23514';
  end if;

  -- Grupos + Copa: sólo con el sorteo de zonas ya hecho (antes no hay zonas ni pairings).
  if v_event.competition_format = 'zones_knockout' and v_event.zones_drawn_at is null then
    raise exception 'ensure_revenge_pairing: las venganzas se arman una vez sorteados los grupos.'
      using errcode = '23514';
  end if;

  -- Los dos tienen que ser jugadores de este evento. 0135: quien se fue (left_event_at) también puede jugar
  -- venganzas; sólo pierde sus oficiales pendientes.
  if (
    select count(*)
    from public.event_participants ep
    where ep.event_id = p_event_id
      and ep.id in (v_a, v_b)
      and ep.role = 'player'
  ) <> 2 then
    raise exception 'ensure_revenge_pairing: los dos tienen que ser jugadores del evento.'
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

  -- Cruce de llaves pendiente entre los dos (en la copa principal o en la 2da oportunidad): ahí corre la
  -- serie de llaves, no una venganza.
  if exists (
    select 1
    from public.event_tiebreak_bracket_matches bm
    join public.event_tiebreak_groups g on g.id = bm.group_id
    where g.event_id = p_event_id
      and g.group_origin in ('knockout_bracket', 'knockout_second_chance')
      and g.status <> 'superseded'
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
    -- Ya existía (un pairing de zona, un interzonal, un cruce de llaves resuelto o una venganza anterior): se
    -- reutiliza, sin tocar su stage ni su resultado oficial.
    select p.id into v_pairing_id
    from public.pairings p
    where p.event_id = p_event_id and p.participant_a_id = v_a and p.participant_b_id = v_b;
  end if;

  return v_pairing_id;
end;
$$;

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

  -- Pairing de sólo venganza (stage 'revenge', ensure_revenge_pairing): nunca tiene partida oficial, en ningún formato
  -- (0138: Grupos + Copa). El resto de los formatos y de los stages no cambia.
  -- Copa (sólo llaves): ninguna partida es oficial; todo 'draft' o 'final' es una venganza (0134).
  -- 'tiebreak' (la serie de llaves) no se toca: ya salió por el return de arriba.
  if v_event.competition_format = 'knockout' or v_pairing.stage = 'revenge' then
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

create or replace function public.apply_walkover_for_participant(p_participant_id uuid)
returns integer
language plpgsql
security definer
as $$
declare
  v_event_id uuid;
  v_left_event_at timestamptz;
  v_event_status text;
  v_competition_format text;
  v_match_format text;
  v_pairing record;
  v_stayer_id uuid;
  v_needed integer;
  v_stayer_wins integer;
  v_next_number integer;
  v_to_insert integer;
  v_i integer;
  v_resolved_count integer := 0;
begin
  select event_id, left_event_at
  into v_event_id, v_left_event_at
  from public.event_participants
  where id = p_participant_id;

  if v_event_id is null or v_left_event_at is null then
    return 0;
  end if;

  select status, competition_format, match_format
  into v_event_status, v_competition_format, v_match_format
  from public.draft_events
  where id = v_event_id and deleted_at is null;

  if v_event_status is distinct from 'playing' then
    return 0;
  end if;

  -- Victorias necesarias para que el pairing quede oficialmente cerrado (mismo criterio que
  -- update_pairing_official_result, 0077): BO1 = 1, BO2/BO3 = 2.
  v_needed := case when v_match_format = 'bo1' then 1 else 2 end;

  for v_pairing in
    select p.id, p.participant_a_id, p.participant_b_id
    from public.pairings p
    join public.event_participants epa on epa.id = p.participant_a_id
    join public.event_participants epb on epb.id = p.participant_b_id
    where p.event_id = v_event_id
      and (p.participant_a_id = p_participant_id or p.participant_b_id = p_participant_id)
      and p.official_winner_participant_id is null
      and p.official_draw is not true
      -- Si el rival TAMBIÉN se fue, no hay "el que se queda" a quien darle la victoria.
      and (epa.left_event_at is null or epb.left_event_at is null)
      -- Fuera de alcance en esta fase: pairings ya linkeados a un bracket de desempate.
      and not exists (
        select 1 from public.event_tiebreak_bracket_matches bm
        where bm.pairing_id = p.id
      )
      -- Suizo: solo pairings efectivamente programados en una ronda (swiss_round asignado).
      -- Las filas swiss_round=null son cruces potenciales que generate_all_pairings crea de más
      -- pero Suizo nunca llega a programar — no representan un partido pendiente real, hacerles
      -- walkover inflaría puntos de gente que nunca fue emparejada contra quien se fue.
      and (v_competition_format <> 'swiss' or p.swiss_round is not null)
      -- 0138: un pairing de sólo venganza (stage 'revenge') no tiene partido oficial pendiente: nunca recibe walkover.
      and p.stage is distinct from 'revenge'
  loop
    v_stayer_id := case
      when v_pairing.participant_a_id = p_participant_id then v_pairing.participant_b_id
      else v_pairing.participant_a_id
    end;

    select count(*) into v_stayer_wins
    from public.matches
    where pairing_id = v_pairing.id
      and match_type = 'draft'
      and status = 'completed'
      and winner_participant_id = v_stayer_id;

    v_to_insert := v_needed - v_stayer_wins;
    if v_to_insert <= 0 then
      continue;
    end if;

    select coalesce(max(match_number), 0) into v_next_number
    from public.matches
    where pairing_id = v_pairing.id;

    for v_i in 1..v_to_insert loop
      insert into public.matches
        (pairing_id, match_number, match_type, winner_participant_id, status, is_walkover, started_at, ended_at)
      values
        (v_pairing.id, v_next_number + v_i, 'draft', v_stayer_id, 'completed', true, now(), now());
    end loop;

    v_resolved_count := v_resolved_count + 1;
  end loop;

  return v_resolved_count;
end;
$$;

-- CREATE OR REPLACE conserva owner, atributos y permisos de las tres funciones.

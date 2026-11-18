-- prueba-ventana-podio.sql  (SOLO ASCII a proposito: se puede copiar sin cuidado de codificacion)
-- Arma un evento de PRUEBA, NO oficial, todos contra todos BO3, en playing, con 4 jugadores del workspace, donde la ULTIMA partida del
-- enfrentamiento A vs D esta sin completar. Al completarla desde la app queda un empate de DOS por el primer puesto y se ve la ventana
-- (podio provisorio -> "Definiendo el desempate..." -> desempate). Correr como postgres en el SQL Editor, un bloque por vez.
--
-- Letras: A, B, C, D = los 4 primeros miembros del workspace ordenados por user_id (el BLOQUE 2 los lista).
-- Resultados ya cargados (cada enfrentamiento BO3 ganado 2-0):  A>B, B>C, B>D, C>A, D>C.   Pendiente: A vs D (A ya gano la partida 1).
--   Si A gana la 2da partida (2-0):  A=2, B=2, C=1, D=1  -> empate de A y B por el 1ro.
--   Si D gana la 2da y la 3ra:       B=2, D=2, A=1, C=1  -> empate de B y D por el 1ro.
-- Cada jugador queda con un color declarado (W) para que pueda abrir "Tabla de posiciones".

-- ============================== BLOQUE 1: CREAR (repetible: antes correr el BLOQUE 3) ==============================
do $crear$
declare
  c_name constant text := 'ZZ PRUEBA ventana podio (borrar)';
  c_ws   constant text := 'Las buenas pr_cticas Draft';   -- "_" = cualquier caracter (la tilde); ajustalo si tu workspace se llama distinto
  v_ws uuid; v_org uuid; v_ev uuid; v_pair uuid; v_pid uuid; v_x uuid; v_y uuid;
  v_users uuid[];
  v_p uuid[] := '{}';
  i int; k int;
  p_a int[] := array[1,2,2,1,3,1];   -- pares (A,B) (B,C) (B,D) (A,C) (C,D) (A,D)
  p_b int[] := array[2,3,4,3,4,4];
  p_w int[] := array[1,2,2,3,4,0];   -- ganador de cada par (indice 1..4 = A..D); 0 = pendiente (A vs D)
begin
  select id into v_ws from public.workspaces where name ilike c_ws and deleted_at is null order by created_at limit 1;
  if v_ws is null then raise exception 'No encontre el workspace %: ajusta c_ws', c_ws; end if;
  if exists (select 1 from public.draft_events where workspace_id = v_ws and name = c_name) then
    raise exception 'Ya existe el evento de prueba: correr primero el BLOQUE 3 (borrar)';
  end if;
  select user_id into v_org from public.workspace_members where workspace_id = v_ws and role = 'organizer' order by user_id limit 1;
  select array_agg(user_id order by user_id) into v_users
    from (select user_id from public.workspace_members where workspace_id = v_ws order by user_id limit 4) t;
  if v_org is null or coalesce(array_length(v_users, 1), 0) < 4 then raise exception 'Hacen falta un organizador y 4 miembros'; end if;

  insert into public.draft_events
    (workspace_id, name, scheduled_for, created_by, status, competition_format, match_format, top_size, is_official, draft_started_at, draft_ended_at)
  values (v_ws, c_name, now(), v_org, 'drafting', 'round_robin', 'bo3', null, false, now() - interval '2 hours', now() - interval '1 hour')
  returning id into v_ev;

  for i in 1..4 loop
    insert into public.event_participants (event_id, user_id, role) values (v_ev, v_users[i], 'player') returning id into v_pid;
    v_p := v_p || v_pid;
    insert into public.participant_colors (participant_id, color) values (v_pid, 'W');
  end loop;

  for i in 1..6 loop
    v_x := v_p[p_a[i]];
    v_y := v_p[p_b[i]];
    insert into public.pairings (event_id, participant_a_id, participant_b_id)
    values (v_ev, least(v_x, v_y), greatest(v_x, v_y)) returning id into v_pair;
    -- partidas: iniciadas y completadas como lo hace la app (los triggers resuelven el enfrentamiento). El pendiente solo lleva la partida 1 (gano A).
    for k in 1..(case when p_w[i] = 0 then 1 else 2 end) loop
      insert into public.matches (pairing_id, match_number, status) values (v_pair, k, 'in_progress');
      update public.matches
         set status = 'completed', ended_at = now() - interval '30 minutes',
             winner_participant_id = v_p[case when p_w[i] = 0 then 1 else p_w[i] end]
       where pairing_id = v_pair and match_number = k;
    end loop;
  end loop;

  -- Se pasa a playing recien al final: si el evento ya estuviera en playing, los triggers coronarian un campeon a mitad de la carga (con resultados parciales).
  update public.draft_events set status = 'playing' where id = v_ev;
end;
$crear$;

-- ============================== BLOQUE 2: VER (solo lectura) ==============================
-- Estado del evento y letras. final_pending debe ser false y no debe haber grupos de desempate hasta completar la ultima partida.
select de.id as event_id, de.status, de.final_pending, de.champion_user_id, de.is_official,
       (select count(*) from public.event_tiebreak_groups g where g.event_id = de.id) as grupos_desempate
from public.draft_events de where de.name = 'ZZ PRUEBA ventana podio (borrar)';

select ep.id as participant_id, u.display_name,
       (select count(*) from public.pairings p where p.event_id = ep.event_id and p.official_winner_participant_id = ep.id) as enfrentamientos_ganados
from public.event_participants ep
join public.users u on u.id = ep.user_id
join public.draft_events de on de.id = ep.event_id
where de.name = 'ZZ PRUEBA ventana podio (borrar)'
order by ep.user_id;   -- el orden es A, B, C, D

select p.id as pairing_id, p.official_winner_participant_id as ganador,
       (select count(*) from public.matches m where m.pairing_id = p.id and m.status = 'completed') as partidas_completadas
from public.pairings p join public.draft_events de on de.id = p.event_id
where de.name = 'ZZ PRUEBA ventana podio (borrar)' order by p.created_at;   -- 5 con ganador; 1 sin ganador y 1 partida completada (A vs D)

-- ============================== BLOQUE 3: BORRAR TODO lo que creo el BLOQUE 1 ==============================
-- Borra primero las partidas (la FK de ganador no cascadea) y despues el evento; participantes, colores, enfrentamientos y desempates se van en cascada.
-- No toca ningun otro evento: se filtra por el nombre exacto y por is_official = false.
delete from public.matches where pairing_id in (
  select p.id from public.pairings p join public.draft_events de on de.id = p.event_id
  where de.name = 'ZZ PRUEBA ventana podio (borrar)' and de.is_official = false);
delete from public.draft_events
where name = 'ZZ PRUEBA ventana podio (borrar)' and is_official = false;

-- Verificar que no quedo nada (debe dar 0 en las tres):
select (select count(*) from public.draft_events where name = 'ZZ PRUEBA ventana podio (borrar)') as eventos,
       (select count(*) from public.event_participants ep left join public.draft_events de on de.id = ep.event_id where de.id is null) as participantes_huerfanos,
       (select count(*) from public.pairings p left join public.draft_events de on de.id = p.event_id where de.id is null) as enfrentamientos_huerfanos;

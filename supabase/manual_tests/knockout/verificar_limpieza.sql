-- Solo lectura: confirma que las pruebas no dejaron ningún dato (todo debería dar 0).
select
  (select count(*) from public.draft_events where name like 'ZZ_TEST_COPA%')                                  as eventos_de_prueba,
  (select count(*) from public.draft_events where competition_format = 'knockout')                           as eventos_knockout_en_total,
  (select count(*) from public.event_tiebreak_groups where group_origin = 'knockout_bracket')                as grupos_knockout,
  (select count(*) from public.knockout_slots)                                                               as knockout_slots,
  (select count(*) from public.pairings where stage = 'bracket')                                             as pairings_bracket;

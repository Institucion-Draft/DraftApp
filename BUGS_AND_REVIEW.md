# Bugs y revisiones pendientes

Casos pendientes de revisión que no son ideas nuevas (para eso está [IDEAS.md](IDEAS.md)), sino comportamientos existentes a auditar o mejorar.

## Sistema "Me voy" - revisión pendiente de casos y reglas

Necesita una revisión completa de reglas y situaciones. Casos identificados hasta ahora:

1. **Reversión de "me voy".** ¿El sistema puede reconstruir el estado EXACTO previo al abandono si hubo otros walkovers/cambios en paralelo mientras la persona estaba marcada como ida? Riesgo de que revertir deje datos inconsistentes si el "estado anterior" no se preservó correctamente en algún snapshot.

2. **Salida durante una semifinal del bracket de top4.** El rival avanza automáticamente a la final (correcto, resuelve el evento). Pero además automáticamente PIERDE la chance de disputar el 3er/4to puesto (que normalmente jugarían los 2 perdedores de semi). ¿Es el comportamiento deseado, o debería preservarse esa instancia de alguna forma?

**Pendiente:** mapear todos los casos límite de "me voy" (en todos los formatos: round_robin sin/con top, swiss) y decidir para cada uno si el comportamiento actual es el correcto o necesita ajuste.

## [RESUELTO] Drift entre el historial de migraciones y la base real

**Resuelto.** Las 127 migraciones ahora se reconstruyen desde cero sin errores (verificado con PGlite, no con Supabase real) y el resultado coincide con prod en lo que se tocó. Cambios, todos inocuos para prod (las migraciones viejas ya estaban aplicadas y prod no tiene tabla `schema_migrations`, así que no hay checksums):

- **0042:** `v_participant_event_placement` tenía `total_players, placement` (orden invertido respecto de 0041 y de prod), y `v_head_to_head_stats` / `v_player_streaks` chocaban con las versiones de 0001. Se corrigió el orden y las dos últimas pasan a `drop view if exists` + `create view`, como hace 0043.
- **0041:** `v_player_color_stats` ahora se crea con el CTE `color_winrates` y las columnas `pairings_played` y `bo3_winrate`, que en prod existían pero nunca estuvieron en el repo. Sin eso, el chequeo de 0126 (espera 2 subselects de `draft_events`) fallaba al reconstruir.
- **0127 (nueva):** deja en el historial el estado real de prod en `draft_events`: constraint `events_type_valid` con `draft`, `tournament`, `pepidraft` y `two_headed_giant`; borra los constraints huérfanos de 0001 (`events_format_valid`, `events_champion_decision_valid`, que una base reconstruida conservaba y rechazaban `champion_decided_by = 'tiebreak'`/`'polemica'`); y `turn_tracking_enabled` con default `false` (0030 lo dejaba en `true`). Idempotente y sin efecto en prod.

Pendiente: la prueba de reconstrucción usó stubs de `auth`/`storage`, no Supabase real, y no se compararon tablas, índices ni policies contra prod (solo las vistas y el constraint tocados).

## [RESUELTO] Historial de posiciones en el perfil de jugador muestra la posición de fase liga, no la final del torneo

En el perfil de un jugador (dentro del workspace), el historial de "últimos drafts" muestra la posición equivocada cuando el evento tiene fase mata-mata (top4). Caso concreto: Esteban terminó 4° en la fase todos-contra-todos de "Último Draft de Invierno", pero clasificó al top4 y GANÓ la final (quedó 1° del torneo). El perfil le muestra "4°" en vez de "1°" - está mostrando la posición de la tabla de la fase liga en vez de la posición final real del torneo (que ya calculamos correctamente en otros lados, como computePodium/eventPodium.ts).

Investigar dónde vive ese historial en PlayerProfile o pantalla equivalente, y qué fuente de datos usa - probablemente hay que hacerlo consistente con eventPodium.ts (ya extraído y validado en la sesión de Temporadas) en vez de leer directo de standings de fase regular.

**Resuelto.** `CrossEventStats.tsx` (usado por `MemberProfileScreen`/`MyProfileScreen`) ahora llama a `fetchEventPodiums` (lote, en `lib/eventPodium.ts`) para obtener el 1°/2°/3° real de cada evento del historial — la misma fuente que ya usan `StandingsScreen` y el cierre de temporada. Híbrido acordado: si el jugador quedó en el podio (1-3), se usa esa posición; si no, se mantiene el `placement` que ya traía `v_participant_event_placement` (rank por winrate de fase regular), sin tocar. Validado con el set de 18 escenarios de podio ya usados en la sesión de Temporadas más una prueba nueva de fetch en lote (varios eventos a la vez, sin contaminación cruzada).

## [RESUELTO] Perfil de jugador: "últimos drafts jugados" incluía eventos two_headed_giant

**Resuelto** en la migración `0126`: `v_participant_event_placement` (y `v_head_to_head_stats`, `v_player_streaks`, `v_player_color_stats`) ahora filtran `event_type <> 'two_headed_giant'`.

## [RESUELTO] Perfil de jugador: posición incorrecta para quien no llega al podio en round robin con top

**Resuelto** en la migración `0126`: `v_participant_event_placement` ahora usa el bracket real (`round_robin_topcut`/`swiss_topcut`, no superseded) también en round robin con top, así el perdedor del 3°/4° queda 4° y el resto desde 5°. Caso que lo destapó: Eli en "Último Draft de Invierno" (salía 2°, es 4°).

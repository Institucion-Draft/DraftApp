# Bugs y revisiones pendientes

Casos pendientes de revisión que no son ideas nuevas (para eso está [IDEAS.md](IDEAS.md)), sino comportamientos existentes a auditar o mejorar.

## Sistema "Me voy" - revisión pendiente de casos y reglas

Necesita una revisión completa de reglas y situaciones. Casos identificados hasta ahora:

1. **Reversión de "me voy".** ¿El sistema puede reconstruir el estado EXACTO previo al abandono si hubo otros walkovers/cambios en paralelo mientras la persona estaba marcada como ida? Riesgo de que revertir deje datos inconsistentes si el "estado anterior" no se preservó correctamente en algún snapshot.

2. **Salida durante una semifinal del bracket de top4.** El rival avanza automáticamente a la final (correcto, resuelve el evento). Pero además automáticamente PIERDE la chance de disputar el 3er/4to puesto (que normalmente jugarían los 2 perdedores de semi). ¿Es el comportamiento deseado, o debería preservarse esa instancia de alguna forma?

**Pendiente:** mapear todos los casos límite de "me voy" (en todos los formatos: round_robin sin/con top, swiss) y decidir para cada uno si el comportamiento actual es el correcto o necesita ajuste.

## Drift en historial de migraciones

0042 no puede rejugarse desde cero contra una base vacía (`v_participant_event_placement` cambia de columnas de forma incompatible con una migración posterior: 0041 la crea con la columna `placement` y 0042 la reemplaza con `create or replace view` con otra lista de columnas, lo que Postgres rechaza). No afecta la base real (que ya tiene todo aplicado en orden), pero rompería un intento de reconstruir el schema desde cero (ej. clonar a un ambiente nuevo).

## Drift: constraint `events_type_valid` no incluye 'two_headed_giant'

`draft_events.event_type` se restringe en 0003 a `('draft', 'tournament', 'pepidraft')` y ninguna migración posterior lo amplía, pero la app crea eventos con `event_type = 'two_headed_giant'` (Gigante de Dos Cabezas, 0051 en adelante) y toda la lógica de estadísticas los excluye por ese valor. Eso implica que la base real tiene ese constraint modificado o eliminado a mano, fuera del historial de migraciones. Igual que el drift de 0042, no afecta la base real pero un schema reconstruido desde cero rechazaría la creación de eventos 2HG. Detectado al escribir el test de ProDeC (Fase E).

## [RESUELTO] Historial de posiciones en el perfil de jugador muestra la posición de fase liga, no la final del torneo

En el perfil de un jugador (dentro del workspace), el historial de "últimos drafts" muestra la posición equivocada cuando el evento tiene fase mata-mata (top4). Caso concreto: Esteban terminó 4° en la fase todos-contra-todos de "Último Draft de Invierno", pero clasificó al top4 y GANÓ la final (quedó 1° del torneo). El perfil le muestra "4°" en vez de "1°" - está mostrando la posición de la tabla de la fase liga en vez de la posición final real del torneo (que ya calculamos correctamente en otros lados, como computePodium/eventPodium.ts).

Investigar dónde vive ese historial en PlayerProfile o pantalla equivalente, y qué fuente de datos usa - probablemente hay que hacerlo consistente con eventPodium.ts (ya extraído y validado en la sesión de Temporadas) en vez de leer directo de standings de fase regular.

**Resuelto.** `CrossEventStats.tsx` (usado por `MemberProfileScreen`/`MyProfileScreen`) ahora llama a `fetchEventPodiums` (lote, en `lib/eventPodium.ts`) para obtener el 1°/2°/3° real de cada evento del historial — la misma fuente que ya usan `StandingsScreen` y el cierre de temporada. Híbrido acordado: si el jugador quedó en el podio (1-3), se usa esa posición; si no, se mantiene el `placement` que ya traía `v_participant_event_placement` (rank por winrate de fase regular), sin tocar. Validado con el set de 18 escenarios de podio ya usados en la sesión de Temporadas más una prueba nueva de fetch en lote (varios eventos a la vez, sin contaminación cruzada).

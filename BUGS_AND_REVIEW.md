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

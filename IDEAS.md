# Ideas

Registro de ideas y features futuras que todavía no están agendadas como pendientes técnicos concretos. Se va a ir extendiendo sesión a sesión.

- Modo oscuro (dark mode) para toda la app.

## Logros/Achievements (por temporada)

**Nota arquitectónica:** los logros son por TEMPORADA, no globales/eternos — cada temporada tiene su propia colección que los jugadores pueden desbloquear. Son booleanos (se cumplen o no), con alguna forma de notificación/celebración. Mecanismo de visualización a definir más adelante: notificación push, pantalla al entrar al workspace, badge visible para todos aunque la persona no esté usando la app en ese momento, etc.

- Cagarle el invicto a alguien en la fase todos contra todos (solo perdió contra vos)
- Ídem, pero además fuiste el último partido que jugó
- Dar vuelta un 0-1 en un BO3
- Ganar un desempate por 4to puesto y ganar el top4
- Ganar un desempate por el primer lugar
- Invicto en todas las rondas suizas
- Invicto en fase todos contra todos
- Ganar algún partido porque tu rival se fue (walkover)
- Ganar por tanta diferencia de vida (a definir el umbral)
- Partido de más de tanto tiempo (a definir el umbral)
- Partido de menos de tanto tiempo (a definir el umbral)
- 3 veces seguidas el mismo tipo de Pokémon (elegido en Life Tracker)
- 5 veces el mismo tipo de Pokémon

## Habilitar que cualquier miembro cree eventos (no solo organizadores)

Hoy la creación de eventos está restringida a organizadores (policy `events_insert_organizer` + checks de UI en `WorkspaceDetailScreen`/`EventsListScreen`). Esto significa que el sistema de "posta" (facultades del creador de evento, implementado en sesión anterior) nunca se usa en la práctica, porque la posta siempre nace en manos de un organizador real que ya tiene todas las facultades de todas formas.

Para habilitar: cambiar la policy a `is_workspace_member` en vez de `is_workspace_organizer`, sacar los checks de `isOrganizer` de los 2 botones de "Crear evento", y revisar qué otras partes del flujo de creación/gestión asumen que el creador es organizador.

## Personalización avanzada de Temporadas (opciones de organizador)

Las temporadas hoy son 100% automáticas por estación (hora de Buenos Aires). Posibles opciones futuras, todas en "opciones avanzadas" del organizador:

- Temporadas custom, por duración o por cantidad de drafts.
- Elegir qué columnas mostrar en la tabla de la temporada.
- Ocultar el segmento de Ranking completo para los no-organizadores.

## Métrica de eficiencia relativa: Puntos / Puntos disputados

Idea para comparar "calidad" de desempeño entre jugadores que asistieron a distinta cantidad/tamaño de eventos, como indicador secundario (NO de desempate de podio, ya que el podio se define por puntos totales absolutos).

Definición propuesta: "Puntos disputados" = suma de los puntos máximos posibles que el jugador podría haber ganado (como si hubiera salido 1° en TODOS los eventos donde participó, según el escalón de puntos de cada evento). La métrica sería Puntos reales / Puntos disputados.

Analogía de otros deportes: similar a "puntos por carrera" en F1 (promedio, indicador informativo, no define el campeonato que sí usa la suma total).

**Problema de diseño detectado, sin resolver todavía:** esta métrica tiene un sesgo estadístico real hacia el tamaño de los eventos jugados. Quien asiste a eventos GRANDES tiene un denominador más alto, así que perder en un evento grande "cuesta" más puntos posibles perdidos que perder en uno chico, aunque el mérito relativo (ej. ambos quedaron 2°) sea el mismo. Además, si hay un patrón sistemático en el grupo (ej. eventos chicos = solo el núcleo fiel, eventos grandes = todos incluyendo ocasionales), la métrica terminaría reflejando "qué tipo de eventos tiende a jugar cada uno" en vez de "qué tan bien juega". Necesita pensarse con más cuidado antes de implementar: no hay solución obvia y simple.

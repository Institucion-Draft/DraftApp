# DraftApp - Documentación del Proyecto

## Contexto general

DraftApp es una aplicación móvil para organizar y trackear eventos de draft del juego de cartas Magic: The Gathering. Está pensada para uso de un grupo de amigos (DraftGalicia / "Las buenas prácticas Draft") de hasta 15 personas que se juntan recurrentemente a draftear.

El usuario principal y dueño del proyecto es **Tomás** (Buenos Aires). El proyecto se desarrolla con asistencia de IA en sesiones pair-programming.

### Objetivos de la app

Funcionales:
- Organizar eventos de draft (programados, en curso, completados), en varios formatos de competencia
- Trackear vidas en tiempo real durante las partidas (Life Tracker estilo Lotus)
- Generar pairings automáticamente, con desempates y bracket de top4 cuando corresponde
- Mantener tabla de posiciones con stats vivos, y un Ranking Global + por Temporada del workspace
- Permitir venganzas y Copas extra-torneo
- Historial completo del grupo y sus jugadores

Tácitos pero importantes:
- Es un proyecto personal, NO comercial
- Sin objetivos de marketing, monetización, escalabilidad masiva
- Las decisiones estéticas y funcionales se priorizan según gusto del dueño, no según "buenas prácticas del mundo apps"
- La app es del grupo y para el grupo, no para el público general

---

## Stack técnico

### Frontend
- **React Native** 0.86.3 con **Expo SDK 57**
- **TypeScript** ~6.0.3, modo estricto
- Distribución vía:
  - **Android**: APK generado con EAS Build (instalación directa)
  - **iOS**: Expo Go con login en cuenta de Tomás (no requiere Apple Developer)

### Backend
- **Supabase** (free tier)
  - PostgreSQL para datos, 120 migraciones aplicadas (`supabase/migrations/0001` a `0120`)
  - Auth nativo
  - Realtime para sincronización en vivo (life events, pairings)
  - Storage para avatares (bucket `default-avatars` con 251 sprites de Pokémon Gen 1+2, incluye variantes shiny)
  - Row-Level Security en TODAS las tablas

### Infraestructura
- **Repo**: GitHub `Institucion-Draft/DraftApp` (público)
- **Local**: `C:\Users\tomas\Documents\code\DraftApp`
- **Cuenta Expo**: usuario `toxic214`, login social con Gmail
- **Project ID Supabase**: `iponphzukgdliqdbydun`
- **URL Supabase**: `https://iponphzukgdliqdbydun.supabase.co`
- **EAS Update**: `https://u.expo.dev/89b6b61b-1fa2-4440-885e-6e5a2596a6be`. El profile de build `preview` (el que genera el APK que usa Tomás) está atado al **channel `main`** (`eas.json`) — los updates JS-only se publican con `eas update --branch main`, no `--branch preview`.

### Identificadores clave del proyecto
- Workspace principal: `804dbb96-c97d-4be5-a017-691657d5ece0` ("Las buenas prácticas Draft")
- User ID de Tomás: `24b8c74b-dfeb-4446-a98f-1b1e4c672dfc`
- Email de Tomás: `tomas21@gmail.com`

---

## Setup operativo

### Terminales que se usan

Hay 2 terminales concurrentes:

**Terminal Expo** (la que corre el bundler):
```bash
cd ~/Documents/code/DraftApp/app
npx expo start
```
Genera QR para escanear desde iPhone con cámara o Expo Go.

**Terminal Edit** (para Git, EAS, comandos):
```bash
cd ~/Documents/code/DraftApp
git status  # o cualquier comando
```

### Access token de Expo

Para usar EAS desde la línea de comandos (build, update, etc.) hay que setear un access token. Cada terminal nueva requiere setearlo:

```bash
$env:EXPO_TOKEN = "TOKEN"
```

El token existe y está guardado por Tomás. Si Claude pregunta, Tomás se lo proporciona en el momento.

### TypeCheck antes de commitear

```bash
cd app
npx tsc --noEmit
```

Es el único gate automatizado del repo (no hay test runner ni CI configurado). Antes de dar cualquier cambio por terminado, correrlo y confirmar 0 errores.

### Convenciones de Git

- Branch por feature: `feat/nombre-descriptivo`, `fix/nombre`, `chore/nombre`, `docs/nombre`
- Commits con prefijo: `feat:`, `fix:`, `chore(db):`, `docs:`
- PR con título y descripción claros (formato exacto en "Comandos de referencia")
- Squash and merge (no merge commit)
- Borrar branch después de mergear

Por estar trabajando solo, el ruleset de protección de main está disabled (Settings → Rules en GitHub). Se reactiva cuando se sume otro dev.

---

## Modelo de datos (resumen)

### Tablas por área

**Auth y usuarios:**
- `auth.users` (gestionado por Supabase Auth)
- `public.users`: extiende auth con `display_name`, `username`, `gender`, `birth_date`, `default_avatar_id`, `custom_avatar_path`, `display_name_changed_at`. Ojo: existe también una columna `birthday` de 0001, muerta desde que 0015 introdujo `birth_date` como el campo real en uso (ver `BUGS_AND_REVIEW.md`).
- `public.default_avatars`: 251 Pokémon, cada uno con `storage_path` (y `storage_path_shiny` para la variante shiny) en bucket

**Workspaces:**
- `public.workspaces`, `public.workspace_members` (`role`: `organizer`/`member`), `public.workspace_invites`, `public.workspace_join_requests`
- `public.workspace_diary_entries`: bitácora de bugs/sugerencias del workspace (botón "🐛💡 Bugs y sugerencias" en WorkspaceDetail)

**Catálogos y eventos:**
- `public.cubes`, `public.venues`: catálogo por workspace (soft-delete con `deleted_at`)
- `public.cube_roulette_spins`: log de la ruleta de cubos
- `public.draft_events`: eventos. Columnas clave: `event_type`, `status`, `competition_format`, `top_size`, `match_format`, `topcut_format`, `is_official`, `draft_started_at`/`draft_ended_at`, `champion_user_id`, `event_organizer_user_id` (la "posta", ver más abajo). Enums vigentes:
  - `status`: `scheduled` / `drafting` / `playing` / `completed` / `cancelled` / `concluded`
  - `event_type`: `draft` / `tournament` / `pepidraft` / `two_headed_giant` (este último en uso real aunque el constraint de la base tiene drift — ver `BUGS_AND_REVIEW.md`)
  - `competition_format`: `round_robin` / `swiss`
  - `match_format` (fase regular): `bo1` / `bo2` / `bo3`
  - `topcut_format` (bracket de top4): `bo3` / `sf_bo1_f_bo3` (semis BO1, final BO3) / `bo1`
- `public.event_participants`: inscripciones, con `rotated_avatar_id` (Pokémon que rota por evento, sin reposición, con lock histórico vía `event_participant_avatar_history` si el jugador se desinscribe y reinscribe), `swiss_points`/`swiss_omw`/`swiss_gw`/`swiss_ogw`, `left_event_at` ("me voy"), `is_shiny`
- `public.participant_colors`: colores W/U/B/R/G/C declarados por participante
- `public.event_color_predictions`: pronóstico de ProDeC (ver más abajo)
- `public.event_diary_entries`, `public.event_media`, `public.dice_rolls`: bitácora, fotos y tiradas de dado por evento
- `public.draft_timer_logs`: telemetría del cronómetro de draft (ver Decisiones → Draft Timer)

**Desempates y bracket de top4:**
- `public.event_tiebreak_groups`: instancias de desempate (round robin, bracket de top4, disputa de 1er/4to puesto). `group_type`, `group_origin`, `status`
- `public.event_tiebreak_group_participants`, `public.event_tiebreak_bracket_matches`: participantes y partidos del bracket real (`bracket_phase`: `semi`/`final`/`third_place`)

**Gigante de Dos Cabezas (2HG):** subsistema propio en paralelo, prefijo `tg_` ("Torneo Gigante"): `public.tg_pairings`, `public.tg_team_members`, `public.tg_matches`, `public.tg_life_events`. Cada equipo comparte una sola fila de `event_participants` (solo el `user_id` del miembro A queda registrado ahí; el miembro B vive en `tg_team_members`) — por eso toda estadística cross-evento excluye explícitamente `event_type = 'two_headed_giant'`.

**Partidas:**
- `public.pairings`: enfrentamientos de un evento. Constraint `participant_a_id < participant_b_id`. `official_winner_participant_id`/`official_draw` se setean al cerrar el enfrentamiento (según `match_format`). `super_cup_winner_participant_id`, `revenge_cup_winner_participant_id` (Copas extra-torneo, ver Decisiones)
- `public.matches`: partidas individuales. `match_type` (`draft`/`final`/`revenge`/`tiebreak`/`two_headed_giant`), `status`, `life_tracker_user_id` (lock por celu), `winner_participant_id`, `who_started_participant_id`, `started_at`/`ended_at`
- `public.life_events`: cada cambio de vida (`participant_id`, `resulting_life`, `delta`, `occurred_at`)
- `public.match_turns`: registro de vida por turno cuando el evento tiene `turn_tracking_enabled`

**Partidas sin contexto (Playground):** subsistema aparte para jugar 1v1 fuera de cualquier evento — `public.context_free_encounters`, `public.context_free_matches`, `public.context_free_life_events`, `public.playground_presence` (quién está disponible para jugar ahora). Pantallas: `PlaygroundScreen`, `ContextFree*Screen`.

**Ranking Global y Temporadas:**
- `public.point_configs` / `public.point_config_tiers`: configuración de puntos por posición final, versionada. Una config `is_default=true` fija ("eterna") alimenta el Ranking Global; cada Temporada tiene la suya propia (clonada de la anterior al crearse), editable hasta que arranca el primer draft no-sandbox de esa temporada (candado con trigger)
- `public.season_calendar`: cortes fijos y globales (21 de marzo/junio/septiembre/diciembre, 00:00 hora de Buenos Aires), hasta 2050
- `public.seasons`: una fila por workspace y corte de calendario. `closed_at`, `closed_forced`
- `public.season_frozen_events` / `public.season_frozen_positions`: snapshot de los podios "asegurados" al forzar el cierre de una temporada con eventos inconclusos

**Storage:**
- Bucket `default-avatars`: 251 PNGs de Pokémon (con variantes shiny)

### Vistas SQL (`v_*`, además de `cubes_with_stats`/`venues_with_stats`)

Todas calculadas on-the-fly (sin tabla persistida ni trigger), mismo patrón en todo el proyecto: SELECT + combinar del lado del cliente.

- `v_player_workspace_stats`, `v_player_color_stats`, `v_player_streaks`, `v_head_to_head_stats`, `v_player_tg_stats`, `v_cube_stats`, `v_color_performance`, `v_participant_event_placement`: stats agregadas por jugador/workspace (la última, de fase regular únicamente — ver limitación en `BUGS_AND_REVIEW.md`)
- `v_rr_no_top_regular_rank`: ranking de fase regular de round robin sin top, con desempate real cuando hubo disputa
- `v_workspace_points`, `v_workspace_points_breakdown`, `v_workspace_placements`: Ranking Global (puntos de torneo + 4 columnas de ProDeC al final)
- `v_event_final_positions`, `v_event_season`, `v_seasons`, `v_season_positions`, `v_season_points`, `v_season_points_breakdown`, `v_season_player_stats`: equivalentes de Temporada de las vistas de arriba
- `v_event_prodec_positions`: aciertos de ProDeC por evento y votante (base de las columnas de ProDeC en las dos anteriores)

### Funciones de negocio relevantes (`security definer` salvo aclaración)

- `is_workspace_member(workspace_id)`, `is_workspace_organizer(workspace_id)`: helpers base de RLS
- `can_manage_event(workspace_id, event_id)`: organizador real del workspace **O** posta del evento puntual (`event_organizer_user_id = auth.uid()`). Gatekeeper de la mayoría de las policies de edición de un evento — borrar el evento sigue siendo organizer-only puro, por diseño
- `transfer_event_posta(...)`: transfiere la posta a otro jugador `role='player'` del evento
- `workspace_ranking_points(player_count, position[, config_id])`: escalones de puntos por posición final según cantidad de jugadores (ver Decisiones → Ranking Global). Sin `config_id` usa la config eterna
- `sync_workspace_seasons`, `ensure_workspace_seasons`, `season_try_close`, `close_ready_seasons`, `close_season_if_ready`, `force_close_season(season_id, secured_positions)`: ciclo de vida de Temporadas (ver Decisiones)

### Convenciones de seguridad

- RLS ON en todas las tablas
- Trigger `handle_new_user`: crea fila en `public.users` con `display_name`/`gender`/`birth_date` desde `raw_user_meta_data` del signup
- Cualquier query desde la app respeta automáticamente las policies — no se filtra manualmente por `workspace_id` en general
- Antes de cambios de schema o de lógica de negocio riesgosos, se valida primero en Postgres en memoria (PGlite) contra el schema completo, no directo contra la base real — ver "Notas para Claude"

---

## Decisiones de diseño y arquitectura

### Sistema de avatares

Cada user tiene 3 niveles de avatar, en orden de prioridad:

1. **Custom** (`users.custom_avatar_path`): foto subida por el user. Prioridad máxima.
2. **Rotated** (`event_participants.rotated_avatar_id`): Pokémon asignado al inscribirse a un evento. Distinto por evento, sin reposición dentro del mismo evento. Si el jugador se desinscribe y reinscribe, mantiene el mismo (histórico en `event_participant_avatar_history`, 0017).
3. **Default** (`users.default_avatar_id`): Pokémon "personal" asignado al crear cuenta. Identidad estable de cuenta.

Probabilidad chica de que un avatar asignado sea **shiny** (sprite alternativo, mismo Pokémon a efectos de stats/tipo). `PlayerAvatar` lo anima con `showShinyAnimation`; el campeón shiny de un evento dispara confetti en Standings.

Componente `PlayerAvatar` con prop `outsideEvent`: `true` muestra inicial sobre fondo de color fuera de contexto de evento; `false` (default) muestra el Pokémon. `withColorBorder={true}` agrega reborde con segmentos de los colores declarados (1 a 5+ segmentos, contorno oscuro para W y C).

### Life Tracker

- Estilo Lotus: split arriba/abajo, mitad para cada jugador. El user logueado siempre va abajo, el oponente arriba (rotado 180°).
- Lock por celu: `match.life_tracker_user_id` apunta al device que controla. El organizador (o quien tiene la posta del evento) puede "tomar control".
- Umbral de estabilización: 5 segundos antes de persistir un cambio de vida. Contador de diferencial (+N verde / -N rojo) mientras tanto.
- Vidas clamped en 0. Al llegar a 0: modal de confirmación (Confirmar marca `completed` + winner; Cancelar hace undo del último `life_event`).
- `who_started_participant_id`: quién arranca cada partida, elegible desde LifeTracker.
- Keep-awake solo en esta pantalla.
- **NewsTicker**: banner movedizo (marquee, texto scrolleando de derecha a izquierda) dentro de LifeTracker con resultados de otras mesas. 3 colores/situaciones:
  - Blanco (`EN VIVO`): vidas actuales de otra partida en curso, se actualiza periódicamente
  - Ámbar: una partida individual terminó pero el enfrentamiento (serie BO1/BO2/BO3, o la instancia del bracket) todavía no está decidido
  - Violeta: la partida que acaba de terminar decide el enfrentamiento completo
  
  El criterio de cierre respeta el `match_format` real en fase regular (BO1 cierra con 1 victoria; BO2 con 2 partidas completadas, sea 2-0 o el empate 1-1; BO3 primero a 2) y el `topcut_format` en el bracket — corregido en sesión reciente (antes asumía BO3 fijo en fase regular).

### Draft Timer

Cronómetro opcional para la fase de armado de mazo (antes de que arranque el torneo), configurable por evento (`is_timed_draft`, `timer_packs`, y parámetros `timer_alpha`/`beta`/`gamma`/`delta`/`rho`/`tmin`/`tmax`/`color`). Modela un tiempo estimado por pick según un modelo con esos parámetros (`lib/draftTimer.ts`, `computePickTimeline`). Pantallas: `DraftTimerScreen`, `DraftTimerConfigScreen`, `DraftTimerAdvancedScreen`, `DraftTimerSimScreen`/`DraftTimerPreviewScreen` (simulación/preview de la configuración). Log de telemetría real vs. estimado en `draft_timer_logs`.

### Pairings y formatos de competencia

- `competition_format`: `round_robin` (con o sin `top_size=4`) o `swiss` (siempre con top4). Round-robin sin top: N choose 2 pairings, gana quien mejor terminó la fase regular (con desempate real de 1er puesto si hace falta). Con top4 o Suizo: los primeros 4 pasan a un bracket real (semis, final, 3er puesto) en `event_tiebreak_groups`/`event_tiebreak_bracket_matches`.
- `match_format` de la fase regular: BO1, BO2 (2 partidas fijas, 1-1 es empate del enfrentamiento, `official_draw=true`) o BO3 (al mejor de 3). `topcut_format` del bracket es independiente: BO3, BO1, o semis BO1 + final BO3.
- Suizo: unificado en una sola implementación para BO1/BO2/BO3 (antes había una variante separada `swiss_bo2`, fusionada en 0096). Emparejamientos con backtracking para evitar repetir cruces (0097). El bracket de top4 se arma client-orchestrated: el cliente calcula el top4 según `swiss_points`/OMW/GW/OGW ya persistidas y llama a un RPC idempotente al enfocar la pantalla relevante — mismo patrón que se reusó después para el cierre de Temporadas.
- **Walkover**: cuando alguien "se va" de un evento (`left_event_at`), sus pairings pendientes se resuelven solos a favor del rival. Reversión y algunos casos límite (salida durante una semifinal del bracket) tienen dudas abiertas — ver `BUGS_AND_REVIEW.md`.
- **Final del evento**: el status pasa a `completed` automáticamente al resolverse el campeón (bracket real, o desempate matemático en round robin sin top); `concluded` es el cierre manual del organizador para casos sin ese criterio.
- **Podio**: `lib/podium.ts` (`computePodium`) es la fuente de verdad de quién quedó 1°/2°/3° de un evento — maneja campeón declarado, proyección con partidos pendientes, bracket real, Copa Polémica/Fragmentada y desempates. `lib/eventPodium.ts` arma sus datos de entrada desde Supabase y lo reutilizan `StandingsScreen` (podio en vivo), `SeasonForceCloseScreen` (podios a congelar), `WorkspaceSeasonScreen` (podio de cierre de temporada) y `CrossEventStats` (historial del perfil). `fetchEventPodiums(eventIds)` trae el podio de varios eventos en una sola tanda de 7 queries, en vez de repetirlas por evento.

### Venganzas y Copas extra-torneo

- Venganza: `match_type='revenge'` posterior al cierre del enfrentamiento oficial. No impacta `pairing.official_winner_participant_id` ni las columnas oficiales de Standings (PG, PJ, EG, EC). Pestaña propia "Venganzas" en PairingsList y en Standings.
- **Copa Venganza**: única por par de jugadores en el evento, la gana el primero que llega a 3 venganzas ganadas. **Súper Copa**: única por par, la gana el primero con 2 de diferencia. Ambas se cierran una vez ganadas y no se reabren; son independientes entre sí. Columnas `super_cup_winner_participant_id`/`revenge_cup_winner_participant_id` en `pairings`.

### Sistema de posta (organizador puntual de un evento)

Cada evento tiene un `event_organizer_user_id` propio ("posta"), separado de ser organizador real del workspace. Nace en manos de `created_by` al crearse el evento y es transferible a cualquier `role='player'` inscripto (`transfer_event_posta`). `can_manage_event` da las mismas facultades de gestión (editar, cronómetro, marcar resultados, etc.) al organizador real **o** a quien tiene la posta — borrar el evento queda siempre organizer-only. Desde que crear eventos se abrió a cualquier miembro del workspace (no solo organizadores, ver abajo), la posta efectivamente se usa: un miembro sin ser organizador puede crear su propio evento y gestionarlo de punta a punta.

### ProDeC (Pronóstico De Colores)

Cada jugador, al declarar sus colores, pronostica cuál cree que va a ser el color más elegido del evento (`event_color_predictions`, excluye Incoloro). Regla de acierto (`lib/prodecDisplay.ts`, reproducida en SQL en `v_event_prodec_positions`): se agrupan los 5 colores por frecuencia descendente en "tiers" — empate de frecuencia comparte tier, y un color con frecuencia 0 puede igual ser un tier si nadie usó ningún color con más frecuencia. Tier 0/1/2 = 1°/2°/3° color más elegido; acertar el tier de tu pronóstico es "pegarle". El cartel de resultados (`ProDeCScreen`, podio + `ProDeCFrequencyChart` de frecuencia por color) aparece en EventDetail recién cuando votaron todos los jugadores.

Esas mismas 3 posiciones alimentan 4 columnas nuevas en el Ranking Global y el de Temporada (`prodec_points` + 3 medallas), agrupadas visualmente a la derecha bajo una barra con el rótulo "ProDeC" (mismo glifo de la C degradada que usa la pantalla de ProDeC). Puntúan con los mismos escalones que el torneo (según cantidad de jugadores del evento), pero **no** suman a los puntos de torneo ni alteran el orden del ranking. Un evento cuenta cuando votaron todos los jugadores (mismo umbral que el cartel), sin esperar a que termine; sandbox, 2HG, cancelados y eliminados quedan afuera.

### Ranking Global

Tabla de posiciones acumulada de TODO el historial del workspace (`WorkspaceRankingScreen`), sin filtrar por membresía vigente. Columnas: Puntos, #PE (participaciones), 🥇🥈🥉 (veces 1°/2°/3°), EJ/WRE, PJ/WRP, VJ/WRV, Pts/PE (puntos por evento jugado, torneo y ProDeC), y el grupo de ProDeC. Puntos por posición final según escalón de cantidad de jugadores del evento (`workspace_ranking_points`, config eterna): 4-6 jugadores 5/3/2, 7-9 7/4/3, 10-12 9/6/4, 13+ 12/8/5 — solo top3, nada para 4° en adelante. Tap en un jugador abre `PlayerPointsDetailScreen`: detalle expandible por evento, con la leyenda de escalones leída dinámicamente de `point_config_tiers` (no hardcodeada). Reemplaza conceptualmente al viejo "ranking trimestral" que estaba en backlog, con un diseño de escalones fijos en vez de la fórmula ponderada originalmente pensada.

### Temporadas

Una temporada por workspace y por estación del año, con cortes **fijos y culturales** (no astronómicos): 21 de marzo/junio/septiembre/diciembre, 00:00 hora de Buenos Aires, siempre — calculados desde `season_calendar` hasta 2050. Un evento pertenece a la temporada según `draft_started_at`, en cualquier estado (los inconclusos ya reflejan sus stats en vivo aunque no aporten puntos todavía).

- **Config de puntos por temporada**: cada temporada clona la config de puntos de la anterior (o la eterna, la primera vez) al crearse. Editable libremente hasta que arranca el primer draft no-sandbox de esa temporada; desde ahí, un trigger la bloquea.
- **Creación y cierre, client-orchestrated**: `sync_workspace_seasons` corre al abrir `WorkspaceDetailScreen` — crea la temporada actual y la próxima si faltan, y cierra las que ya se puedan cerrar (sin eventos inconclusos y con el calendario ya vencido).
- **Temporada colgada**: si al llegar el corte quedan eventos inconclusos, no cierra sola. Un organizador puede forzar el cierre (`SeasonForceCloseScreen`) desde el inicio de la temporada siguiente en adelante: el cliente calcula, evento por evento, el podio "asegurado al momento" (mismo `computePodium`/`eventPodium.ts` que usa un evento en vivo) y lo manda como payload a `force_close_season`, que lo congela (`season_frozen_events`/`season_frozen_positions`) — si esos eventos terminan después con otro resultado, la temporada cerrada no cambia (el Ranking Global sí ve el resultado real). Si nadie fuerza y los eventos se resuelven solos, el cierre se dispara automático en ese momento.
- **Podio de cierre**: `WorkspaceSeasonScreen` muestra el podio de la temporada cerrada (mismo componente visual que el podio de evento), con empate exacto en Puntos compartiendo escalón — sin desempatar por Copas/WRE, que no reflejan mérito de esa disputa puntual. `WorkspaceSeasonHistoryScreen` lista temporadas pendientes/cerradas.
- **Reorganización del workspace**: `WorkspaceDetailScreen` agrupa sus acciones en 4 secciones con jerarquía visual distinta — Eventos (con la tarjeta "HOY" si hay un evento programado para hoy), Partidas sin contexto, Ranking (Temporada actual/Global/Historial), y Cubos y sedes.

### Crear eventos: abierto a cualquier miembro

Desde 0120, `events_insert_organizer` (RLS de `draft_events`) exige `is_workspace_member` en vez de `is_workspace_organizer` — cualquier miembro puede crear un evento, no solo organizadores. Es lo que hace que el sistema de posta (arriba) se use de verdad: el creador nace con la posta de ESE evento, sin ser organizador del workspace. Borrar el evento y el resto de "Acciones de organizador" (invitaciones, solicitudes pendientes) siguen siendo organizer-only, sin cambios.

---

## Convenciones de la app

### UI/UX

- Tono general: **español rioplatense** (Buenos Aires)
- **NO usar futuro perifrástico**: "se cierran las inscripciones" en vez de "se cerrarán"
- Mezcla con anglicismos del juego está OK: "drafteando", "draftear", "BO3", "deck"
- Errores: usar `Alert.alert` (no toasts ni custom)
- Colores MTG estándar:
  - W: #FFFBE0 (blanco apagado)
  - U: #3B82F6 (azul)
  - B: #1F2937 (negro)
  - R: #EF4444 (rojo)
  - G: #10B981 (verde)
  - C: #9CA3AF (gris incoloro)

### Naming

- Variables, archivos, queries: **inglés** o spanglish técnico (`workspace_id`, `pairing`, `event_participants`)
- Strings visibles al usuario: **español**
- Excepción: "Workspaces" → "Grupos de Draft" en UI

### Manejo de errores

- Errores silenciosos NUNCA: siempre `console.error` en `__DEV__` y/o `Alert.alert`
- Para queries que pueden fallar: try/catch + fallback claro
- RLS errors deben ser visibles al usuario solo cuando son accionables (ej: "no tenés permiso")

### Navegación

Patrón "hierarchical back": el botón atrás navega al padre lógico, no al historial del navegador (`hierarchicalHeaderBack`). Cada pantalla setea su `headerLeft` con la pantalla padre correcta. Cuando el padre lógico ya está en el stack (ej. "Crear evento" abierto desde el workspace), usa `pop: true` para volver a esa instancia en vez de apilar una copia nueva.

### Auto-refresh y Realtime

- `PairingsListScreen` refresca cada 15 segundos cuando está enfocada.
- Otras pantallas usan realtime (subscriptions a `life_events`, `pairings`) en lugar de polling.
- Patrón obligatorio de cleanup: `useRef` para el channel, verificar si ya existe antes de subscribirse, `channel.unsubscribe()` + `removeChannel(channel)` en el return del `useEffect`, nombres de canal únicos.

---

## Estado actual del proyecto

Resumen por área funcional. Para lo que cambió recientemente en detalle, ver "Decisiones de diseño y arquitectura" arriba.

**Auth y Workspaces**: login, signup (con género y fecha de nacimiento), sesión persistente, logout. Creación de workspace, invitaciones por código, pedidos de unión. Crear eventos ya no es solo de organizadores (ver Decisiones).

**Eventos**: cubos y sedes (CRUD soft-delete), ruleta de cubos, inscripción, formatos round robin (con/sin top4, BO1/BO2/BO3) y Suizo (unificado, con backtracking de pairings y bracket client-orchestrated), Gigante de Dos Cabezas, Draft Timer opcional, bitácora de evento con fotos.

**Life Tracker + Realtime**: estilo Lotus con lock por celu, persistencia con threshold, undo, rendición; quién empieza cada partida; NewsTicker con resultados de otras mesas; MatchResult con confetti (incluido shiny); Standings con completitud/E_2-0/E_2-1; venganzas y Copas (Venganza/Súper Copa); DMV ponderado por tiempo.

**Avatares**: 3 niveles (custom/rotated/default), lock de rotated al reinscribirse, shinys, reborde por colores declarados.

**Perfiles**: `MyProfileScreen`/`MemberProfileScreen` con `CrossEventStats` (stats agregadas, colores jugados, historial de últimos 10 drafts con la posición final real del torneo, H2H vs rivales, rachas más largas).

**ProDeC real**: pronóstico de color más elegido, podio propio por evento con gráfico de frecuencia, y columnas de puntos/medallas en el Ranking Global y de Temporada.

**Ranking Global y Temporadas**: ranking acumulado histórico del workspace y ranking automático por estación del año, con podio de cierre, config de puntos versionable y cierre forzado con podios congelados. Reemplaza al "ranking trimestral" y a buena parte de la "tabla histórica con filtros" que estaban en backlog (sin los filtros combinables estilo Excel, que siguen sin implementar — ver `IDEAS.md`).

**Distribución**: APK Android por EAS Build (channel `main`), EAS Update para JS-only, Expo Go para iPhone, keep-awake en LifeTracker.

### Datos protegidos (NO MODIFICAR)

**Draft del Trabajador** (3 de mayo de 2026, primer draft real con la app)
- Event ID: `7f101255-cc00-4f83-9984-e1e06caa0654`
- Datos congelados en schema `backup_draft_trabajador_20260503` (migración 0009)

Cualquier cambio de schema o lógica que pueda afectar matches, life_events, pairings o stats: **verificar primero contra el backup**, y para cambios riesgosos, validar antes en PGlite (ver "Notas para Claude").

### Eventos y datos de prueba

- "Test 7 jugadores" (id `33af0481-9ff6-4b9a-8b21-e46ef5281eaf`): evento simulado con 7 jugadores y matches inventados, para testear features sin tocar datos del Draft del Trabajador.
- Estado real de miembros, cubos, sedes: no se documenta acá porque se desactualiza solo — usar las queries de "Cómo retomar el proyecto".

---

## Documentos hermanos

Dos documentos aparte en la raíz del repo, actualizados por separado — **no** se reflejan en este documento:
- **`IDEAS.md`**: ideas y features futuras sin agendar todavía.
- **`BUGS_AND_REVIEW.md`**: comportamientos existentes a auditar, drift de schema conocido, casos límite pendientes de decisión.

---

## Cómo retomar el proyecto

### Si abrís una sesión nueva

Pegale este documento al inicio. Decile claramente qué querés arrancar. Debería:
- Leer el documento completo antes de proponer nada, y revisar también `IDEAS.md`/`BUGS_AND_REVIEW.md` si son relevantes al pedido
- Usar las convenciones (español rioplatense, no futuro perifrástico, naming conventions)
- Respetar el modelo de datos existente
- NO sugerir features que no le pediste
- NO darte cátedra de buenas prácticas de la industria si vos no las pediste

### Si necesitás verificar el estado actual

```bash
cd ~/Documents/code/DraftApp
git log --oneline -20
git status
```

### Si necesitás ver el schema actual de DB

En Supabase Dashboard: SQL Editor → ejecutar:
```sql
select table_name from information_schema.tables
where table_schema = 'public' order by table_name;
```

Columnas de una tabla:
```sql
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'TABLA'
order by ordinal_position;
```

### Si necesitás el estado real de miembros de un workspace

```sql
select u.display_name, u.username, wm.role, wm.joined_at
from public.workspace_members wm
join public.users u on u.id = wm.user_id
where wm.workspace_id = '804dbb96-c97d-4be5-a017-691657d5ece0'
order by wm.role, u.display_name;
```

---

## Notas para Claude (la próxima IA que lea esto)

Hola. Soy Tomás, dueño del proyecto. Algunas cosas que me importa que sepas antes de arrancar:

**Cómo me dirijo y cómo quiero que me hables**:
- Hablame de manera **no condescendiente** y sin abogar el diablo permanentemente.
- Quiero **mirada crítica** y advertencias prudentes sobre decisiones, implementaciones, riesgos.
- NO me trates de pelotudo. Si te pido un feature, asumo que sé lo que quiero. No me preguntes "¿estás seguro?" por features personales del grupo. Las advertencias se justifican cuando afectan **funcionalidad correcta** o cuando puedan **saturar Supabase / romper la DB / afectar performance medible**.
- Las opiniones puramente estéticas o de "buenas prácticas de la industria" o de marketing no me interesan. Esto es algo personal, no comercial. Si tu sugerencia es "mejor no lo hagas porque queda raro estéticamente" o "no es lo recomendado por la industria", guardátela.
- Si tenés preguntas legítimas, sentimientos encontrados sobre algo que pedí, o creés que hay un riesgo técnico real, **decímelo**. Eso siempre es bienvenido.
- Si voy a hacer algo que probablemente rompa cosas (riesgo técnico real), advertímelo claramente.

**Sobre el ritmo de trabajo**:
- Hago sprints cortos de 1-2 horas. Trato de cerrar features completas.
- Antes de un cambio grande, charlamos el plan primero.
- Me gusta probar cada cambio en el celu antes de commitear.
- No metemos cambios mal probados a main.

**Sobre los testeos**:
- Hago tests manuales en el celu (Expo Go en iPhone).
- Para tests con múltiples usuarios o eventos, simulamos con SQL en Supabase.
- Hay un evento "Test 7 jugadores" para no contaminar datos reales.
- El "Draft del Trabajador" tiene datos oficiales backupeados — no romper.
- Para cambios riesgosos de schema o de lógica de negocio, se valida primero con Postgres en memoria (PGlite) antes de aplicar contra la base real — patrón establecido en sesiones recientes (walkover, unificación de Suizo, Temporadas).

**Sobre documentación**:
- Existen 2 documentos hermanos de este (`IDEAS.md` y `BUGS_AND_REVIEW.md`, en la raíz del repo) que se actualizan por separado. Ideas a futuro y bugs/casos pendientes de revisión NO van en este documento.

**Sobre commits y PRs**:
- Branch nueva por feature, PR a main, squash and merge, delete branch, sync local. Siempre.
- Mensajes de commit claros con prefijo (`feat:`, `fix:`, `chore(db):`, etc.)
- Formatos exactos en "Comandos de referencia" abajo.

Última cosa: este documento se va a desactualizar. Si notás inconsistencia entre esto y la realidad del repo, **priorizá el código**, y avisame para actualizar el doc.

---

## Comandos de referencia

### Para comitear

```bash
cd ~/Documents/code/DraftApp
git checkout -b <tipo>/<nombre-descriptivo>
git add .
git commit -m "<tipo>: <descripción corta>"
git push -u origin <tipo>/<nombre-descriptivo>
```

### Para la descripción del PR

Título breve, seguido de secciones en markdown con headers `##`:

- `## Qué cambia` (con subsecciones si aplica)
- `## Validado en vivo` o `## Validado con...`
- `## Pendiente` (si queda algo anotado)
- `## Checklist`, con items tipo:
  - `[x] npx tsc --noEmit sin errores`
  - `[x] Migración aplicada`
  - `[x] Validado en vivo/con tests`

### Para el pull final después de mergear

```bash
git checkout main
git pull
git branch -d <tipo>/<nombre-descriptivo>
```

### Para actualizar EAS (branch `main`, cambios JS-only)

```bash
cd ~/Documents/code/DraftApp/app
eas update --branch main
```

### Para el build de APK (paquetes nativos nuevos)

```bash
cd ~/Documents/code/DraftApp/app
eas build --platform android --profile preview
```

---

Última actualización del documento: 22 de septiembre de 2026.

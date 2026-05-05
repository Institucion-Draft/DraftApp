[# DraftApp - Documentación del Proyecto

## Contexto general

DraftApp es una aplicación móvil para organizar y trackear eventos de draft del juego de cartas Magic: The Gathering. Está pensada para uso de un grupo de amigos (DraftGalicia / "Las buenas prácticas Draft") de hasta 15 personas que se juntan recurrentemente a draftear.

El usuario principal y dueño del proyecto es **Tomás** (Buenos Aires). El proyecto se desarrolla con asistencia de IA (Claude vía Cursor) en sesiones pair-programming.

### Objetivos de la app

Funcionales:
- Organizar eventos de draft (programados, en curso, completados)
- Trackear vidas en tiempo real durante las partidas (Life Tracker estilo Lotus)
- Generar pairings round-robin automáticamente
- Mantener tabla de posiciones con stats vivos
- Permitir venganzas extra-torneo
- Historial completo del grupo y sus jugadores

Tácitos pero importantes:
- Es un proyecto personal, NO comercial
- Sin objetivos de marketing, monetización, escalabilidad masiva
- Las decisiones estéticas y funcionales se priorizan según gusto del dueño, no según "buenas prácticas del mundo apps"
- La app es del grupo y para el grupo, no para el público general

---

## Stack técnico

### Frontend
- **React Native** con **Expo** (SDK 54)
- **TypeScript estricto**
- Distribución vía:
  - **Android**: APK generado con EAS Build (instalación directa)
  - **iOS**: Expo Go con login en cuenta de Tomás (no requiere Apple Developer)

### Backend
- **Supabase** (free tier)
  - PostgreSQL para datos
  - Auth nativo
  - Realtime para sincronización en vivo (life events, pairings)
  - Storage para avatares (bucket `default-avatars` con 251 sprites de Pokémon Gen 1+2)
  - Row-Level Security en TODAS las tablas

### Infraestructura
- **Repo**: GitHub `Institucion-Draft/DraftApp` (público)
- **Local**: `C:\Users\tomas\Documents\code\DraftApp`
- **Editor**: Cursor Pro con agente IA
- **Cuenta Expo**: usuario `toxic214`, login social con Gmail
- **Project ID Supabase**: `iponphzukgdliqdbydun`
- **URL Supabase**: `https://iponphzukgdliqdbydun.supabase.co`

### Identificadores clave del proyecto
- Workspace principal: `804dbb96-c97d-4be5-a017-691657d5ece0` ("Las buenas prácticas Draft")
- User ID de Tomás: `24b8c74b-dfeb-4446-a98f-1b1e4c672dfc`
- Email de Tomás: `tomas21@gmail.com`

---

## Setup operativo

### Terminales que se usan

Hay 2 terminales concurrentes en Cursor:

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

### Comandos comunes

**Iniciar Expo** (desarrollo local):
```bash
cd app
npx expo start
```

**Verificar autenticación con EAS**:
```bash
eas whoami
```

**Publicar update a Expo Go y al APK** (cambios JS-only, sin paquetes nuevos):
```bash
eas update --branch preview --message "descripción del cambio"
```

**Rebuild del APK** (necesario solo cuando se agregan paquetes nativos):
```bash
eas build --profile preview --platform android
```

Después responder `n` cuando pregunta si correr en emulador. El link al APK aparece al final.

**TypeCheck antes de commitear**:
```bash
cd app
npx tsc --noEmit
```

### Convenciones de Git

- Branch por feature: `feat/nombre-descriptivo`, `fix/nombre`, `chore/nombre`, `docs/nombre`
- Commits con prefijo: `feat:`, `fix:`, `chore(db):`, `docs:`
- PR con título y descripción claros
- Squash and merge (no merge commit)
- Borrar branch después de mergear
- Sincronizar local: `git checkout main && git pull && git branch -d <branch>`

Por estar trabajando solo, el ruleset de protección de main está disabled (Settings → Rules en GitHub). Se reactiva cuando se sume otro dev.

---

## Modelo de datos (resumen)

### Tablas principales

**Auth y usuarios:**
- `auth.users` (gestionado por Supabase Auth)
- `public.users`: extiende auth con `display_name`, `username`, `default_avatar_id`, `custom_avatar_path`, `display_name_changed_at`
- `public.default_avatars`: 251 Pokémon, cada uno con `storage_path` en bucket

**Workspaces:**
- `public.workspaces`: grupos de Draft
- `public.workspace_members`: relación user-workspace con role (`organizer` / `member`)
- `public.workspace_invites`: códigos de invitación
- `public.workspace_join_requests`: pedidos de unirse

**Eventos:**
- `public.cubes`: catálogo de cubos por workspace (soft-delete con `deleted_at`)
- `public.venues`: catálogo de sedes por workspace (soft-delete)
- `public.draft_events`: eventos con `event_type` (`draft`/`tournament`/`pepidraft`), `status` (`scheduled`/`drafting`/`playing`/`completed`/`cancelled`)
- `public.event_participants`: inscripciones, con `rotated_avatar_id` (Pokémon que rota por evento sin reposición)
- `public.participant_colors`: colores W/U/B/R/G/C declarados por participant

**Partidas:**
- `public.pairings`: enfrentamientos de un evento. Constraint: `participant_a_id < participant_b_id`. Tiene `official_winner_participant_id` que se setea cuando se cierra el BO3.
- `public.matches`: partidas individuales. `match_type` (`draft`/`final`/`revenge`), `status`, `life_tracker_user_id` (lock por celu), `winner_participant_id`, `started_at`, `ended_at`, `ended_by_surrender`
- `public.life_events`: cada cambio de vida. Tiene `participant_id`, `resulting_life`, `delta`, `occurred_at`

**Storage:**
- Bucket `default-avatars`: 251 PNGs de Pokémon (paths como `default-avatars/unown.png`)

### Convenciones de seguridad

- RLS está ON en todas las tablas
- Helper functions: `is_workspace_member()`, `is_workspace_organizer()`
- Trigger `handle_new_user`: crea fila en `public.users` con `display_name` derivado del email (parte antes del @)
- Cualquier query desde la app respeta automáticamente las policies — no se filtra manualmente por workspace_id en general

### Migrations aplicadas

- `0001_initial_schema.sql`: schema completo inicial
- `0002_redeem_invite_code.sql`: función SECURITY DEFINER
- `0003_events_avatars_roulette.sql`: rotated avatars + ruleta
- `0004_life_tracker.sql`: deprecada (columnas dropeadas en 0005)
- `0005_drop_redundant_match_columns.sql`: limpieza
- `0006_fix_display_names.sql`: trigger de display_name desde email + backfill
- `0007_life_zero_manual_confirm.sql`: elimina trigger auto-resolve, agrega policy de DELETE para life_events
- `0008_user_display_name_change_tracking.sql`: cooldown de 14 días + índice único case-insensitive
- `0009_backup_draft_trabajador.sql`: schema separado con snapshot del Draft del Trabajador

---

## Decisiones de diseño y arquitectura

### Sistema de avatares

Cada user tiene 3 niveles de avatar, en orden de prioridad:

1. **Custom** (`users.custom_avatar_path`): foto subida por el user. Tiene la prioridad máxima.
2. **Rotated** (`event_participants.rotated_avatar_id`): Pokémon asignado al inscribirse a un evento. Distinto por evento. **Sin reposición** dentro del mismo evento (los demás participants no pueden tener el mismo).
3. **Default** (`users.default_avatar_id`): Pokémon "personal" asignado al crear cuenta. Identidad estable de cuenta.

Componente `PlayerAvatar` con prop `outsideEvent`:
- `outsideEvent={true}`: muestra inicial sobre fondo de color (consistente por user_id). Usado en WorkspacesList, WorkspaceDetail, IncomingJoinRequests.
- `outsideEvent={false}` (default): muestra Pokémon. Usado en pantallas relacionadas a eventos.

Con `withColorBorder={true}` se agrega un reborde con segmentos de los colores declarados del participant (1 a 5+ segmentos). Tiene contorno fino oscuro para visibilidad de W y C.

### Life Tracker

- Estilo Lotus: split arriba/abajo, mitad para cada jugador
- El user logueado siempre va abajo (no rotado), el oponente arriba (rotado 180°)
- Lock por celu: `match.life_tracker_user_id` apunta al device que controla. El organizer puede "tomar control".
- Umbral de estabilización: 5 segundos. Cambios de vida se persisten solo después de 5s sin tocar.
- Vidas no permiten valores negativos (clamped en 0)
- Al llegar a 0: aparece modal "¿Confirmás resultado?" con Confirmar/Cancelar.
  - Confirmar: marca match como completed con winner
  - Cancelar: hace undo del último life_event (vuelve al valor previo a llegar a 0)
- Contador de diferencial: durante el período pre-persistencia, aparece +N (verde) o -N (rojo) cerca del número de vida, mostrando cuánto se está cambiando.
- Keep-awake: la pantalla del celular no se apaga durante el LifeTracker (solo en esta pantalla).

### Pairings

- Round-robin: se generan al "Finalizar draft". Para N jugadores son N choose 2 pairings.
- Default BO3 (best of 3). Otros formatos planeados: BO1, rondas suizas, grupos+playoffs.
- En la app cada pairing tiene 2 estados: `Por definirse` (sin matches), `EN VIVO` (match in_progress), `Completado` (BO3 cerrado).
- En la lista, aparecen primero los pairings del current user, después el resto, en orden alfabético.

### Venganzas

- Match con `match_type='revenge'` posterior al cierre del BO3 oficial.
- NO impactan en `pairing.official_winner_participant_id`.
- NO cuentan en la tabla del evento (PG, PJ, EG, etc. son solo de partidas oficiales).
- SÍ se trackean para historial.
- En la UI hay pestaña separada "Venganzas" en PairingsList.

### DMV (Diferencial Medio de Vida)

Indicador en Standings que mide qué tan dominante fue cada jugador.

**Fórmula por match**:
- Tomar todos los `life_events` del match, ordenados cronológicamente por `occurred_at`
- Definir duración efectiva = `(último life_event).occurred_at - (primer life_event).occurred_at`
- Para cada estado intermedio (después del evento i, antes del evento i+1):
  - `diff = vida_propia - vida_oponente`
  - `dur = duración del estado`
  - `peso = dur / duración_efectiva`
  - Acumular: `weightedSum += diff × peso`
- El estado posterior al último evento (post-match) NO se cuenta (es resultado, no juego)
- DMV_match = weightedSum

**DMV global del jugador**: promedio simple de los DMV_match de todos sus matches con DMV calculable.

Se muestra con 1 decimal, color verde (positivo), rojo (negativo), gris (cero o null), guion ("—") si no calculable.

### Acrónimos en Standings

- **PG**: Partidas Ganadas
- **PJ**: Partidas Jugadas
- **EG**: Enfrentamientos Ganados (BO3 ganados)
- **EC**: Enfrentamientos Completados (BO3 cerrados, ganados o perdidos)
- **DMV**: Diferencial Medio de Vida
- **TMP**: Tiempo Medio por Partida (en minutos: 1 decimal si <10min, redondeado si ≥10min)

Stats al pie:
- **Completitud**: % de pairings con winner / total pairings
- **E_2-0**: % de BO3 cerrados en 2 partidas
- **E_2-1**: % de BO3 cerrados en 3 partidas
- En negrita el de mayor %

### Navegación

Patrón "hierarchical back": el botón atrás navega al padre lógico, no al historial. Implementado en helper `hierarchicalHeaderBack`. Cada pantalla setea su `headerLeft` con la pantalla padre correcta. Esto evita loops y "atrás" inesperados.

### Auto-refresh

- PairingsListScreen refresca cada 15 segundos cuando está enfocada (matches in_progress, scores en vivo).
- Otras pantallas usan realtime (subscriptions a tabla life_events, pairings) en lugar de polling.

### Realtime con cleanup

Patrón obligatorio: cuando se subscribe a realtime, usar `useRef` para guardar el channel, verificar si ya existe antes de subscribirse, cleanup en el return del useEffect con `channel.unsubscribe()` + `removeChannel(channel)`. Nombres de canal únicos (timestamp para evitar colisiones).

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
- Excepción: "Workspaces" → "Grupos de Draft" en UI (decisión del 5 de mayo de 2026)

### Manejo de errores

- Errors silenciosos NUNCA: siempre `console.error` en `__DEV__` y/o `Alert.alert`
- Para queries que pueden fallar: try/catch + fallback claro
- RLS errors deben ser visibles al usuario solo cuando son accionables (ej: "no tenés permiso")

---

## Estado actual del proyecto

### Cumplido (Objetivos 1-5 + sub-objetivos)

**Objetivo 1 - Auth**: login, signup, sesión persistente, logout

**Objetivo 2 - Workspaces**: creación, miembros, invitaciones por código, pedidos de unión, redeem function SECURITY DEFINER

**Objetivo 3 - Eventos + Ruleta**: cubos y sedes (CRUD soft-delete), eventos con event_type, inscripción, ruleta de cubos con 2 wheels (jugador elige / random) y opciones especiales

**Objetivo 4 - Life Tracker + Realtime**: LifeTracker estilo Lotus con lock por celu, persistencia con threshold, undo, rendición, abortar; MatchResult con avatar grande y confetti; Standings con bolita pulsante; navegación jerárquica; venganzas con sección propia; rectángulos BO3; layout en vivo compacto; alerts contextuales según rol

**Sub-objetivo Avatares + Colores**: PlayerAvatar reutilizable, ColorFlag, reborde con segmentos por color, contorno oscuro, prop outsideEvent

**Sub-objetivo Perfil + DMV + tweaks**: PlayerProfileInEventScreen, DMV ponderado por fracción de tiempo, navegación con fromTab para pestañas Oficiales/Venganzas, valoración invisible fuera del check-in, "Mi mazo" en lugar de "check-in"

**Sub-objetivo Build + distribución**: APK Android distribuido por link, EAS Update para iPhones (Expo Go con cuenta de Tomás), expo-keep-awake

**Sub-objetivo DMV v2 + tweaks**: DMV ponderado por fracción de tiempo (no por cantidad de eventos), keep-awake, rename "Workspaces" → "Grupos de Draft"

**Objetivo 5 - Post-draft fixes + Mi Perfil + Stats avanzados**:
- Bug del Cancel: ahora hace undo del último life_event
- Trigger `auto_resolve_match_on_zero_life` eliminado (control manual)
- display_name desde email para nuevos usuarios + backfill
- Auto-refresh en pestaña Enfrentamientos cada 15 segundos
- Tiempo de partida en historial (en cada partida del PairingDetail)
- Tiempo neto de draft (entre arrancar y finalizar)
- Formato de fechas DD/MM/YYYY HH:mm 24h sin AM/PM
- TMP en minutos con coma decimal
- Contador de diferencial en LifeTracker (verde/rojo, fade-in/out)
- Pantalla Mi Perfil (editar display_name con cooldown 14 días, validación nombre único case-insensitive, warning antes de cambiar)
- Pantalla Perfil de Miembro (read-only, otros usuarios)
- Columna EC (Enfrentamientos Completados) en Standings
- % Completitud y E_2-0 / E_2-1 en Standings con leyenda actualizada

### Datos del proyecto

**Workspace activo**: "Las buenas prácticas Draft" (id `804dbb96-c97d-4be5-a017-691657d5ece0`)

**Miembros del workspace** (al 5 de mayo de 2026):

| Display Name | Email | Rol |
|---|---|---|
| Tomás | tomas21@gmail.com | organizer |
| Karen | karen@test.com | member |
| Eli | juan@test.com | member |
| Martín | dario@test.com | member |
| Esteban | esteban@draft.com | member |
| Iván | ivan@draft.com | member |
| Manu | manu@draft.com | member |

Las passwords de prueba están guardadas por Tomás aparte (no en el repo).

**Cubos**: Tradicional, Drift, Vintage, Intermedio, Stiven
**Sedes**: Galicia, Cordero, Quito, Terralago

### Datos protegidos (NO MODIFICAR)

**Draft del Trabajador** (3 de mayo de 2026, primer draft real con la app)
- Event ID: `7f101255-cc00-4f83-9984-e1e06caa0654`
- Status: `playing` (pendiente apretar "completed" cuando se implemente)
- Datos congelados en schema `backup_draft_trabajador_20260503` (migración 0009)

Cualquier cambio de schema o lógica que pueda afectar matches, life_events, pairings o stats: **verificar primero contra el backup**.

### Eventos de prueba

- "Test 7 jugadores" (id `33af0481-9ff6-4b9a-8b21-e46ef5281eaf`): evento simulado con 7 jugadores y matches inventados, usado para testear features sin tocar datos del Draft del Trabajador.

---

## Backlog organizado por próximos Objetivos

### Objetivo 6 - Features medianas, próxima semana

**Bugs/UX que ya identificamos pero no metimos en Objetivo 5**:
- En LifeTracker: cambiar el menú "..." (3 puntos arriba) por un ícono de tacho de basura a la derecha del bloque del match. Requiere doble confirmación: ambos jugadores tocan "Abortar" desde sus dispositivos para concretar. Ventana de 3 minutos para que el segundo confirme.
- PJ no debería sumar hasta que la partida se completa (hoy suma con in_progress). Acrónimo se mantiene PJ, leyenda dice "Partidas Jugadas Finalizadas".

**Subir foto custom en Mi Perfil**:
- Avatar custom que sobreescribe el Pokémon en todos lados
- Requiere `expo-image-picker` (paquete nativo, requiere rebuild APK)
- Subir a Supabase Storage en bucket `avatars`

**Stats head-to-head en Perfil del Jugador en evento**:
- Sección debajo de los stats actuales
- Una fila por cada otro jugador del evento
- Para cada uno: rectángulos rellenos según BO3 ganados/perdidos (oficiales)
- Tap en un duelo → lleva a PairingDetail (back vuelve al perfil)
- Pestaña "Venganzas" en perfil con contador (no rectángulos), tap → PairingDetail pestaña Venganzas

**Racha global del jugador**:
- Última 5 partidas oficiales: pelotitas V (verde) / D (roja)
- Última 5 partidas totales (oficiales + venganzas): otra fila
- Mostrar en perfil del jugador

**ProDeC (Pronóstico De Colores)**:
- Antes de la valoración del mazo, votación: cada participante predice cuál fue el color más pickeado (excluyendo Incoloro)
- Resultado: podio con ganadores grandes, resto chiquitos (similar diferencia a MatchResult)
- Premio testimonial para acertantes
- Después: gráfico de barras de frecuencia de cada color en el evento

**Quién empieza la primera partida**:
- En LifeTracker, botón "Aleatorizar" que enciende/apaga avatares estilo ruleta
- Persistir en DB quién empezó
- En partidas siguientes del BO3, sugerir quién empieza (alternancia)

**Sistema de Copas con campeón actual**:
- Distinción Draft común vs Copa/Torneo
- Cada Copa (Quito, Cordero, Galicia, etc.) tiene un dibujo propio (assets externos)
- Último campeón de cada Copa tiene el dibujo al lado de su nombre
- Cuando otro gana la siguiente edición, el dibujo pasa al nuevo campeón
- Schema: tabla `cups` o campo en eventos para distinguir tipo

**Lock del Pokémon rotated**:
- Cuando alguien se desinscribe y reinscribe a un evento, mantener el rotated_avatar_id
- Evita "rerolling" del Pokémon

**Modo oscuro**:
- Sistema de theme con paleta de colores semánticos
- Toggle en settings del usuario
- Refactor de pantallas existentes para usar variables de tema

**"vs" estilizado**:
- En PairingDetail header, fuente custom
- Opciones: Bangers, Bungee, Permanent Marker (Google Fonts vía expo-font)

**Mejor miniatura/icono de la app**:
- Icon, splash, adaptive-icon
- Reemplazar los defaults de Expo

**Mejoras en banner de updates**:
- Cuando estás en LifeTracker, banner abajo que pasa de derecha a izquierda con resultados de otros pairings, cada 2-3 minutos
- Notificación arriba estilo Solo Leveling con color por jerarquía:
  - Color suave para victoria de partida
  - Color picante para victoria de BO3
- Diseño no-molesto, atractivo

**Auto-actualización entre live updates más reactivos**:
- Más allá del refresh de 15 seg, ver si vale la pena suscribirse a realtime de matches en PairingsList

**Gráfico de barras de frecuencia de colores del evento** (post-check-in):
- Aparece después que todos eligieron color
- Junto al podio del ProDeC ganador

**Tabla de venganzas en Standings (segunda pestaña)**:
- Aparece solo desde la primera venganza del evento
- Acrónimos: VG (Venganzas Ganadas), VJ (Venganzas Jugadas)
- NO tiene EG ni EC (no son BO3)
- SÍ tiene CV (Copas Venganza ganadas) y SC (Súper Copas ganadas)

**Reglas de Copas**:
- **Copa Venganza**: única por par de jugadores en el evento. La gana el primero que llega a 3 venganzas ganadas (best of 5). Una vez ganada, se cierra y no se reabre.
- **Súper Copa**: única por par de jugadores en el evento. La gana el primero que saca 2 de diferencia desde el inicio de las venganzas. Una vez ganada, se cierra y no se reabre.
- Las dos son independientes, pueden ganarlas el mismo o distintos jugadores.
- Las venganzas posteriores siguen contando al historial general (VG, VJ) pero no disputan ninguna copa.

**Pestaña Venganzas en perfil del jugador en evento**:
- Lista contra cada oponente: contador de venganzas ganadas (no rectángulos)
- Indicador de CV y SC ganadas/perdidas
- Tap → PairingDetail pestaña Venganzas

### Objetivo 7 - Features grandes

**Sistema de Ranking trimestral**:
- Tabla de ranking por workspace, por trimestre
- Fórmula: `rank = 0.6 × promedio_puntos_torneo + 0.4 × tasa_partidas_ganadas`
- Puntos por torneo: 1° = 10, 2° = 7, 3° = 5, 4° = 3, 5° = 2, 6° = 1, 7°+ = 0
- Tasa de partidas: (ganadas / jugadas) × 10
- Mínimo 5 torneos en el trimestre para entrar al ranking
- Reset al inicio de trimestre
- Histórico de trimestres anteriores
- En Copas: ponderan más que un Draft común al ranking (similar ATP 500 vs Roland Garros)

**Tabla histórica del grupo (con filtros)**:
- Stats acumulados de TODOS los eventos del workspace
- Incluye oficiales + venganzas (a diferencia de la tabla del evento)
- Filtros combinables:
  - Por cubo
  - Por sede
  - Por jugador
  - Si jugador empezó la partida o no
  - Por tipo de Pokémon avatar (ej: "todas las partidas con avatar fantasma")
  - Por color del mazo
  - Por mes/trimestre
  - Por tipo de evento (Draft, Copa, Pepidraft)
- Sistema combinable estilo Excel

**Bitácora digital**:
- Sección "Notas / fotos" por evento
- Cada jugador puede agregar contenido (texto, imágenes)
- Importación de bitácora histórica (fotos de cuadernos viejos)
- Búsqueda por texto
- Acceso desde el perfil del jugador para escribir notas (placeholder grisado hasta implementación)

**Foro de memes**:
- Sección por evento con upload de imágenes
- Reacciones (likes, comentarios)
- Límites razonables de tamaño

**Sistema "El Vasquito" (empanadas)**:
- Pantalla de pedido por evento
- Cada uno marca cuántas de cada gusto quiere
- Cálculo automático de total
- Botón "Yo hago el pedido": al que aprieta le aparece pedido completo y total general
- A los demás: su pedido individual + alias del que recoge

**Votación próximo cubo**:
- Sección con opciones que carga la gente
- Cada cubo: nombre, link a CubeCobra, descripción, número de cartas
- Cada usuario tiene 2 votos: uno de 2 puntos, otro de 1 punto
- Cierre automático según calendario (día anterior al evento)

**Realtime para todos**:
- Ruleta de cubos sincronizada con todos los espectadores (no solo el organizer)
- Updates en tiempo real de cualquier cambio relevante en la app

**Importación de bitácoras viejas**:
- Procesar fotos de bitácora histórica (vía OCR o tipeo manual)
- Insertar eventos, pairings, resultados
- Solo permite stats agregadas (no DMV histórico - faltan timestamps de life_events)

**Final del torneo**:
- Cierre automático del status a `completed` cuando se completan todos los BO3
- Para otros formatos (suizas, grupos+playoffs): criterio específico por formato
- Podio al final con primeros 3 puestos
- Solo aparece cuando son matemáticamente definitivos
- Animación final
- Correlación valoración personal vs partidas ganadas (scatter plot con avatares como puntos, R² mostrado), aparece en Standings después de las 23:59 hora Argentina

**Sistema de formatos de evento**:
- Default BO3 sigue, pero configurable a:
  - BO1
  - Rondas suizas (con o sin playoffs - definir reglas)
  - N grupos + playoffs (cantidad de grupos según jugadores)
- Cambia generación de pairings, criterios de cierre, etc.

**Decoradores temporales sobre avatar**:
- Sistema general de "layers" sobre avatar
- Activación según condiciones: fecha, clima, evento especial
- Casos:
  - Gorrito de cumpleaños (campo fecha de nacimiento en users)
  - Estaciones (verano, otoño, invierno, primavera)
  - Días de lluvia
  - Navidad, fiestas patrias
  - Otros que se vayan ocurriendo

**Pokémon shinys**:
- Probabilidad pequeña al asignar avatar (a definir, ej: 1/100)
- Sprites alternativos en bucket
- Cuentan como mismo Pokémon que su no-shiny (no es un Pokémon nuevo del pool)
- Para tipos: cuenta el primer tipo del Pokémon

### Objetivo 7A - Stats Estacionales (sub-objetivo dedicado dentro de 7)

**"Estad-Estac"**:
- Botón visible solo durante 7 días desde el inicio de cada estación (21 mar/jun/sep/dic en Argentina)
- Junto al botón, emoji de la estación de turno
- Durante esa semana: ventisca/efecto sutil de fondo en la app (estilo "está lloviendo" en PedidosYa)
- Al primer ingreso de cada usuario en la semana de cierre: auto-display de la pantalla de stats

**Pantalla de stats estacionales**:
- Múltiples páginas, swipe horizontal
- Página 1: gráfico de barras de frecuencia relativa de pickeo de cada color + gráfico de combinaciones (o monocolor) usadas
- Resto de páginas: 2 podios por página

**Premios** (todos requieren mín. 5 torneos jugados en la estación, excepto los que indican lo contrario):
- Mayor participación en torneos (n° inscripciones, sin mínimo)
- Mayor winrate en partidas oficiales
- Mayor winrate en BO3
- Mayor n° de partidas jugadas (sin mínimo)
- Mayor winrate en venganzas
- Mayor winrate en Copas Venganza ganadas / completadas
- Mayor winrate en Súper Copas ganadas / completadas

**Detalles del podio**:
- Avatar del jugador
- Abajo a la derecha del avatar (superpuesto, más chico): número del rank del jugador al primer día de la estación. Fijo: si en mitad de semana cambia el rank, no se actualiza.
- Quienes comparten posición van en el mismo podio

**Stats adicionales**:
- Tipo de Pokémon que más ganó partidas en la estación, ajustado por frecuencia base en los 251 originales (planta, fantasma, normal, etc. - cuenta el primer tipo del Pokémon, requiere mín. 1 BO3 finalizado por jugador en torneos completos)
- Pokémon más asignado en general
- Correlación valoración propia vs desempeño (scatter plot)

**Pre-trabajo necesario**:
- Enriquecer schema de `default_avatars` con `pokemon_type_1` y `pokemon_type_2`
- Cargar data estática de tipos para los 251 Pokémon
- Frecuencia base de cada tipo en los 251 (data estática)

---

## Cómo retomar el proyecto

### Si abrís una sesión nueva con Claude

Pegale este documento al inicio. Decile claramente:

> "Soy Tomás, retomo el proyecto DraftApp después de [tiempo]. Acá está la documentación. Quiero arrancar [Objetivo X / feature Y / bug Z]."

Claude debería:
- Leer el documento completo antes de proponer nada
- Usar las convenciones (Spanish rioplatense, no futuro perifrástico, naming conventions)
- Respetar el modelo de datos existente
- NO sugerir features que no le pediste
- NO darte cátedra de buenas prácticas de la industria si vos no las pediste

### Si necesitás verificar el estado actual

```bash
cd ~/Documents/code/DraftApp
git log --oneline -20
```

Te muestra los últimos 20 commits, indicando qué se hizo.

```bash
git status
```

Te muestra si hay cambios pendientes locales.

### Si necesitás ver el schema actual de DB

En Supabase Dashboard: SQL Editor → ejecutar:
```sql
select table_name from information_schema.tables 
where table_schema = 'public' order by table_name;
```

Para ver columnas de una tabla:
```sql
select column_name, data_type 
from information_schema.columns 
where table_schema = 'public' and table_name = 'TABLA' 
order by ordinal_position;
```

### Comandos rápidos para arrancar

**Iniciar Expo en local**:
```bash
cd ~/Documents/code/DraftApp/app
npx expo start
```

**Crear branch nueva para feature**:
```bash
git checkout main
git pull
git checkout -b feat/nombre-descriptivo
```

**Ciclo típico de PR**:
```bash
git add .
git commit -m "feat: descripción"
git push -u origin feat/nombre-descriptivo
# Abrir PR en GitHub, mergear (squash and merge)
git checkout main
git pull
git branch -d feat/nombre-descriptivo
```

**Publicar cambios a Expo Go (cambios JS-only)**:
```bash
cd app
$env:EXPO_TOKEN = "..."  # Si terminal nueva
eas update --branch preview --message "descripción"
```

**Rebuild APK (paquetes nativos nuevos)**:
```bash
cd app
eas build --profile preview --platform android
# Responder n cuando pregunta emulador
```

---

## Notas para Claude (la próxima IA que lea esto)

Hola Claude. Soy Tomás, dueño del proyecto. Algunas cosas que me importa que sepas antes de arrancar:

**Cómo me dirijo y cómo quiero que me hables**:
- Hablame de manera **no condescendiente** y sin abogar el diablo permanentemente.
- Quiero **mirada crítica** y advertencias prudentes sobre decisiones, implementaciones, riesgos.
- NO me trates de pelotudo. Si te pido un feature, asumo que sé lo que quiero. No me preguntes "¿estás seguro?" por features personales del grupo. Las advertencias se justifican cuando afectan **funcionalidad correcta** o cuando puedan **saturar Supabase / romper la DB / afectar performance medible**.
- Las opiniones puramente estéticas o de "buenas prácticas de la industria" o de marketing no me interesan. Esto es algo personal, no comercial. Si tu sugerencia es "mejor no lo hagas porque queda raro estéticamente" o "no es lo recomendado por la industria", guardátela.
- Si tenés preguntas legítimas, sentimientos encontrados sobre algo que pedí, o creés que hay un riesgo técnico real, **decímelo**. Eso siempre es bienvenido.
- Si voy a hacer algo que probablemente rompa cosas (riesgo técnico real), advertímelo claramente.

**Sobre el ritmo de trabajo**:
- Hago sprints cortos de 1-2 horas. Trato de cerrar features completas.
- Antes de pedirle al agente de Cursor un cambio grande, charlamos vos y yo el plan.
- Me gusta probar cada cambio en el celu antes de commitear.
- No metemos cambios mal probados a main.

**Sobre el agente de Cursor**:
- Trabajás como pair de pensamiento conmigo. El agente de Cursor escribe código.
- Cuando tengo claro qué quiero, vos me redactás el prompt para el agente.
- Yo lo copio, espero el resultado, lo testeamos juntos.

**Sobre los testeos**:
- Hago tests manuales en el celu (Expo Go en iPhone).
- Para tests con múltiples usuarios o eventos, simulamos con SQL en Supabase.
- Hay un evento "Test 7 jugadores" para no contaminar datos reales.
- El "Draft del Trabajador" tiene datos oficiales backupeados — no romper.

**Sobre commits y PRs**:
- Branch nueva por feature, PR a main, squash and merge, delete branch, sync local. Siempre.
- Mensajes de commit claros con prefijo (feat:, fix:, chore(db):, etc.)

Última cosa: este documento se va a desactualizar. Si tomás Claude algo que cambió y notás inconsistencia con la realidad del repo, **prioritizá el código** sobre el documento, y avisame para actualizar el doc.

---

Última actualización del documento: 5 de mayo de 2026.]

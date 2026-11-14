# Contrato de datos curados — DraftApp Analytics

Estado: **PROPUESTA** para revisión. Nada de esto está aplicado en la base. La implementación de referencia es
[`0155_analytics.sql`](../supabase/migrations/0155_analytics.sql); las pruebas, en [`calidad.md`](calidad.md).

El sitio lee seis tablas (`analytics.<tabla>`); el pipeline las publica como Parquet/JSON con el mismo nombre y las mismas columnas.
**Son tablas reales, no vistas**: las rellena la función `analytics_private.refresh_analytics()` (dueño `postgres`, `SECURITY DEFINER`), que aplica ahí la
exclusión voluntaria, el workspace y todas las reglas de este contrato. El rol de lectura solo hace `SELECT` (todas las tablas tienen RLS activada con una política de lectura para el rol): no calcula nada ni puede ejecutar ninguna función.
**Toda la anonimización ocurre dentro de la base**: el rol de lectura solo ve puestos e ids opacos de filas que ya pasaron todos los filtros (ver §6 y §10).

## 0. Convenciones

| Tema | Regla |
|---|---|
| Ids de jugador y de cubo | Entero (`integer`) = **puesto consecutivo 1…n**, calculado en cada refresco y DESPUÉS de aplicar la exclusión voluntaria (sin huecos): los jugadores, por un alias aleatorio privado (cambia en cada refresco); los cubos, por un orden permanente de primera publicación (estable). `jugadores.id = 12` ⇒ `nombre = 'Jugador 12'`; los cubos son `Cubo A`, `Cubo B`, …. **El número de un JUGADOR PUEDE CAMBIAR entre refrescos** (al sumar o quitar jugadores, o al aplicar una exclusión): el sitio no puede usar estos ids para seguir a alguien entre publicaciones ni guardarlos como vínculo; solo valen dentro de una misma publicación. **La letra de un CUBO es estable entre refrescos** (migración 0156): cada cubo conserva su lugar según el orden permanente en que se publicó por primera vez (`analytics_private.cube_orden`) y solo se corre si un cubo anterior deja de publicarse (borrado, sin uso o con el creador excluido); cubos nuevos reciben la letra siguiente. Mapas privados: `analytics_private.player_pos` (se rearma en cada refresco) y `cube_pos` (se rearma en cada refresco pero sobre el orden permanente `cube_orden`), sobre `player_alias` / `cube_alias` (alias aleatorios persistentes que solo sirven para ordenar y enlazar). |
| Ids de evento, enfrentamiento y partida | `bigint` de 48 bits (cabe en un entero seguro de JavaScript): los primeros 6 bytes de `HMAC-SHA256('<dominio>:<uuid>', clave de ids)`. Estables **dentro de una versión de clave**, opacos y no reversibles sin la clave. Dominios: `e` evento, `p` pairing, `b` cruce de bracket, `m` partida. La clave está **versionada** (`ids_v1`, `ids_v2`, …): rotarla cambia TODOS esos ids (ver §6). |
| Fechas | `date`. Sin horas. Hora de Buenos Aires (`America/Argentina/Buenos_Aires`). |
| Fecha de una partida | **No existe**: toda partida toma la fecha de su evento (la del draft) a través de `enfrentamiento_id → evento_id → eventos.fecha`. No se exporta `fecha_juego`. |
| Duraciones | Minutos enteros (redondeo al más cercano). `NULL` cuando no son confiables (ver cada tabla). |
| Orden de A/B | `jugador_a < jugador_b` por puesto (no por uuid), para no filtrar nada del orden interno. |
| Textos | Solo plantillas (`Jugador N`, `Cubo X`, `Evento NN`) y dominios cerrados. Ningún texto libre. |
| Alcance | Solo el workspace configurado en `analytics_private.config('workspace_id')`. |
| Exclusión voluntaria | Todo lo que involucre a un jugador en `analytics_private.player_optout` desaparece de las seis tablas **en cada refresco** (incluidos los enfrentamientos y partidas de sus rivales contra él) y de los conteos de control. Si el **creador de un cubo** está excluido, ese cubo no se publica y los eventos que lo usaron se publican igual con `cubo_id = NULL`. Al cambiar la lista (alta, baja o `TRUNCATE`), lo publicado deja de ser vigente (`analytics_control.refresco.vigente = false`) hasta el próximo refresco. Procedimiento y límites: §8. |
| Walkovers y "se fue" | **No se publican** (ver §1 y §3, C9). Solo existen como conteos en el registro de limpieza (`<5` si son pocos). |

## 1. Reglas de inclusión (qué entra a los cálculos)

**Eventos** (`draft_events`): `workspace_id` = el principal · `is_official = true` · `deleted_at is null` · `cancelled_at is null` ·
`event_type <> 'two_headed_giant'` · `status in ('drafting','playing','completed','concluded')`.
Quedan fuera: cancelados, borrados, de prueba, Gigante de dos cabezas y `scheduled` (todavía no hubo draft).
Los `playing` entran aunque no hayan terminado.

**Enfrentamientos**: los `pairings` de esos eventos con `stage` distinto de `'revenge'` (cualquier formato BO1/BO2/BO3, competición y fase)
más los cruces de `event_tiebreak_bracket_matches` con ganador cuyo grupo no esté `failed` ni `superseded` (bracket y desempates).
Los decididos por **walkover NO se publican** (misma regla que las vistas oficiales 0152/0153, que ya no los cuentan): ni el cruce ni sus partidas. Nunca entran venganzas ni copas no oficiales.

**Partidas**: `matches.status = 'completed'`, con ganador, `match_type in ('draft','final','tiebreak')` (nunca `revenge`), de un pairing
con `stage` distinto de `'revenge'`. Las `is_walkover` **no se publican**, ni tampoco las partidas de un cruce que no se publica (para no dejar partidas huérfanas); ambas cantidades
quedan en `analytics_control.anomalias`.

**Jugadores**: los que tienen al menos una participación (cualquier rol: `player`, `exile` o `ghost`) en un evento incluido y no están en la exclusión voluntaria. Así toda fila de `participaciones` y de `enfrentamientos` tiene su jugador. **Cubos**: los usados por algún evento incluido y cuyo creador no está en la exclusión voluntaria.

## 2. Tablas

### 2.1 `jugadores` — una fila por jugador con alguna participación en un evento incluido
Clave: `id`.

| Columna | Tipo | Nulo | Valores | Fuente exacta |
|---|---|---|---|---|
| `id` | integer | no | 1…n consecutivo, único | puesto en el refresco (`player_pos.pos`): `row_number()` sobre el alias aleatorio privado, después de aplicar la exclusión. Cambia entre refrescos (§0). El uuid no sale. |
| `nombre` | text | no | `Jugador <id>` | `'Jugador ' \|\| pos` |

### 2.2 `cubos` — una fila por cubo usado por algún evento incluido
Clave: `id`.

| Columna | Tipo | Nulo | Valores | Fuente exacta |
|---|---|---|---|---|
| `id` | integer | no | 1…m consecutivo, único | puesto en el refresco (`cube_pos.pos`) = `row_number()` sobre el orden PERMANENTE `analytics_private.cube_orden` (orden de primera publicación; los cubos que entran en un mismo refresco se mezclan al azar entre sí y quedan después de los ya registrados; no es el orden de alta). **Estable entre refrescos**; solo se corre si un cubo anterior deja de publicarse. |
| `nombre` | text | no | `Cubo A`, `Cubo B`, … `Cubo AA` | `'Cubo ' \|\| letras(pos)` (A = 1). El nombre real del cubo, su URL y sus notas no salen. Un cubo creado por un jugador excluido no se publica. |

### 2.3 `eventos` — una fila por evento incluido
Clave: `id`. FK: `cubo_id → cubos.id`.

| Columna | Tipo | Nulo | Valores | Fuente exacta |
|---|---|---|---|---|
| `id` | bigint | no | único | HMAC dominio `e` sobre `draft_events.id` |
| `nombre` | text | no | `Evento NN` (NN = orden por fecha, desde 01) | `row_number() over (order by fecha, created_at, id)`. El nombre real es texto libre y no sale. |
| `fecha` | date | no | | `(coalesce(draft_started_at, scheduled_for) at time zone 'America/Argentina/Buenos_Aires')::date` |
| `event_type` | text | no | `draft`, `tournament`, `pepidraft` | `draft_events.event_type` |
| `es_oficial` | boolean | no | siempre `true` | constante (solo entran oficiales; se mantiene por compatibilidad con el esquema del sitio) |
| `estado` | text | no | `drafting`, `playing`, `completed`, `concluded` | `draft_events.status` |
| `competition_format` | text | no | `round_robin`, `swiss`, `zones_knockout`, `knockout` | `draft_events.competition_format` |
| `match_format` | text | no | `bo1`, `bo2`, `bo3` | `draft_events.match_format` |
| `cubo_id` | integer | sí | FK a `cubos.id` | puesto del cubo; `NULL` si el evento no tiene cubo **o si el creador del cubo está en exclusión voluntaria** (el evento se publica igual). |
| `duracion_draft_min` | integer | sí | 5 … 480 | `round((draft_ended_at − draft_started_at)/60s)`. `NULL` si falta alguno de los dos, si `ended ≤ started`, si cae fuera de [5, 480] o si el evento es importado (`data_source <> 'app'`). |

### 2.4 `participaciones` — una fila por jugador y evento
Clave: `(evento_id, jugador_id)`. FK: `evento_id → eventos.id`, `jugador_id → jugadores.id`.

| Columna | Tipo | Nulo | Valores | Fuente exacta |
|---|---|---|---|---|
| `evento_id` | bigint | no | | HMAC dominio `e` sobre `event_participants.event_id` |
| `jugador_id` | integer | no | | alias de `event_participants.user_id` |
| `rol` | text | no | `player`, `ghost`, `exile` | `event_participants.role` |
| `colores` | text | sí | combinación exacta ordenada **W-U-B-R-G-C**, 1 a 6 letras, p. ej. `WRG` | `string_agg(participant_colors.color order by array_position(['W','U','B','R','G','C'], color))` con `member = 'a'`. **Solo si `rol = 'player'`** y el evento es de la app (importados: `NULL`, configurable). Mazos de exilio y fantasmas: `NULL`. |
| `autoevaluacion` | integer | sí | 1 … 10 | `event_participants.self_evaluation` (**se mantiene**: el sitio la usa). **Es el dato más sensible de lo publicado**: es un juicio personal ligado a un puesto en un evento; ver §5. |

Un mazo = una combinación **exacta** (`WGR` no suma a `W`, `G`, `R` ni a `WG`), un mazo por jugador y evento.

### 2.5 `enfrentamientos` — una fila por cruce (pairing o cruce de bracket/desempate)
Clave: `id`. FK: `evento_id → eventos.id`, `jugador_a`/`jugador_b`/`ganador_id → jugadores.id`.

| Columna | Tipo | Nulo | Valores | Fuente exacta |
|---|---|---|---|---|
| `id` | bigint | no | único | HMAC dominio `p` sobre `pairings.id` **o** dominio `b` sobre `event_tiebreak_bracket_matches.id` |
| `evento_id` | bigint | no | | HMAC `e` sobre el evento |
| `ronda` | integer | sí | ≥ 1; solo suizo | `pairings.swiss_round` (round robin y fases finales: `NULL`) |
| `fase` | text | no | `regular`, `zona`, `interzonal`, `llave`, `desempate`, `top4`, `desempate_1er_puesto`, `desempate_4to_puesto`, `segunda_chance`, `otro` | pairings: `stage` (`null`→`regular`, `zone`→`zona`, `interzonal`, `bracket`→`llave`). Bracket: `event_tiebreak_groups.group_origin` (`tiebreak`→`desempate`, `swiss_topcut` y `round_robin_topcut`→`top4`, `round_robin_first_place`→`desempate_1er_puesto`, `round_robin_fourth_place`→`desempate_4to_puesto`, `knockout_bracket`→`llave`, `knockout_second_chance`→`segunda_chance`). |
| `etapa` | text | sí | `round_of_16`, `quarter`, `semi`, `final`, `tercer_puesto` | `event_tiebreak_bracket_matches.bracket_phase` (pairings: `NULL`) |
| `jugador_a` | integer | no | `< jugador_b` | `least(alias_a, alias_b)` |
| `jugador_b` | integer | no | | `greatest(alias_a, alias_b)` |
| `ganador_id` | integer | sí | `jugador_a` o `jugador_b` | alias del ganador. `NULL` si `resultado` ≠ `victoria`. |
| `resultado` | text | no | `victoria`, `empate`, `pendiente` | `official_winner_participant_id` no nulo → `victoria`; `official_draw` → `empate` (BO2 1-1); si no, `pendiente` (sin resolver pero con al menos una partida completada) |
| `con_mazo_prestado` | boolean | no | | alguna partida completada del cruce, no walkover, con `is_borrowed_deck_a` o `_b` |

Participan jugadores de rol `player` **o** `exile` (el exilio juega con mazo prestado); los fantasmas no juegan.

### 2.6 `partidas` — una fila por partida individual oficial
Clave: `id`. FK: `enfrentamiento_id → enfrentamientos.id`. Única: `(enfrentamiento_id, numero)`.

| Columna | Tipo | Nulo | Valores | Fuente exacta |
|---|---|---|---|---|
| `id` | bigint | no | único | HMAC dominio `m` sobre `matches.id` |
| `enfrentamiento_id` | bigint | no | | `draft` y `final`: el pairing (`p`). `tiebreak`: el cruce de bracket (`b`) con `pairing_id` igual y `round_number = coalesce(tiebreak_round, 1)`; si no hay, el pairing. |
| `numero` | integer | no | ≥ 1 | `matches.match_number` |
| `tipo` | text | no | `draft`, `final`, `tiebreak` | `matches.match_type` (nunca `revenge`) |
| `estado` | text | no | siempre `completed` | constante |
| `jugador_a` | integer | no | `< jugador_b` | `least` de los alias de los dos participantes del pairing |
| `jugador_b` | integer | no | | `greatest` |
| `ganador_id` | integer | no | `jugador_a` o `jugador_b` | alias de `matches.winner_participant_id` |
| `empieza_id` | integer | sí | `jugador_a`, `jugador_b` o `NULL` | alias de `matches.who_started_participant_id`; `NULL` = sin dato (no existe en los primeros eventos) |
| `duracion_min` | integer | sí | 1 … 240 | `round((ended_at − started_at)/60s)`. `NULL` si falta algún extremo, si `ended ≤ started`, si cae fuera de [1, 240] o si la partida/evento es importado. |
| `mazo_prestado_a` | boolean | no | | `is_borrowed_deck_a` o `_b` según el orden por alias (asunción A3 del SQL) |
| `mazo_prestado_b` | boolean | no | | ídem |
| `dif_vida_final` | integer | sí | sin límites (puede ser negativo o 0) | **(0158)** Vida final del **ganador** menos la del **perdedor**. Vida final de cada lado = `life_events.resulting_life` del último evento de esa partida para ese participante (orden `occurred_at desc, id desc`; igual que `achv_eval_largar_el_blanco`, 0123); si un lado no tiene eventos, su vida inicial (`starting_life_a`/`starting_life_b` según sea el participante A o B del pairing). `NULL` si la partida **no tiene ningún** `life_events` (no se usa la vida inicial en ese caso). No se recorta: un abandono o una rendición pueden dar negativo o 0. |

## 3. Cambios propuestos respecto del esquema que ya usa el sitio

El esquema del sitio se respeta; estos son los cambios y por qué. Los marcados **(aditivo)** no rompen nada.

| # | Cambio | Motivo |
|---|---|---|
| C1 | `enfrentamientos.resultado` **(aditivo)**: `victoria` / `empate` / `pendiente` | Empate BO2 como resultado propio. `ganador_id = NULL` ya significaba "sin ganador"; ahora se distingue empate de pendiente. El sitio puede seguir filtrando por `ganador_id is not null`. |
| C2 | `enfrentamientos.fase` cambia de dominio y se agrega `etapa` **(aditivo)** | La base no tiene "final" como fase: distingue pairings, desempates, top 4, llaves y zonas. La "final" es `fase = 'top4'` + `etapa = 'final'`. El sintético usaba `regular/desempate/final/venganza`; `venganza` ya no existe (nunca entran). |
| C3 | `enfrentamientos.con_mazo_prestado` y `partidas.mazo_prestado_a/_b` **(aditivos)** | Mazos prestados "marcados y fuera de las estadísticas de color": el sitio debe poder excluir esas partidas/cruces del cálculo por combinación. |
| C4 | `participaciones.rol` admite `exile` y `colores` es `NULL` fuera de `player` | Exilio y fantasmas marcados y fuera del color. |
| C5 | **Se elimina `partidas.fecha_juego`** | No lo usa ningún gráfico y la decisión es que toda partida toma la fecha del evento. Exportarlo agregaría un cuasi-identificador (días de juego por jugador) sin beneficio. |
| C6 | `eventos.estado` (ya estaba) toma `drafting/playing/completed/concluded`; `es_oficial` es siempre `true` | Solo entran oficiales. |
| C7 | Ids de evento, enfrentamiento y partida son `bigint` opacos (antes enteros secuenciales) | Dependen de la clave de ids (versionada); no son consecutivos ni cronológicos. El sitio solo los usa como clave. |
| C8 | `partidas.estado` es siempre `completed` | Las abortadas/en curso no entran. |
| C10 | `jugadores.id` y `cubos.id` son puestos consecutivos 1…n (antes: alias aleatorios estables) | Sin huecos no se deduce a quién se excluyó, y el número no revela el orden de alta. **`jugadores.id` NO es estable entre publicaciones. `cubos.id` (la letra del cubo) SÍ lo es desde la 0156** (orden permanente de primera publicación; se corre solo si un cubo anterior deja de publicarse). |
| C9 | **Se eliminan `enfrentamientos.es_walkover`, `partidas.es_walkover` y `participaciones.se_fue`** | Los walkovers (cruces y partidas) se filtran en el refresco y no se publican; "se fue" no se exporta (revela un hecho personal por evento). Los conteos quedan solo agregados en `analytics_control.anomalias`. `participaciones.autoevaluacion` se mantiene. |
| C11 | **Se agrega `partidas.dif_vida_final`** (integer, nullable, **aditivo**; migración [`0158`](../supabase/migrations/0158_partidas_dif_vida_final.sql)) | Diferencial de vida final de cada partida (§2.6). Mismo universo de partidas que antes: ningún filtro cambió. Hoy 416 de 423 partidas tienen dato (98 %); las demás no tienen `life_events`. |

### Impacto en el sitio (para la migración del loader, no se toca en esta entrega)
- **(0158) `partidas.dif_vida_final`** es una columna nueva: en **DraftApp-analytics** (no se toca desde acá) habría que: (1) agregarla a la **lista de columnas esperadas / validación de esquema** de `analytics.partidas` del loader (si el loader compara contra una lista exacta, falla con una columna de más); (2) agregarla al `SELECT` de la extracción y al esquema del Parquet/JSON publicado; (3) tratar `NULL` como "sin dato" (no como 0); (4) actualizar sus pruebas/fixtures y su copia del contrato. Hasta que lo haga, la extracción con `select *` recibirá la columna extra: confirmar antes de aplicar la migración si el loader tolera columnas nuevas.
- `datos.js` descarta una partida si algún lado no tiene mazo en `participaciones` con `rol = 'player'`; con exilio eso saca también partidas de las estadísticas de **duración**. Conviene separar: excluir por color (`mazo_prestado_*` o rol `exile`) pero no por duración.
- `datos.js` ya excluye `es_walkover`, `fase = 'venganza'` y `ganador_id is null`; con el contrato real **desaparecen `es_walkover` (enfrentamientos y partidas) y `se_fue` (participaciones)**: hay que quitar esas referencias del loader (los walkovers ya no llegan). Basta con excluir `resultado <> 'victoria'` (y las partidas con `mazo_prestado_*` en el gráfico de color).
- `inscriptos` sale de contar participaciones `rol = 'player'` por evento.
- La exclusión voluntaria reduce `inscriptos` y los enfrentamientos de los rivales de quien se excluyó.
- Sin `se_fue` el sitio ya no puede distinguir a quien abandonó: `inscriptos` sigue siendo el conteo de participaciones `rol = 'player'`.
- `jugadores.id` no es estable entre publicaciones (C10): el sitio no debe guardarlo ni enlazar por él. `cubos.id` (la letra) es estable salvo que un cubo anterior deje de publicarse; igual conviene no usarlo como vínculo permanente.
- El sitio debe mostrar el **registro de limpieza** (`analytics_control.registro_limpieza`, §7) y aclarar que los datos están **seudonimizados, no anonimizados**.

## 4. Qué NO sale nunca
Nombres, usernames, emails, género, cumpleaños (`birthday`, `birth_date`), avatares y shiny, textos libres (nombre/notas de evento, de cubo y de sede, motivos, bitácoras, `giant_name`, `move_name`), sedes, uuids, puestos finales y campeón por evento, hora de cualquier timestamp, `fecha_juego`, **walkovers y "se fue"**, telemetría por turno o por vida, invitaciones, y todo lo de `context_free_*`, `tg_*`, `audit_log`, `event_media`, `dice_rolls` y `event_seating`.

## 5. Riesgos de reidentificación que este contrato NO elimina
**`autoevaluacion` es el dato más sensible de lo publicado** (un juicio personal de cada jugador sobre sí mismo, ligado a un puesto y a un evento). Se mantiene porque el sitio la usa. **El sitio debe aclarar que se trata de seudonimización, no de anonimato**: en una comunidad chica quien estuvo en un evento puede reconocer a una persona por colores, resultados y autoevaluación.

Con una comunidad chica donde todos se conocen, el alias es seudonimización, no anonimato: quien asistió a un evento conoce fecha, colores y resultados. Este contrato reduce el riesgo (fecha al día sin horas, sin textos, sin ids reales, sin puestos ni campeón, ids opacos, exclusión voluntaria) pero no lo anula. Mitigaciones posibles y todavía no decididas: fecha gruesa (semana/mes), agrupar jugadores con pocas partidas, supresión de celdas chicas en el sitio. La lista de exclusión voluntaria es la salvaguarda principal.

## 6. Refresco, alias y clave de ids

**Refresco.** `analytics_private.refresh_analytics()` es la única forma de escribir las tablas `analytics.*` y `analytics_control.*`. En una sola transacción: toma el candado de `player_optout`
(§8), sincroniza los alias privados (`sync_aliases()`), borra y vuelve a llenar las seis tablas, arma los puestos 1…n (`player_pos`, `cube_pos`) DESPUÉS de aplicar la exclusión, calcula los controles y registra la
fecha y la versión de clave en `analytics_control.refresco`. Solo la ejecuta el dueño (`pg_cron` o paso manual; agenda en el bloque 13 de la migración). El rol de lectura no puede ejecutarla ni ninguna otra función. El pipeline exige
`refresco.vigente` y que el refresco sea reciente antes de leer nada (calidad.md, P-FRE-01).

**Por qué tablas y no vistas.** Una vista cuyo dueño es `postgres` se evalúa con los permisos del dueño, pero PostgreSQL puede aplicar los filtros que escribe el usuario *antes* que el filtro de la vista. Con una función temporal con
`RAISE NOTICE` (cualquier rol puede crearlas: `TEMP` lo tiene `PUBLIC`) o un cast/división que falla, un rol de lectura podía observar valores de filas que la vista descartaba (jugadores excluidos). Con tablas ya filtradas no existe
esa fila. `prueba_pglite.mjs` reproduce ambos ataques: contra una vista con filtro de exclusión SÍ filtran; contra las tablas, no.

**Alias y puestos.** Hay dos niveles. (1) Alias **privados y persistentes** (`player_alias`, `cube_alias`): un número al azar, uniforme dentro del rango fijo `[1, alias_max]` (99999 por defecto), independiente del orden de alta y de la
cantidad de usuarios; nunca se reutiliza. Cuentas borradas: `user_id` pasa a `NULL` y el `alias_n` se conserva. Solo sirven para ordenar. (2) **Puestos públicos** consecutivos 1…n, rearmados en cada refresco y después de la
exclusión: lo publicado nunca tiene huecos. **Jugadores:** `row_number()` sobre el alias privado; **los puestos pueden cambiar entre refrescos.** **Cubos (0156):** `row_number()` sobre el orden permanente `analytics_private.cube_orden`, que se registra la primera vez que un cubo se publica (los que entran juntos se mezclan al azar entre sí y quedan después de los ya registrados); **las letras son estables** y solo se corren si un cubo anterior deja de publicarse. Un cubo cuyo creador se excluye deja de publicarse; si vuelve a quedar incluido, recupera su orden. El orden revela la fecha de primera publicación del cubo (ya deducible de `eventos.fecha`), nunca el orden de creación. Los controles que miran lo publicado (`v_privacidad_calc`, `v_conciliacion_calc` y la anomalía `participaciones_player_sin_partidas`) pasan por los mismos mapas; la prueba
tiene controles positivos que fallan si no lo hacen.

**Clave de ids: versionado y rotación.** La clave vive en `analytics_private.secret` con un nombre de versión (`ids_v1`) y `config('clave_activa')` indica cuál se usa. Procedimiento de rotación:
1. `insert into analytics_private.secret (name, value) values ('ids_v2', encode(extensions.gen_random_bytes(32), 'hex'));`
2. `update analytics_private.config set value = 'ids_v2' where key = 'clave_activa';`
3. `select analytics_private.refresh_analytics();`
4. Republicar todo: **cambian TODOS los ids opacos de eventos, enfrentamientos y partidas** (no se pueden mezclar versiones; los vínculos por id dejan de valer). Los alias privados no dependen de la clave.
5. Verificar la publicación nueva y borrar la clave vieja (o archivarla fuera de la base).
Rotar no des-publica lo ya publicado: quien conozca la clave vieja puede seguir calculando los ids viejos.

## 7. Controles y registro de limpieza

Hay dos niveles, separados a propósito:
1. **Controles exactos internos** (`analytics_private.control_anomalias`, `control_privacidad`, `control_conciliacion`): conteos reales, **no se publican** y solo los lee quien administra (calidad.md, P-PRIV-17). La conciliación
   compara lo publicado contra la **regla de publicación** (no contra la vista cruda de la app: las partidas reales de un cruce decidido por walkover no se publican y se excluyen también del lado de la app; §1) y devuelve solo `total_app`, `total_curado` y la *cantidad* de jugadores con diferencia (nunca cuáles). Todos se calculan con la exclusión voluntaria aplicada.
2. **Lo que ve el pipeline** (`analytics_control`): `refresco` (fecha, versión de clave, vigencia), `verificacion` (solo pasa / no pasa por chequeo) y `registro_limpieza`.

**`registro_limpieza` es público para el sitio**: una fila por concepto de limpieza (partidas con duración descartada, walkovers no publicados, partidas sin dato de quién empieza, importadas, etc.) con la cantidad **como texto**.
Toda cantidad menor a 5 se muestra como `<5` (umbral `config('umbral_registro')`); nunca hay diferencias ni detalle por jugador. Sirve para que el sitio diga con transparencia cuánto se dejó afuera.

## 8. Exclusión voluntaria: procedimiento y límites

- **Procedimiento.** Alta en `analytics_private.player_optout` → el estado pasa a `vigente = false` (trigger; también con `DELETE`, `UPDATE` y `TRUNCATE`) → **correr el refresco a mano** (`select analytics_private.refresh_analytics();`) → **volver a ejecutar la publicación**.
  Una exclusión nueva NO surte efecto en lo publicado hasta que se hagan esos dos pasos; el pipeline se detiene mientras `vigente = false` (P-FRE-01).
- **Concurrencia.** El refresco toma `LOCK TABLE analytics_private.player_optout IN SHARE MODE` al comenzar: una alta o baja concurrente espera a que termine el refresco y queda marcada como no vigente después. Verificado en PGlite solo por el modo de bloqueo
  que sostiene el refresco (una sola conexión no permite simular la concurrencia real).
- **Límite.** **Lo ya publicado antes de la exclusión sigue existiendo en snapshots, artefactos, cachés de CDN y copias externas** (Pages, navegadores, archivos históricos): esta base no puede retirarlo. La exclusión protege las publicaciones futuras.
- **Cubos.** Si el creador de un cubo está excluido, el cubo no se publica y los eventos quedan con `cubo_id = NULL` (siguen publicándose).

## 9. Privilegios por defecto y verificación por migración

- **Paso previo a cada migración:** `select defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, defaclacl from pg_default_acl;` — anotar qué privilegios por defecto vigentes (globales de Supabase o por esquema) alcanzarían a `anon`, `authenticated`, `service_role` o `PUBLIC` sobre objetos nuevos de `analytics*`.
- **Dentro de la migración:** `REVOKE` explícito sobre cada objeto nuevo de `analytics`, `analytics_private` y `analytics_control` (los `ALTER DEFAULT PRIVILEGES ... IN SCHEMA` de la migración solo cubren lo otorgado a nivel de esquema; no anulan los defaults globales ni el `EXECUTE` de `PUBLIC` sobre funciones nuevas).
- **Después de cada migración:** correr `P-PRIV-01` (privilegios efectivos con `aclexplode`, `has_table_privilege`, `has_function_privilege` y `has_schema_privilege`), `P-PRIV-09`, `P-PRIV-11` a `P-PRIV-18`.
- **Evidencia de PGlite.** La prueba en memoria (`prueba_pglite.mjs`) corre como **superusuario**: no demuestra nada sobre privilegios por defecto ni sobre los defaults globales de Supabase. Por eso se **retiró** de la prueba la comprobación de "objetos nuevos nacen sin privilegios" (antes L6). La
  evidencia de que los privilegios por defecto no abren nada es `P-PRIV-01` en la base viva. En PGlite sí tienen valor las pruebas de RLS, de `SET ROLE analytics_reader` y de los ataques, porque ahí se cambia a un rol sin privilegios.

## 10. Seguridad del rol de lectura

**10.1 Lo que puede y no puede.** `analytics_reader` se conecta, usa los esquemas `analytics` y `analytics_control` y hace `SELECT` (con RLS y una política `using (true)`) sobre las tablas del contrato y sobre `refresco`, `verificacion` y `registro_limpieza`. No tiene
`USAGE` sobre `analytics_private`, no ejecuta funciones propias (ni `extensions.hmac` por concesión de la migración) ni lee los controles exactos. El dueño y el refresco saltan la RLS (no hay `FORCE ROW LEVEL SECURITY`).

**10.2 Realtime.** Ningún objeto de `analytics*` debe figurar en publicaciones de Realtime ni existir una publicación `FOR ALL TABLES` (incluiría los objetos nuevos). Chequeo: `P-PRIV-15` (consulta sobre `pg_publication_tables` y `pg_publication`).

**10.3 API de Supabase.** Hay que **verificar a mano** que `db_schemas` de la API (panel: Settings → API → Exposed schemas) **no liste** `analytics`, `analytics_private` ni `analytics_control`. `P-PRIV-16` solo mira la configuración del rol `authenticator` (`pgrst.db_schemas`), que no sustituye
la revisión del panel.

**10.4 Privilegios por defecto.** Ver §9.

**10.5 Alcance de las pruebas.** Ver §9 (PGlite no prueba privilegios por defecto).

**10.6 Riesgo aceptado: una credencial filtrada puede abusar de `TEMP` y de `SET`.** Es una decisión consciente, no una laguna:
- `TEMP` sobre la base lo tiene `PUBLIC`: cualquier rol que se conecte puede crear tablas y funciones temporales. Un `REVOKE` solo para `analytics_reader` no sirve (la concesión a `PUBLIC` sigue vigente) y revocarlo a `PUBLIC` afectaría a todos los demás roles
  (herramientas, ORMs y funciones de Supabase que usan temporales). **No se hace.**
- El rol puede cambiar sus propios `SET`: `default_transaction_read_only`, `statement_timeout`, `lock_timeout` y `idle_in_transaction_session_timeout` son un cinturón, **no una barrera**. La barrera real es que el rol no tenga privilegios de escritura ni sea dueño de nada.
- **Riesgo de disco:** con la credencial, alguien puede **llenar el disco con tablas temporales** (no hay límite por rol sobre tablas temporales; `temp_file_limit` no las cubre y es un parámetro de superusuario que no se puede fijar por rol en Supabase). Un atacante con la credencial también puede consumir
  CPU/memoria hasta el límite de conexiones (2) y los timeouts que él mismo puede cambiar.
- **Lo que NO se filtra:** con tablas ya filtradas, un objeto temporal o un cast que falla no puede observar filas de jugadores excluidos (no existen en lo que el rol puede leer). El riesgo es de disponibilidad, no de confidencialidad.
- **Mitigaciones a aplicar (operativas):**
  1. **Contraseña larga** (generada, ≥ 32 caracteres), fijada fuera de banda (`ALTER ROLE analytics_reader PASSWORD ...`) y rotada ante cualquier sospecha.
  2. **Secreto en un Environment protegido de GitHub**, restringido a la rama `main` (no a pull requests ni a ramas), con revisores si hace falta; nunca en el repositorio ni en logs.
  3. **La extracción lee todo en una sola transacción** `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; ...; COMMIT;`, corta y de solo lectura.
  4. **Job de `pg_cron`** (si la extensión está disponible; no lo pude comprobar) que cierra las sesiones de `analytics_reader` con más de 5 minutos (bloque 13 de la migración). Si no hay `pg_cron`, revisión manual de `pg_stat_activity`.
  5. Vigilar el espacio en disco del proyecto y las conexiones de `analytics_reader` (`pg_stat_activity`).

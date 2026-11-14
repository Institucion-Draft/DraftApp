# Pruebas de calidad previas a publicar

Estado: **PROPUESTA**. Contrato en [`contrato.md`](contrato.md); tablas, refresco y rol en [`0155_analytics.sql`](../supabase/migrations/0155_analytics.sql).

## Cómo se corren

- **Quién:** el pipeline, conectado como `analytics_reader`, **antes** de escribir ningún archivo. Si falla una prueba **BLOQUEA**, no se publica
  nada y se conserva la publicación anterior. Las de severidad **AVISO** se publican en el resumen de la corrida pero no frenan.
- **Cada consulta devuelve un solo número** (`n`) salvo que se indique. Todas son de solo lectura sobre las TABLAS `analytics.*` y `analytics_control.*`
  (rellenadas por `analytics_private.refresh_analytics()`; el pipeline no la ejecuta ni puede ejecutarla). Todas tienen RLS con una política de lectura para el rol.
- **Controles: dos niveles.** El pipeline solo ve `analytics_control.verificacion` (pasa / no pasa) y `analytics_control.registro_limpieza` (conteos con `<5`). Los controles
  **exactos** (`analytics_private.control_anomalias`, `control_privacidad`, `control_conciliacion`) no se publican y solo los lee quien administra (pruebas **ADMIN**).
- **Extracción en una sola transacción:** `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; ...; COMMIT;`, corta (debe terminar antes de los 5 minutos del job de limpieza de sesiones; contrato.md §10.6).
- **Antes que nada** corre `P-FRE-01` (el refresco está vigente y es reciente). Si falla, no se mira nada más: se corre el refresco (cron o paso manual) y se reintenta.
- Las pruebas marcadas **ADMIN** (`P-PRIV-0x`) las corre una persona con un rol administrativo, **no** el pipeline: antes del primer
  uso, después de cada migración que toque `analytics*` y cada vez que se rote la contraseña. El rol de lectura no puede ver esos catálogos.
- Los umbrales de volumen (`P-VOL`) son **iniciales**: se calibran con la primera corrida real y después se mantienen contra la publicación anterior.
- El pipeline guarda en memoria las seis tablas leídas y publica **exactamente esas filas** (la consulta de la prueba y el archivo deben coincidir: `P-ARCH-01`).

Nomenclatura: `n = 0` quiere decir "la consulta devuelve cero filas que violen la regla".

---

## A. Estructura y claves

| ID | Verifica | Consulta | Umbral | Sev. |
|---|---|---|---|---|
| P-EST-01 | Columnas exactas por tabla (nada de más, nada de menos). Devuelve las columnas **inesperadas o faltantes**. | Ver el bloque `P-EST-01` abajo. | `n = 0` | BLOQUEA |
| P-CLV-01 | `jugadores.id` único | `select count(*) - count(distinct id) from analytics.jugadores` | 0 | BLOQUEA |
| P-CLV-02 | `cubos.id` único | `select count(*) - count(distinct id) from analytics.cubos` | 0 | BLOQUEA |
| P-CLV-03 | `eventos.id` único | `select count(*) - count(distinct id) from analytics.eventos` | 0 | BLOQUEA |
| P-CLV-04 | `participaciones (evento_id, jugador_id)` único | `select count(*) from (select 1 from analytics.participaciones group by evento_id, jugador_id having count(*) > 1) t` | 0 | BLOQUEA |
| P-CLV-05 | `enfrentamientos.id` único (los ids de pairing y de bracket usan dominios distintos) | `select count(*) - count(distinct id) from analytics.enfrentamientos` | 0 | BLOQUEA |
| P-CLV-06 | `partidas.id` único | `select count(*) - count(distinct id) from analytics.partidas` | 0 | BLOQUEA |
| P-CLV-07 | `partidas (enfrentamiento_id, numero)` único | `select count(*) from (select 1 from analytics.partidas group by enfrentamiento_id, numero having count(*) > 1) t` | 0 | BLOQUEA |
| P-CLV-08 | Alias de jugador sin duplicados (resultado pasa/no pasa de la verificación interna) | `select count(*) from analytics_control.verificacion where chequeo = 'privacidad:alias_duplicado' and not ok` | 0 | BLOQUEA |

Bloque `P-EST-01` (lista blanca de columnas; se compara contra `information_schema`, que para el rol solo muestra lo que puede leer). **Ya no existen** `participaciones.se_fue` ni `es_walkover` en `enfrentamientos` y `partidas` (M5): si reaparecen, falla:

```sql
with esperado(tabla, columna) as (values
  ('jugadores','id'),('jugadores','nombre'),
  ('cubos','id'),('cubos','nombre'),
  ('eventos','id'),('eventos','nombre'),('eventos','fecha'),('eventos','event_type'),('eventos','es_oficial'),('eventos','estado'),
  ('eventos','competition_format'),('eventos','match_format'),('eventos','cubo_id'),('eventos','duracion_draft_min'),
  ('participaciones','evento_id'),('participaciones','jugador_id'),('participaciones','rol'),('participaciones','colores'),
  ('participaciones','autoevaluacion'),
  ('enfrentamientos','id'),('enfrentamientos','evento_id'),('enfrentamientos','ronda'),('enfrentamientos','fase'),('enfrentamientos','etapa'),
  ('enfrentamientos','jugador_a'),('enfrentamientos','jugador_b'),('enfrentamientos','ganador_id'),('enfrentamientos','resultado'),
  ('enfrentamientos','con_mazo_prestado'),
  ('partidas','id'),('partidas','enfrentamiento_id'),('partidas','numero'),('partidas','tipo'),('partidas','estado'),
  ('partidas','jugador_a'),('partidas','jugador_b'),('partidas','ganador_id'),('partidas','empieza_id'),
  ('partidas','duracion_min'),('partidas','mazo_prestado_a'),('partidas','mazo_prestado_b'),('partidas','dif_vida_final')),
real as (select table_name as tabla, column_name as columna from information_schema.columns where table_schema = 'analytics')
select count(*) as n from (
  (select * from real except select * from esperado)
  union all
  (select * from esperado except select * from real)) d;
```

## B. Dominios y formato

Todas devuelven la cantidad de filas que **violan** la regla; umbral `0`, severidad **BLOQUEA** salvo que se indique.

| ID | Regla | Consulta |
|---|---|---|
| P-DOM-01 | Nombres de plantilla | `select (select count(*) from analytics.jugadores where nombre !~ '^Jugador [0-9]+$') + (select count(*) from analytics.cubos where nombre !~ '^Cubo [A-Z]+$') + (select count(*) from analytics.eventos where nombre !~ '^Evento [0-9]{2,}$')` |
| P-DOM-02 | `eventos`: dominios cerrados | `select count(*) from analytics.eventos where event_type not in ('draft','tournament','pepidraft') or estado not in ('drafting','playing','completed','concluded') or es_oficial is not true or match_format not in ('bo1','bo2','bo3') or fecha is null or nombre is null` |
| P-DOM-03 | `eventos.competition_format` (AVISO: la base puede tener valores no previstos, p. ej. `swiss_bo2`; revisar antes de agregarlos al sitio) | `select count(*) from analytics.eventos where competition_format not in ('round_robin','swiss','zones_knockout','knockout')` — **AVISO** |
| P-DOM-04 | Rango de fechas: entre 2015-01-01 y hoy (hora de Buenos Aires) | `select count(*) from analytics.eventos where fecha < date '2015-01-01' or fecha > (now() at time zone 'America/Argentina/Buenos_Aires')::date` |
| P-DOM-05 | `duracion_draft_min` en [5, 480] o NULL | `select count(*) from analytics.eventos where duracion_draft_min is not null and duracion_draft_min not between 5 and 480` |
| P-DOM-06 | `participaciones`: rol, color y autoevaluación | `select count(*) from analytics.participaciones where rol not in ('player','ghost','exile') or (colores is not null and (colores !~ '^W?U?B?R?G?C?$' or colores = '')) or (rol <> 'player' and colores is not null) or (autoevaluacion is not null and autoevaluacion not between 1 and 10)` |
| P-DOM-07 | `enfrentamientos`: dominios y coherencia de `resultado` | `select count(*) from analytics.enfrentamientos where fase not in ('regular','zona','interzonal','llave','desempate','top4','desempate_1er_puesto','desempate_4to_puesto','segunda_chance','otro') or (etapa is not null and etapa not in ('round_of_16','quarter','semi','final','tercer_puesto')) or resultado not in ('victoria','empate','pendiente') or (resultado = 'victoria' and ganador_id is null) or (resultado <> 'victoria' and ganador_id is not null) or (ganador_id is not null and ganador_id not in (jugador_a, jugador_b)) or jugador_a >= jugador_b or (ronda is not null and ronda < 1) or con_mazo_prestado is null` |
| P-DOM-08 | `partidas`: dominios y coherencia | `select count(*) from analytics.partidas where tipo not in ('draft','final','tiebreak') or estado <> 'completed' or numero < 1 or ganador_id is null or ganador_id not in (jugador_a, jugador_b) or jugador_a >= jugador_b or (empieza_id is not null and empieza_id not in (jugador_a, jugador_b)) or (duracion_min is not null and duracion_min not between 1 and 240) or mazo_prestado_a is null or mazo_prestado_b is null` |
| P-DOM-09 | Tipo de dato (`fecha` es `date`, sin horas; ids enteros seguros de JS: < 2^53) | `select count(*) from analytics.eventos where id >= 9007199254740992 or id < 0` (idem para `enfrentamientos.id`, `partidas.id`, `participaciones.evento_id`) |
| P-DOM-10 | Duración de partida y de draft: ningún valor 0 ni negativo (el pipeline publica NULL, nunca 0) | `select (select count(*) from analytics.partidas where duracion_min <= 0) + (select count(*) from analytics.eventos where duracion_draft_min <= 0)` |

## C. Referencias

Anti-joins: cada consulta cuenta las filas huérfanas. Umbral `0`, **BLOQUEA**.

| ID | Regla | Consulta |
|---|---|---|
| P-REF-01 | `eventos.cubo_id → cubos.id` | `select count(*) from analytics.eventos e where e.cubo_id is not null and not exists (select 1 from analytics.cubos c where c.id = e.cubo_id)` |
| P-REF-02 | `participaciones → eventos` y `→ jugadores` | `select count(*) from analytics.participaciones p where not exists (select 1 from analytics.eventos e where e.id = p.evento_id) or not exists (select 1 from analytics.jugadores j where j.id = p.jugador_id)` |
| P-REF-03 | `enfrentamientos → eventos`, y sus tres jugadores → `jugadores` | `select count(*) from analytics.enfrentamientos x where not exists (select 1 from analytics.eventos e where e.id = x.evento_id) or not exists (select 1 from analytics.jugadores j where j.id = x.jugador_a) or not exists (select 1 from analytics.jugadores j where j.id = x.jugador_b)` |
| P-REF-04 | `partidas → enfrentamientos` | `select count(*) from analytics.partidas p where not exists (select 1 from analytics.enfrentamientos e where e.id = p.enfrentamiento_id)` |
| P-REF-05 | Los jugadores de una partida son los del enfrentamiento | `select count(*) from analytics.partidas p join analytics.enfrentamientos e on e.id = p.enfrentamiento_id where (p.jugador_a, p.jugador_b) <> (e.jugador_a, e.jugador_b)` |
| P-REF-06 | Todo jugador que juega un enfrentamiento tiene participación en ese evento (rol `player` o `exile`) | `select count(*) from analytics.enfrentamientos x cross join lateral (values (x.jugador_a),(x.jugador_b)) j(id) where not exists (select 1 from analytics.participaciones p where p.evento_id = x.evento_id and p.jugador_id = j.id and p.rol in ('player','exile'))` |
| P-REF-07 | Todo jugador de `jugadores` tiene al menos una participación (cualquier rol) | `select count(*) from analytics.jugadores j where not exists (select 1 from analytics.participaciones p where p.jugador_id = j.id)` |
| P-REF-08 | Ningún cubo sin evento | `select count(*) from analytics.cubos c where not exists (select 1 from analytics.eventos e where e.cubo_id = c.id)` |

## D. Frescura del refresco y volumen

Las tablas son tan frescas como el último `refresh_analytics()`. Agenda y paso manual: bloque 13 de la migración. El estado vive en `analytics_control.refresco`
(una fila): `refrescado_en`, `clave_version` y `vigente` (pasa a `false` solo cuando cambia `player_optout`, hasta el próximo refresco).

Umbrales iniciales; calibrar con la primera corrida real (completar la columna "base" tras ella).

| ID | Verifica | Consulta | Umbral | Sev. |
|---|---|---|---|---|
| P-FRE-01 | El refresco está vigente (no cambió la exclusión voluntaria desde entonces) y es reciente (ventana: 12 h; ajustar a la hora del cron respecto de la extracción) | `select count(*) from analytics_control.refresco where not vigente or refrescado_en is null or refrescado_en < now() - interval '12 hours'` | `n = 0` | BLOQUEA |
| P-FRE-02 | La versión de la clave de ids no cambió respecto de la última corrida (si cambió, **todos** los ids de eventos, enfrentamientos y partidas cambiaron: republicar todo y avisar al sitio) | `select clave_version from analytics_control.refresco` | igual a la guardada por el pipeline | AVISO |
| P-VOL-01 | Filas mínimas | `select (select count(*) from analytics.eventos) as eventos, (select count(*) from analytics.jugadores) as jugadores, (select count(*) from analytics.partidas) as partidas, (select count(*) from analytics.enfrentamientos) as enfrentamientos, (select count(*) from analytics.participaciones) as participaciones` | eventos ≥ 5, jugadores ≥ 5, enfrentamientos ≥ 10, partidas ≥ 20, participaciones ≥ 20 (valores iniciales) | BLOQUEA |
| P-VOL-02 | No caer respecto de la publicación anterior (el pipeline guarda los conteos de la última corrida buena) | los mismos conteos | cada tabla ≥ 90 % de la anterior (se permite bajar solo si cambió la lista de exclusión voluntaria; la corrida lo declara) | BLOQUEA |
| P-VOL-03 | Frescura: hay un evento reciente | `select max(fecha) from analytics.eventos` | no más de 120 días antes de hoy (ajustar a la cadencia real de drafts) | AVISO |
| P-VOL-04 | Cobertura de colores en eventos de la app | `select round(100.0 * count(*) filter (where colores is null) / nullif(count(*), 0), 1) from analytics.participaciones where rol = 'player'` | ≤ 10 % sin colores (los importados suben este número; revisar) | AVISO |
| P-VOL-05 | Cobertura de duración de partida | `select round(100.0 * count(*) filter (where duracion_min is null) / nullif(count(*), 0), 1) from analytics.partidas` | ≤ 25 % | AVISO |
| P-VOL-06 | Cobertura de "quién empieza" (informativa: el dato no existe en los primeros eventos) | `select round(100.0 * count(*) filter (where empieza_id is not null) / nullif(count(*), 0), 1) from analytics.partidas` | se registra; AVISO si cae > 10 puntos respecto de la corrida anterior | AVISO |
| P-VOL-08 | Cobertura del diferencial de vida final (**no bloqueante**; migración 0158): porcentaje de partidas con `dif_vida_final` no nulo. Hoy 416 de 423 (98 %); las que quedan en `NULL` son partidas sin ningún `life_events` | `select round(100.0 * count(dif_vida_final) / nullif(count(*), 0), 1) from analytics.partidas` | se registra; AVISO si baja de 90 % o cae más de 5 puntos respecto de la corrida anterior (nunca bloquea la publicación) | AVISO |
| P-VOL-07 | Cada evento tiene partidas (excepto los `drafting`); se calcula sobre lo publicado | `select count(*) from analytics.eventos e where e.estado <> 'drafting' and not exists (select 1 from analytics.enfrentamientos x join analytics.partidas p on p.enfrentamiento_id = x.id where x.evento_id = e.id)` | ≤ 1 (un evento recién empezado) | AVISO |

## E. Anomalías de origen (control en la base) y registro de limpieza

El pipeline lee el **registro de limpieza** público: cuánto se descartó o se dejó en `NULL`, como texto. Toda cantidad menor a 5 se publica como `<5` (nunca hay detalle por jugador y la
exclusión voluntaria está aplicada). Los AVISO de esta sección se evalúan sobre esas cantidades (un `<5` cuenta como "dentro del umbral"). **Los conteos exactos** viven en
`analytics_private.control_anomalias` y los lee solo quien administra (`P-PRIV-17`).

```sql
select concepto, cantidad from analytics_control.registro_limpieza order by concepto;
```

Los chequeos BLOQUEA de la tabla siguiente (cero obligatorio) llegan al pipeline solo como pasa / no pasa:

```sql
select chequeo from analytics_control.verificacion where not ok;
```

Umbral: **0 filas**. Verificación incluye los chequeos `anomalia:*`, `privacidad:*` y `conciliacion:*`. Detalle de cada chequeo `anomalia:*`:

| Chequeo (`analytics_private.control_anomalias`) | Qué mide | Umbral | Sev. | Lo ve el pipeline |
|---|---|---|---|---|
| `usuarios_sin_alias_en_eventos_validos` | Usuarios que juegan eventos incluidos y no tienen alias (se perderían de los datos; revisar `sync_aliases()`) | 0 | BLOQUEA | `verificacion` |
| `eventos_con_cubo_sin_alias` | Eventos con cubo cuyo cubo no tiene alias | 0 | BLOQUEA | `verificacion` |
| `partidas_ganador_ajeno_al_cruce` | Partida con ganador que no es ninguno de los dos jugadores | 0 | BLOQUEA | `verificacion` |
| `cruces_con_victoria_y_ganador_ajeno` | Cruce con `resultado = 'victoria'` y ganador que no es A ni B | 0 | BLOQUEA | `verificacion` |
| `partidas_sin_ended_at` | Completadas sin `ended_at` | 0 (la base lo prohíbe con una restricción) | BLOQUEA | `verificacion` |
| `partidas_ended_le_started` | Partida completada con `ended_at ≤ started_at` (se publica `NULL`) | ≤ 3 % del total | AVISO | `registro_limpieza` |
| `partidas_duracion_fuera_de_rango` | Duración < 1 o > 240 min (se publica `NULL`) | ≤ 2 % del total | AVISO | `registro_limpieza` |
| `eventos_duracion_draft_fuera_de_rango` | Duración del draft fuera de [5, 480] o ≤ 0 | ≤ 10 % de los eventos | AVISO | `registro_limpieza` |
| `partidas_tiebreak_sin_cruce_de_bracket` | Partidas `tiebreak` que no encuentran su cruce de bracket (quedan asociadas al pairing) | ≤ 5 % de las partidas `tiebreak` | AVISO | `registro_limpieza` |
| `partidas_tiebreak_con_mas_de_un_cruce_candidato` | Ambigüedad al asociar `tiebreak` con bracket (se elige el más antiguo) | 0 | AVISO | solo ADMIN |
| `participaciones_player_sin_colores` | Jugadores sin colores declarados (eventos de la app) | ≤ 10 % de las participaciones | AVISO | `registro_limpieza` |
| `participaciones_player_con_mas_de_4_colores` | Combinaciones de 5-6 colores | 0 | AVISO | solo ADMIN |
| `participaciones_player_sin_partidas` | Jugadores inscriptos sin ninguna partida publicada en el evento (calculado sobre lo publicado, pasando por el mapa de puestos) | se registra; AVISO si > 20 % | AVISO | solo ADMIN |
| `eventos_sin_partidas` | Eventos incluidos sin ninguna partida publicada | ver P-VOL-07 | AVISO | solo ADMIN |
| `eventos_fecha_futura` | Eventos con fecha posterior a hoy | 0 | AVISO | solo ADMIN |
| `eventos_duplicados_misma_fecha_y_cubo` | Posibles eventos duplicados | 0 | AVISO | solo ADMIN |
| `partidas_sin_dato_de_quien_empieza` | Partidas sin `who_started` | se registra | AVISO | `registro_limpieza` |
| `partidas_de_origen_importado` | Partidas de eventos importados o `data_source <> 'app'` (entran con duración y color nulos) | se registra | AVISO | `registro_limpieza` |
| `enfrentamientos_walkover_no_publicados` | Cruces decididos por walkover: **no se publican**; solo se cuentan | se registra | AVISO | `registro_limpieza` |
| `partidas_walkover_no_publicadas` | Partidas walkover: **no se publican**; solo se cuentan | se registra | AVISO | `registro_limpieza` |
| `partidas_de_cruce_no_publicado` | Partidas reales (no walkover) cuyo cruce no se publica (se descartan para no dejar partidas huérfanas) | 0 | AVISO | `registro_limpieza` |
| `participaciones_se_fue_no_publicadas` | Participaciones de jugadores que se fueron: `se_fue` **no se publica**; solo se cuenta | se registra | AVISO | `registro_limpieza` |

Además, **cuentas y eventos de prueba**: no hay una bandera de usuario de prueba. La defensa es (a) `is_official = false` ya excluye los eventos de prueba
y (b) revisión manual **una vez por corrida** de los jugadores que solo aparecen en eventos con pocas partidas:

```sql
select j.id, count(*) filter (where p.rol = 'player') as eventos
from analytics.jugadores j join analytics.participaciones p on p.jugador_id = j.id
group by j.id having count(*) filter (where p.rol = 'player') <= 1 order by 1;
```
AVISO. Si hay un usuario de prueba conocido, se agrega a `analytics_private.player_optout`.

## F. Conciliación contra la regla de publicación (y las vistas oficiales de la app)

La conciliación compara **lo publicado** (`analytics.enfrentamientos` / `analytics.partidas`, que usan puestos, pasando por el mapa privado `player_pos`) contra
`v_participant_official_results` y `v_participant_official_games` (migraciones 0152/0153), jugador por jugador, restringidas a los eventos incluidos. La exclusión voluntaria
se aplica a ambos lados. **La conciliación compara contra la REGLA DE PUBLICACIÓN, no contra la vista cruda de la app:** del lado de la app se excluyen además las partidas reales de un cruce decidido
por walkover (`v_partidas_base` / `v_enfrentamientos_base`), porque la publicación no las incluye (contrato.md §1) y la vista `v_participant_official_games` sí las cuenta. Esto NO oculta otras diferencias: una partida
publicable que falte, una publicada que no esté en la app o un cruce faltante por cualquier motivo que no sea walkover siguen marcando `false`. (Parche para bases ya aplicadas: `0155b_parche_conciliacion.sql`.) El resultado **exacto** queda en `analytics_private.control_conciliacion` (dos filas: `enfrentamientos` y `partidas`; solo `total_app`, `total_curado` y
`jugadores_con_diferencia`, nunca cuáles) y lo lee solo quien administra. El pipeline solo ve `verificacion` (`conciliacion:enfrentamientos`, `conciliacion:partidas`).

```sql
select chequeo from analytics_control.verificacion where chequeo like 'conciliacion:%' and not ok;
```

| ID | Verifica | Umbral | Sev. |
|---|---|---|---|
| P-CON-01 | Enfrentamientos oficiales publicados (victoria, rol `player`) = `v_participant_official_results` | **0 filas** de la consulta anterior para `enfrentamientos` | BLOQUEA |
| P-CON-02 | Partidas oficiales publicadas (rol `player`) = `v_participant_official_games` **menos las partidas de cruces decididos por walkover** (regla de publicación) | **0 filas** para `partidas` | BLOQUEA |
| P-CON-03 | **Exportado = base − exclusión − lo no publicado.** Ver `P-PRIV-04` (ADMIN): el `count(*)` de cada tabla exportada = filas de la vista base con `not excluido` y sin walkover (menos las partidas de cruces no publicados). | igualdad exacta | BLOQUEA |
| P-CON-04 | Todo cruce con victoria tiene al menos una partida publicada | `select count(*) from analytics.enfrentamientos e where e.resultado = 'victoria' and not exists (select 1 from analytics.partidas p where p.enfrentamiento_id = e.id)` ≤ 2 % de los enfrentamientos con victoria | AVISO |

Si una diferencia aparece por una regla que **deliberadamente** se apartó de las vistas (estado del evento, `stage = 'revenge'`; ver "Discrepancias" en la entrega), la conciliación lo mostrará: hay que decidir si se alinea la vista de la app o este contrato. No se silencia.

## G. Privacidad

| ID | Verifica | Consulta | Umbral | Sev. |
|---|---|---|---|---|
| P-PRI-01 | Todos los controles internos de privacidad pasan (uuid, arroba, nombres reales, usernames, cubos, sedes, excluidos presentes —incluido el cubo de un excluido—, huecos en los puestos). El pipeline solo ve pasa / no pasa. | `select chequeo from analytics_control.verificacion where chequeo like 'privacidad:%' and not ok` | **0 filas** | BLOQUEA |
| P-PRI-02 | Lista blanca de columnas | `P-EST-01` | `n = 0` | BLOQUEA |
| P-PRI-03 | Ningún texto con forma de uuid o de email en ninguna columna de texto exportada (redundante con P-PRI-01 a propósito: este chequeo usa regex sobre el texto **tal como se publica**) | `select count(*) from (select nombre t from analytics.jugadores union all select nombre from analytics.cubos union all select nombre from analytics.eventos union all select concat_ws('\|', event_type, estado, competition_format, match_format) from analytics.eventos union all select concat_ws('\|', rol, colores) from analytics.participaciones union all select concat_ws('\|', fase, etapa, resultado) from analytics.enfrentamientos union all select concat_ws('\|', tipo, estado) from analytics.partidas) x where t ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' or t ~ '@'` | 0 | BLOQUEA |
| P-PRI-04 | Jugadores con pocas partidas (riesgo de reidentificación por pocos datos; el sitio podría agruparlos como "Otros") | `select count(*) from (select j.id from analytics.jugadores j left join analytics.partidas p on j.id in (p.jugador_a, p.jugador_b) group by j.id having count(p.id) < 5) t` | se registra la cantidad; AVISO si > 25 % de los jugadores | AVISO |
| P-PRI-05 | Celdas chicas de color: combinaciones con un solo mazo (cuasi-identificador de un jugador en un evento) | `select count(*) from (select colores from analytics.participaciones where colores is not null group by colores having count(*) = 1) t` | se registra (el sitio decide si las agrupa) | AVISO |
| P-PRI-06 | El rol sigue sin poder leer lo sensible (prueba negativa desde el pipeline). Cada sentencia **debe fallar con `42501`/`permission denied`**; si alguna se ejecuta, BLOQUEA. | `select count(*) from public.users` · `select count(*) from auth.users` · `select count(*) from public.draft_events` · `select count(*) from analytics_private.player_alias` · `select * from analytics_private.v_cfg` · `select analytics_private.sync_aliases()` · `select analytics_private.refresh_analytics()` · `select count(*) from analytics_private.control_anomalias` · `delete from analytics.partidas` · `create table analytics.t(a int)` | todas fallan | BLOQUEA |

Pruebas **ADMIN** (el pipeline no puede verlas). **Antes de aplicar o de cada migración futura** correr el paso previo `select defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, defaclacl from pg_default_acl;` (anotar qué privilegios por defecto vigentes pueden alcanzar a `anon`, `authenticated`, `service_role` o `PUBLIC` sobre objetos nuevos: contrato.md §10.4) y **después** correr P-PRIV-01, P-PRIV-11 a P-PRIV-18:

| ID | Verifica | Consulta | Umbral |
|---|---|---|---|
| P-PRIV-01 | `anon`, `authenticated`, `service_role` y `PUBLIC` sin privilegios sobre los esquemas nuevos, y el rol de lectura sin acceso a `analytics_private`. Usa `aclexplode` (lo concedido de forma explícita) y `has_table_privilege` / `has_function_privilege` / `has_schema_privilege` (lo EFECTIVO, que incluye lo heredado de `PUBLIC` y de los privilegios por defecto). No usa `information_schema.role_table_grants`: solo muestra lo que el rol consultante puede ver. | `select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a where n.nspname in ('analytics','analytics_private','analytics_control') and c.relkind in ('r','v','m','p','f','S') and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon','authenticated','service_role')))) + (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join (values ('anon'),('authenticated'),('service_role')) r(rol) where n.nspname in ('analytics','analytics_private','analytics_control') and c.relkind in ('r','v','m','p','f') and has_table_privilege(r.rol, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) + (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'analytics_private' and c.relkind in ('r','v','m','p','f') and has_table_privilege('analytics_reader', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join lateral aclexplode(p.proacl) a where n.nspname in ('analytics','analytics_private','analytics_control') and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon','authenticated','service_role')))) + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join (values ('anon'),('authenticated'),('service_role'),('analytics_reader')) r(rol) where n.nspname in ('analytics','analytics_private','analytics_control') and has_function_privilege(r.rol, p.oid, 'EXECUTE')) + (select count(*) from pg_namespace n cross join lateral aclexplode(n.nspacl) a where n.nspname in ('analytics','analytics_private','analytics_control') and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon','authenticated','service_role')))) + (select count(*) from (values ('anon'),('authenticated'),('service_role')) r(rol) cross join (values ('analytics'),('analytics_private'),('analytics_control')) sc(sch) where has_schema_privilege(r.rol, sc.sch, 'USAGE,CREATE')) + (select count(*) from (values ('analytics_private')) sc(sch) where has_schema_privilege('analytics_reader', sc.sch, 'USAGE,CREATE')) as violaciones` | **0** (BLOQUEA) |
| P-PRIV-02 | Atributos del rol | `select rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit, rolconnlimit, rolcanlogin from pg_roles where rolname = 'analytics_reader'` | todos `false` salvo `rolcanlogin = true`; `rolconnlimit = 2` |
| P-PRIV-03 | El rol no es miembro de ningún otro rol y no es dueño de nada | `select count(*) from pg_auth_members where member = (select oid from pg_roles where rolname='analytics_reader')` y `select count(*) from pg_class where relowner = (select oid from pg_roles where rolname='analytics_reader')` | ambas 0 |
| P-PRIV-04 | Exclusión voluntaria y filtros de walkover aplicados: conteos esperados desde la vista base (sin excluidos y sin walkover, menos las partidas de cruces no publicados) = conteos exportados | `select (select count(*) from analytics_private.v_partidas_base where not excluido and not es_walkover) - (select cantidad from analytics_private.control_anomalias where chequeo = 'partidas_de_cruce_no_publicado') as partidas_esperadas, (select count(*) from analytics.partidas) as partidas_exportadas, (select count(*) from analytics_private.v_enfrentamientos_base where not excluido and not es_walkover) as enf_esperados, (select count(*) from analytics.enfrentamientos) as enf_exportados` | iguales |
| P-PRIV-05 | Privilegios efectivos del rol (L7: incluye `has_schema_privilege` sobre `public`) | `select has_schema_privilege('analytics_reader','public','USAGE') as usage_public, has_schema_privilege('analytics_reader','analytics_private','USAGE') as usage_privado, has_table_privilege('analytics_reader','public.users','SELECT') as lee_users, has_table_privilege('analytics_reader','analytics_private.player_alias','SELECT') as lee_alias` | `usage_privado`, `lee_users`, `lee_alias` = false. `usage_public` puede ser true (PUBLIC concede USAGE sobre `public`): es esperado y por eso importan P-PRIV-06 y P-PRIV-11. Anotar el valor observado |
| P-PRIV-06 | **BLOQUEA.** Funciones ejecutables por el rol en TODOS los esquemas que no son del sistema (`public`, `extensions`, `net`, `storage`, `vault`, `graphql`, etc.; se excluyen `pg_catalog`, `information_schema`, `pg_toast` y los temporales). Única excepción documentada: funciones MIEMBRO DE UNA EXTENSIÓN dentro del esquema `extensions` que no son `SECURITY DEFINER` (pgcrypto, uuid-ossp, etc. quedan ejecutables por `PUBLIC` por diseño; se vigilan en P-PRIV-06b). 0151 revocó `public` el 2026-11-05; lo creado después lo vuelve a tener. | `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog','information_schema','pg_toast') and n.nspname not like 'pg\_temp%' and n.nspname not like 'pg\_toast\_temp%' and has_function_privilege('analytics_reader', p.oid, 'EXECUTE') and not (n.nspname = 'extensions' and not p.prosecdef and exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'))` | **0** (si aparecen funciones `SECURITY DEFINER`, o de `net`/`vault`/`storage`/`public`, es un hallazgo bloqueante) |
| P-PRIV-06b | AVISO. Funciones de extensiones del esquema `extensions` ejecutables por el rol que SON `SECURITY DEFINER` (deberían ser ninguna). Informativo: el total de funciones de extensiones ejecutables por `PUBLIC`. | `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'extensions' and p.prosecdef and has_function_privilege('analytics_reader', p.oid, 'EXECUTE')` | **0** |
| P-PRIV-07 | El secreto y el mapa existen, tienen RLS y nadie más los lee | `select relname, relrowsecurity from pg_class where relnamespace = 'analytics_private'::regnamespace and relkind = 'r'` | `relrowsecurity = true` en TODAS las tablas de `analytics_private` (ver también P-PRIV-18) |
| P-PRIV-08 | Cuántos usuarios no tienen alias y cuántos están excluidos | `select (select count(*) from public.users u where not exists (select 1 from analytics_private.player_alias a where a.user_id = u.id)) as sin_alias, (select count(*) from analytics_private.player_optout) as excluidos` | `sin_alias` = 0 |
| P-PRIV-09 | Ninguna función de los esquemas nuevos es ejecutable por `anon`, `authenticated` ni `service_role` (ni por PUBLIC, que incluye a todos). Redundante con P-PRIV-01 a propósito. | `select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('analytics','analytics_private','analytics_control') and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('service_role', p.oid, 'EXECUTE'))` | **0 filas** |
| P-PRIV-10 | M4: `EXECUTE` sobre `extensions.hmac` y `refresh_analytics` para el rol, y concesiones directas de EXECUTE al rol. La migración NO otorga nada de esto (los ids están calculados en las tablas). | `select has_function_privilege('analytics_reader','extensions.hmac(text,text,text)','EXECUTE') as ejecuta_hmac, has_function_privilege('analytics_reader','analytics_private.refresh_analytics()','EXECUTE') as ejecuta_refresh, (select count(*) from information_schema.routine_privileges where grantee = 'analytics_reader') as concesiones_directas` | `ejecuta_refresh = false`, `concesiones_directas = 0`. `ejecuta_hmac` es `false` salvo que pgcrypto lo conceda a PUBLIC: en ese caso es inofensivo (sin la clave no se reproduce ningún id) y se anota el valor observado |
| P-PRIV-11 | L7: ninguna tabla o vista de `public` es legible por el rol (SELECT heredado de PUBLIC) | `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','v','m','p','f') and has_table_privilege('analytics_reader', c.oid, 'SELECT')` | **0** |
| P-PRIV-12 | L3: ninguna definición de vista o función de los esquemas analytics* contiene la clave de ids, otro uuid ni cadenas hexadecimales largas | `select count(*) from (select pg_get_viewdef(c.oid) as d from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('analytics','analytics_private','analytics_control') and c.relkind = 'v' union all select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('analytics','analytics_private','analytics_control')) x where d ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' or d ~* '[0-9a-f]{32,}' or exists (select 1 from analytics_private.secret s where position(s.value in d) > 0)` | **0** |
| P-PRIV-13 | L5: toda función de `analytics_private` fija `search_path` con `pg_temp` al final | `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'analytics_private' and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c ~ '^search_path=.*pg_temp$')` | **0** |
| P-PRIV-14 | L6: ninguna secuencia de los esquemas analytics* es accesible por `anon`, `authenticated` ni `service_role` (tablas: P-PRIV-01; funciones: P-PRIV-09) | `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('analytics','analytics_private','analytics_control') and c.relkind = 'S' and (has_sequence_privilege('anon', c.oid, 'USAGE') or has_sequence_privilege('authenticated', c.oid, 'USAGE') or has_sequence_privilege('service_role', c.oid, 'USAGE'))` | **0** |
| P-PRIV-15 | Realtime: ningún objeto de analytics* en publicaciones, y ninguna publicación `FOR ALL TABLES` (que incluiría los objetos nuevos automáticamente) | `select (select count(*) from pg_publication_tables where schemaname in ('analytics','analytics_private','analytics_control')) + (select count(*) from pg_publication where puballtables) as n` | **0** |
| P-PRIV-16 | API de Supabase: el rol `authenticator` no expone los esquemas analytics* (`pgrst.db_schemas` / `db_extra_search_path`). **Además verificar A MANO en el panel** (Settings → API → Exposed schemas): no deben figurar `analytics`, `analytics_private` ni `analytics_control`. | `select count(*) from pg_db_role_setting s join pg_roles r on r.oid = s.setrole cross join lateral unnest(s.setconfig) c where r.rolname = 'authenticator' and c ~ '^pgrst\.db_(schemas\|extra_search_path)=.*analytics'` | **0** |
| P-PRIV-17 | Controles EXACTOS internos (solo ADMIN): conteos reales de anomalías, violaciones de privacidad y conciliación | `select chequeo, cantidad from analytics_private.control_anomalias where cantidad > 0 order by 1` | se revisa; los BLOQUEA deben ser 0 |
| P-PRIV-18 | A1: toda tabla de `analytics` y `analytics_control` tiene RLS activada y una política SELECT para el rol; toda tabla de `analytics_private` tiene RLS activada | `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('analytics','analytics_control','analytics_private') and c.relkind = 'r' and (not c.relrowsecurity or (n.nspname <> 'analytics_private' and not exists (select 1 from pg_policies p where p.schemaname = n.nspname and p.tablename = c.relname and p.cmd = 'SELECT' and 'analytics_reader'::name = any (p.roles))))` | **0** |
| P-PRIV-19 | 0156: `analytics_private.cube_orden` existe, tiene RLS y ningún rol (anon, authenticated, service_role, analytics_reader, PUBLIC) la lee ni la escribe; las letras de cubo son estables: dos refrescos seguidos dejan el mismo `cube_pos` | `select c.relrowsecurity, has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('analytics_reader', c.oid, 'select,insert,update,delete,truncate') as abierta from pg_class c where c.oid = 'analytics_private.cube_orden'::regclass` y la Consulta C de `operacion.md` §h | `relrowsecurity = true`, `abierta = false`; Consulta C = 0 y 0 |

## H. Archivos publicados (en el pipeline, no en SQL)

| ID | Verifica | Umbral | Sev. |
|---|---|---|---|
| P-ARCH-01 | Cada archivo tiene exactamente las filas y columnas de su tabla (lo leído en la corrida) y los tipos del contrato (`date` como `YYYY-MM-DD`, ids como enteros sin notación científica) | igualdad exacta | BLOQUEA |
| P-ARCH-02 | Buscar en el texto de **todos** los archivos publicados: patrón uuid, `@`, y la lista de nombres/usernames/cubos/sedes reales que el pipeline **no tiene** (la comparación contra los reales ya la hizo la base en `analytics_control.privacidad`); si el pipeline llegara a tener una lista de términos prohibidos, también se aplica | 0 coincidencias | BLOQUEA |
| P-ARCH-03 | Un manifiesto con `schema_version`, conteos por tabla y checksum de cada archivo; sin marca de tiempo exacta (solo fecha de corrida) | presente | BLOQUEA |
| P-ARCH-04 | El resultado se sube **solo como artefacto de Pages**: nada se commitea al repo, ningún archivo de datos queda en `dist` fuera de lo previsto, y los logs de la Action no imprimen filas (solo conteos) | cumple | BLOQUEA |
| P-ARCH-05 | Tamaño de archivo dentro de lo esperado (±50 % respecto de la corrida anterior) | cumple | AVISO |

## I. Orden de ejecución y criterio de publicación

0. `P-FRE-01` (refresco vigente y reciente) y `P-FRE-02`. Si hubo una exclusión nueva: correr el refresco a mano y **volver a ejecutar la publicación** (lo publicado antes sigue en snapshots y cachés externas: contrato.md §8).
1. `P-PRI-06` (prueba negativa del rol) y `P-EST-01`.
2. Claves, dominios y referencias (A, B, C).
3. Conciliación (F) y anomalías (E).
4. Volumen (D) y privacidad (G).
5. Si no hay ninguna prueba **BLOQUEA** fallida: escribir archivos, correr H y publicar el artefacto.
6. Guardar los conteos y el resumen de AVISOS de la corrida (sin filas) como base de la próxima.

Calibración pendiente (completar tras la primera corrida real): los umbrales de `P-VOL-01`, `P-VOL-03`, `P-VOL-04`, `P-VOL-05`, la ventana de `P-FRE-01` y los porcentajes de la tabla E.

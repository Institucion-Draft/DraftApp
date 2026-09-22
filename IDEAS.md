# Ideas

Registro de ideas y features futuras que todavía no están agendadas como pendientes técnicos concretos. Se va a ir extendiendo sesión a sesión.

- Modo oscuro (dark mode) para toda la app. Sistema de theme con paleta de colores semánticos, toggle en settings del usuario, refactor de pantallas existentes para usar variables de tema.

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

## Bugs/UX menores identificados, sin resolver

- En LifeTracker: cambiar el menú "..." (3 puntos arriba) por un ícono de tacho de basura a la derecha del bloque del match. Requiere doble confirmación: ambos jugadores tocan "Abortar" desde sus dispositivos para concretar. Ventana de 3 minutos para que el segundo confirme.
- PJ no debería sumar hasta que la partida se completa (hoy suma con in_progress). Acrónimo se mantiene PJ, leyenda dice "Partidas Jugadas Finalizadas".

## Subir foto custom en Mi Perfil

- Avatar custom que sobreescribe el Pokémon en todos lados
- Requiere `expo-image-picker` (paquete nativo, requiere rebuild APK)
- Subir a Supabase Storage en bucket `avatars`

## Racha de últimas 5 partidas (distinto de "mayor racha", que ya existe)

- Última 5 partidas oficiales: pelotitas V (verde) / D (roja)
- Última 5 partidas totales (oficiales + venganzas): otra fila
- Mostrar en perfil del jugador

## Quién empieza: ruleta visual + alternancia sugerida

El elegir y persistir quién empieza cada partida ya está implementado (`matches.who_started_participant_id`, LifeTracker). Falta:
- Animación tipo ruleta (botón "Aleatorizar" que enciende/apaga avatares) en vez de selección directa
- En partidas siguientes del mismo enfrentamiento, sugerir quién empieza por alternancia

## Sistema de Copas con campeón actual (distinto de Copa Venganza/Súper Copa, que ya existen)

- Distinción Draft común vs Copa/Torneo
- Cada Copa (Quito, Cordero, Galicia, etc.) tiene un dibujo propio (assets externos)
- Último campeón de cada Copa tiene el dibujo al lado de su nombre
- Cuando otro gana la siguiente edición, el dibujo pasa al nuevo campeón
- Schema: tabla `cups` o campo en eventos para distinguir tipo

## "vs" estilizado

- En PairingDetail header, fuente custom
- Opciones: Bangers, Bungee, Permanent Marker (Google Fonts vía expo-font)

## Mejor miniatura/icono de la app

- Icon, splash, adaptive-icon
- Reemplazar los defaults de Expo

## Auto-actualización entre live updates más reactivos

Más allá del refresh de 15 seg de PairingsList, ver si vale la pena suscribirse a realtime de matches ahí (hoy solo NewsTicker en LifeTracker hace polling propio; PairingsList sigue en polling de 15s).

## Tabla histórica del grupo con filtros combinables

El Ranking Global ya cubre "stats acumulados de todos los eventos del workspace" (ver PROJECT.md). Falta el sistema de filtros combinables estilo Excel:
- Por cubo
- Por sede
- Por jugador
- Si jugador empezó la partida o no
- Por tipo de Pokémon avatar (ej: "todas las partidas con avatar fantasma")
- Por color del mazo
- Por mes/trimestre
- Por tipo de evento (Draft, Copa, Pepidraft)
- Incluye oficiales + venganzas (a diferencia de la tabla del evento)

## Foro de memes

- Sección por evento con upload de imágenes
- Reacciones (likes, comentarios)
- Límites razonables de tamaño

## Sistema "El Vasquito" (empanadas)

- Pantalla de pedido por evento
- Cada uno marca cuántas de cada gusto quiere
- Cálculo automático de total
- Botón "Yo hago el pedido": al que aprieta le aparece pedido completo y total general
- A los demás: su pedido individual + alias del que recoge

## Votación próximo cubo

- Sección con opciones que carga la gente
- Cada cubo: nombre, link a CubeCobra, descripción, número de cartas
- Cada usuario tiene 2 votos: uno de 2 puntos, otro de 1 punto
- Cierre automático según calendario (día anterior al evento)

## Realtime para todos

- Ruleta de cubos sincronizada con todos los espectadores (no solo el organizer)
- Updates en tiempo real de cualquier cambio relevante en la app

## Importación de bitácoras viejas

- Procesar fotos de bitácora histórica (vía OCR o tipeo manual)
- Insertar eventos, pairings, resultados
- Solo permite stats agregadas (no DMV histórico - faltan timestamps de life_events)

## Correlación valoración personal vs partidas ganadas (Standings)

Scatter plot con avatares como puntos, R² mostrado, aparece en Standings después de las 23:59 hora Argentina. Animación de podio al cierre del torneo también pendiente (el cierre automático del status y la lógica del podio en sí ya están implementados).

## Formato de evento: N grupos + playoffs

BO1/BO2/BO3 y Suizo ya están implementados. Falta la variante de N grupos + playoffs (cantidad de grupos según jugadores), con su propia generación de pairings y criterios de cierre.

## Decoradores temporales sobre avatar

- Sistema general de "layers" sobre avatar
- Activación según condiciones: fecha, clima, evento especial
- Casos:
  - Gorrito de cumpleaños
  - Estaciones (verano, otoño, invierno, primavera)
  - Días de lluvia
  - Navidad, fiestas patrias
  - Otros que se vayan ocurriendo

## Stats Estacionales ("Estad-Estac") — distinto del sistema de Temporadas ya implementado

El sistema de Temporadas (ranking de puntos por escalón, automático por estación, con podio de cierre) ya está implementado y cubre el concepto general de "período = estación del año". Esta idea es un diseño DISTINTO y más elaborado, con premios por categoría de stats en vez de ranking de puntos — nada de esto está construido:

**Disparo y presentación**:
- Botón visible solo durante 7 días desde el inicio de cada estación (21 mar/jun/sep/dic en Argentina), con emoji de la estación de turno
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

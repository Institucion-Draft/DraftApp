import React from 'react';
import { View, Text } from 'react-native';
import Card from '../../components/Card';
import RuleStandingsTable from './RuleStandingsTable';
import RuleBracketCard from './RuleBracketCard';
import RuleMatchupSection from './RuleMatchupSection';
import RuleTieCascadeSteps from './RuleTieCascadeSteps';
import { useRulesStyles } from './rulesStyles';
import {
  SWISS_SECTION1_BO13_ROWS,
  SWISS_SECTION1_BO2_ROWS,
  SWISS_SECTION3_TOP4_ROWS,
  SWISS_SECTION3_BRACKET_ROUNDS,
  SWISS_SECTION3_SEMIS_MATCHUPS,
  SWISS_SECTION3_FINAL_MATCHUPS,
} from './mockData';

export default function SwissRulesContent() {
  const rs = useRulesStyles();
  return (
    <View>
      {/* Sección 1 */}
      <Text style={rs.h2}>1. Cómo se forma la tabla</Text>
      <Text style={rs.paragraph}>
        Se ordena por puntos: 3 por victoria, 1 por empate (el empate real de enfrentamiento solo
        puede darse en BO2), 0 por derrota. Cuando la cantidad de jugadores activos es impar,
        alguien no tiene rival esa ronda y recibe un bye: se le da prioridad a quien viene peor
        posicionado y todavía no tuvo uno. El bye suma puntos sin jugar, pero no vale lo mismo en
        todos los formatos.
      </Text>

      <Text style={rs.h3}>BO1 y BO3</Text>
      <Text style={rs.paragraph}>
        Ahí nunca hay empates. El bye vale 3 puntos, igual que una victoria.
      </Text>
      <Text style={rs.exampleLabel}>Ejemplo — Juli tuvo un bye en la ronda 2</Text>
      <Card style={rs.card}>
        <RuleStandingsTable mode="points" rows={SWISS_SECTION1_BO13_ROWS} />
      </Card>
      <Text style={rs.paragraph}>
        Juli ganó 1 partido y perdió 1, pero llega a 6 puntos igual que Fede (2 ganados, 1
        perdido) porque el bye de la ronda 2 le sumó 3 puntos sin jugarla.
      </Text>

      <Text style={rs.h3}>BO2</Text>
      <Text style={rs.paragraph}>
        Ahí sí puede haber un empate real (ganar un juego cada uno). El bye vale 2 puntos, menos
        que una victoria — porque en BO2 empatar un enfrentamiento de verdad ya vale 1 punto, así
        que el bye queda a mitad de camino entre ganar y empatar.
      </Text>
      <Card style={rs.card}>
        <RuleStandingsTable mode="points" rows={SWISS_SECTION1_BO2_ROWS} />
      </Card>
      <Text style={rs.paragraph}>
        Male tuvo un bye en la ronda 3: sumó 2 puntos, no 3 — a diferencia de BO1/BO3, donde el
        mismo bye hubiera valido una victoria completa.
      </Text>

      <View style={rs.sectionDivider} />

      {/* Sección 2 */}
      <Text style={rs.h2}>2. Cómo se juega cada ronda</Text>
      <Text style={rs.paragraph}>
        A diferencia de todos contra todos, donde todos los cruces se conocen desde el arranque
        del torneo, en Suizo el emparejamiento es dinámico: cada ronda se arma recién cuando
        termina la anterior, cruzando a jugadores con puntaje parecido y evitando repetir un
        cruce ya jugado.
      </Text>

      <View style={rs.sectionDivider} />

      {/* Sección 3 */}
      <Text style={rs.h2}>3. Cómo se corona el Top 4</Text>
      <Text style={rs.paragraph}>
        A diferencia de todos contra todos, donde la fase mata-mata es opcional, en Suizo{' '}
        <Text style={{ fontWeight: '700' }}>siempre</Text> hay Top 4: toda competencia con este
        formato termina en semifinales, final y 3er/4to puesto. Al cerrarse la última ronda de la
        fase regular, los 4 mejores de la tabla pasan directo — el corte se resuelve
        matemáticamente con los mismos criterios de la sección 4, sin un partido de desempate en
        vivo. Se cruzan 1° contra 4° y 2° contra 3°.
      </Text>
      <Text style={rs.exampleLabel}>Ejemplo — tabla final de la fase regular</Text>
      <Card style={rs.card}>
        <RuleStandingsTable mode="points" rows={SWISS_SECTION3_TOP4_ROWS} />
      </Card>
      <Text style={rs.exampleLabel}>Ejemplo — bracket armado</Text>
      <Card style={rs.card}>
        <RuleBracketCard rounds={SWISS_SECTION3_BRACKET_ROUNDS} />
      </Card>
      <Text style={rs.paragraph}>Así se vería la sección "Fase mata-mata" en la pantalla de Enfrentamientos:</Text>
      <RuleMatchupSection title="Fase mata-mata" matchups={SWISS_SECTION3_SEMIS_MATCHUPS} />
      <Text style={[rs.paragraph, { marginTop: 4 }]}>
        Una vez jugadas las semis, la sección se completa con la Final y el 3er/4to puesto,
        cruzando a los ganadores y perdedores de cada semi entre sí:
      </Text>
      <RuleMatchupSection title="Fase mata-mata" matchups={SWISS_SECTION3_FINAL_MATCHUPS} />

      <View style={rs.sectionDivider} />

      {/* Sección 4 */}
      <Text style={rs.h2}>4. Criterios de desempate</Text>
      <Text style={rs.paragraph}>
        Cuando dos o más jugadores comparten puntos, se ordenan según los siguientes criterios,
        en orden de prioridad. A diferencia de todos contra todos, acá{' '}
        <Text style={{ fontWeight: '700' }}>no</Text> hay desempate olímpico (head-to-head): es
        una decisión deliberada de las reglas oficiales de Magic, para que a nadie le convenga
        entregar o forzar un resultado en la última ronda solo por cómo le quedó el cruce directo
        con un rival puntual.
      </Text>
      <RuleTieCascadeSteps
        steps={[
          {
            title: 'OMW% — rendimiento de los rivales',
            description:
              'Promedio del porcentaje de victorias en enfrentamientos de cada rival que enfrentaste durante el torneo. A cada rival se le pone un piso de 33%, aunque haya rendido peor: así no te perjudica haber cruzado a alguien con muy mal registro.',
            examples: [
              'Ana y Bruno terminan empatados en puntos. Los rivales de Ana tuvieron 60%, 40% y 20% de victorias (el 20% se cuenta como 33% por el piso): promedio 44%. Los rivales de Bruno tuvieron 50%, 50% y 50%: promedio 50%. Bruno queda arriba.',
            ],
          },
          {
            title: 'GW% — tus propias partidas individuales',
            description:
              'Porcentaje de partidas individuales (no enfrentamientos) que ganaste vos. Si el empate en OMW% persiste, gana quien ganó más partidas sueltas, más allá de cómo se repartieron entre sus enfrentamientos.',
          },
          {
            title: 'OGW% — partidas individuales de los rivales',
            description:
              'Igual que OMW%, pero con el porcentaje de partidas individuales ganadas por cada rival (también con piso de 33% cada uno). Mide qué tan duros fueron tus cruces a nivel de partida, no solo de enfrentamiento.',
          },
          {
            title: 'Desempate determinístico',
            description:
              'Si ni siquiera OGW% separa a todos, se aplica un desempate final determinístico (por ID de usuario), no aleatorio: siempre da el mismo resultado entre los mismos empatados, así la tabla y el bracket quedan sembrados de forma coherente.',
          },
        ]}
      />

      <View style={rs.sectionDivider} />

      {/* Sección 5 */}
      <Text style={rs.h2}>5. El botón "Me voy"</Text>
      <Text style={rs.paragraph}>
        Igual que en todos contra todos, si un jugador debe abandonar antes de completar sus
        enfrentamientos pendientes puede marcarse como "ido". Sus cruces pendientes de la fase
        regular se resuelven como walkover a favor del rival, y la tabla se recalcula
        excluyéndolo de las posiciones en disputa, sin trabar el avance de ronda ni el cierre del
        torneo.
      </Text>
      <Text style={rs.paragraph}>
        Como en Suizo el Top 4 siempre existe, esto también está soportado en el bracket real: si
        alguien del Top 4 se va antes de que arranque su semifinal, el cupo se recalcula entero
        con los mismos criterios de la sección 4, y sube el siguiente en mérito a la seed
        vacante — sin jugar nada extra. Si la salida ocurre con una semifinal ya arrancada, en
        cambio, solo se resuelve por walkover la llave puntual de esa persona, sin tocar el resto
        del bracket. Si hay más de una salida, cada una se recalcula sobre el estado ya
        actualizado por la anterior, así que el corrimiento en cascada funciona igual para
        varias salidas seguidas.
      </Text>
    </View>
  );
}

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Card from '../../components/Card';
import RuleStandingsTable from './RuleStandingsTable';
import RuleBracketCard from './RuleBracketCard';
import RuleMatchupSection from './RuleMatchupSection';
import RuleTieCascadeSteps from './RuleTieCascadeSteps';
import { rulesStyles as rs } from './rulesStyles';
import {
  SECTION1_BO1_ROWS,
  SECTION1_BO3_ROWS,
  SECTION1_POINTS_ROWS,
  SECTION2_TOP4_ROWS,
  SECTION2_BRACKET_ROUNDS,
  SECTION2_SEMIS_MATCHUPS,
  SECTION2_FINAL_MATCHUPS,
  SECTION5_CASE2_ROWS,
  SECTION5_CASE2_BRACKET,
  SECTION5_CASE3_ROWS,
  SECTION5_CASE3_BRACKET,
  SECTION5_CASE4_ROWS,
  SECTION5_CASE4_BRACKET,
  SECTION5_CASE5PLUS_ROWS,
  SECTION5_CASE5PLUS_BRACKET,
  SECTION6_CASE2_ROWS,
  SECTION6_CASE2_BRACKET,
  SECTION6_CASE3_ROWS,
  SECTION6_CASE3_BRACKET,
  SECTION6_CASE4_ROWS,
  SECTION6_CASE4_BRACKET,
  SECTION6_CASE5PLUS_ROWS,
  SECTION6_THIRD_PLACE_TIE_ROWS,
} from './mockData';

function SituationTable() {
  const rows: [string, string][] = [
    ['Liga', 'Empate en el 1er puesto'],
    ['Liga + Top 4', 'Empate en el 4to puesto'],
  ];
  return (
    <View style={styles.situationTable}>
      <View style={styles.situationRow}>
        <Text style={[styles.situationCell, styles.situationHeaderTxt]}>Formato</Text>
        <Text style={[styles.situationCell, styles.situationHeaderTxt]}>Situación</Text>
      </View>
      {rows.map(([format, situation]) => (
        <View key={format} style={[styles.situationRow, styles.situationRowBody]}>
          <Text style={styles.situationCell}>{format}</Text>
          <Text style={styles.situationCell}>{situation}</Text>
        </View>
      ))}
    </View>
  );
}

export default function RoundRobinRulesContent() {
  return (
    <View>
      {/* Sección 1 */}
      <Text style={rs.h2}>1. Cómo se forma la tabla</Text>

      <Text style={rs.h3}>BO1</Text>
      <Text style={rs.paragraph}>En BO1, se ordena por partidos ganados sobre jugados.</Text>
      <Card style={rs.card}>
        <RuleStandingsTable mode="winrate" rows={SECTION1_BO1_ROWS} />
      </Card>

      <Text style={rs.h3}>BO3</Text>
      <Text style={rs.paragraph}>En BO3, se ordena por enfrentamientos ganados sobre completados.</Text>
      <Card style={rs.card}>
        <RuleStandingsTable mode="winrate" rows={SECTION1_BO3_ROWS} winrateLabels={{ won: 'EG', total: 'EC' }} />
      </Card>

      <Text style={rs.h3}>BO2</Text>
      <Text style={rs.paragraph}>En BO2, se ordena por puntos (3 por victoria, 1 por empate).</Text>
      <Card style={rs.card}>
        <RuleStandingsTable mode="points" rows={SECTION1_POINTS_ROWS} />
      </Card>

      <View style={rs.sectionDivider} />

      {/* Sección 2 */}
      <Text style={rs.h2}>2. Cómo se corona campeón</Text>
      <Text style={rs.h3}>Sin fase mata-mata</Text>
      <Text style={rs.paragraph}>
        El campeón es quien termina en el 1er puesto de la tabla al completarse todos los cruces, o antes si
        matemáticamente ya no hay forma de que otro jugador lo alcance.
      </Text>

      <Text style={rs.h3}>Con fase mata-mata (Top 4)</Text>
      <Text style={rs.paragraph}>
        Al terminar la fase liga, los 4 mejores pasan a semifinales. Se cruzan 1° contra 4° y 2° contra 3°.
      </Text>
      <Text style={rs.exampleLabel}>Ejemplo — tabla final de la fase liga</Text>
      <Card style={rs.card}>
        <RuleStandingsTable mode="winrate" rows={SECTION2_TOP4_ROWS} />
      </Card>
      <Text style={rs.exampleLabel}>Ejemplo — bracket armado</Text>
      <Card style={rs.card}>
        <RuleBracketCard rounds={SECTION2_BRACKET_ROUNDS} />
      </Card>
      <Text style={rs.paragraph}>Así se vería la sección "Fase mata-mata" en la pantalla de Enfrentamientos:</Text>
      <RuleMatchupSection title="Fase mata-mata" matchups={SECTION2_SEMIS_MATCHUPS} />
      <Text style={[rs.paragraph, styles.spacedTop]}>
        Una vez jugadas las semis, la sección se completa con la Final y el 3er/4to puesto, cruzando a los
        ganadores y perdedores de cada semi entre sí:
      </Text>
      <RuleMatchupSection title="Fase mata-mata" matchups={SECTION2_FINAL_MATCHUPS} />

      <View style={rs.sectionDivider} />

      {/* Sección 3 */}
      <Text style={rs.h2}>3. Orden en caso de compartir posición en la tabla</Text>
      <Text style={rs.paragraph}>
        Aplica a cualquier posición de la tabla, excepto donde hay un desempate real (ver siguiente sección).
        Cuando dos o más jugadores comparten puntaje, se ordenan según los siguientes criterios, en orden de
        prioridad:
      </Text>
      <RuleTieCascadeSteps
        steps={[
          {
            title: 'Desempate olímpico',
            description: 'Gana quien le ganó al otro durante la fase de liga.',
            examples: [
              'Ana y Bruno terminan con los mismos puntos totales. Si en su cruce directo ganó Ana, Ana queda arriba.',
              'Bruno, Ana y Javier tienen la misma cantidad de puntos. Bruno le ganó a Ana y a Javier, y Javier le ganó a Ana. Entonces queda primero Bruno, luego Javier, luego Ana, dentro de la posición que comparten.',
            ],
          },
          {
            title: 'Winrate de partidas individuales (solo BO3)',
            description:
              'Si el desempate olímpico no alcanza para separar a todo el grupo (los tres se ganaron entre sí en un ciclo, sin que nadie sume más que el resto), se mira el winrate de partidas individuales de cada uno, no de enfrentamientos. Este criterio solo existe en formato BO3.',
            examples: [
              'Bruno, Ana y Javier comparten posición. Bruno le ganó a Ana, Ana a Javier, y Javier a Bruno (ciclo perfecto): el desempate olímpico no separa a nadie. Bruno tiene el mejor winrate de partidas individuales, así que queda primero. Ana y Javier, que tienen el mismo winrate entre sí, siguen empatados: pasan al siguiente criterio para definir su orden.',
            ],
          },
          {
            title: 'Calidad de rivales',
            description:
              'Se suman los puntos totales de los rivales a los que cada uno le ganó, sin contar rivales que forman parte del propio grupo empatado. Gana el que le ganó a rivales más fuertes.',
            examples: [
              'Ana, Bruno y Carla comparten posición en un ciclo perfecto, con el mismo winrate individual entre los tres (o sin ser BO3). Se pasa a calidad de rivales: si Ana le ganó a alguien que terminó 2do en la tabla general y Bruno solo le ganó a alguien que terminó último, Ana queda arriba.',
              'En BO2, Ana y Pedro empataron su cruce directo y terminaron con la misma cantidad de puntos en la tabla: como el resultado directo fue un empate, se pasa directo a la calidad de rivales de cada uno.',
            ],
          },
          {
            title: 'Desempate al azar',
            description:
              'Si ni siquiera los criterios anteriores rompen el empate, se aplica un criterio de desempate al azar. Así la tabla siempre queda con un orden único.',
          },
        ]}
      />

      <View style={rs.sectionDivider} />

      {/* Sección 4 */}
      <Text style={rs.h2}>4. ¿Cuándo ocurre un desempate real?</Text>
      <Text style={rs.paragraph}>
        Las reglas de la sección anterior alcanzan para ordenar la tabla en casi todos los casos. Solo hace
        falta jugar un desempate real cuando el empate cae justo sobre la frontera que define un puesto
        importante:
      </Text>
      <SituationTable />

      <View style={rs.sectionDivider} />

      {/* Sección 5 */}
      <Text style={rs.h2}>5. Desempate real por el 1er puesto (solo Liga sin top)</Text>
      <Text style={rs.paragraph}>
        En caso de desempate por el primer lugar, se define en un BO3. Si el empate fuera entre 3 o más
        personas, hay semifinales BO1 y una final BO3.
      </Text>

      <Text style={rs.h3}>2 empatados</Text>
      <Text style={rs.paragraph}>Un solo BO3 define quién es el campeón.</Text>
      <Card style={rs.card}>
        <RuleStandingsTable mode="winrate" rows={SECTION5_CASE2_ROWS} />
      </Card>
      <Card style={rs.card}>
        <RuleBracketCard rounds={SECTION5_CASE2_BRACKET} />
      </Card>

      <Text style={rs.h3}>3 empatados</Text>
      <Text style={rs.paragraph}>
        Semifinal BO1 entre los 2 peor posicionados; el ganador juega la final BO3 contra el otro.
      </Text>
      <Card style={rs.card}>
        <RuleStandingsTable mode="winrate" rows={SECTION5_CASE3_ROWS} />
      </Card>
      <Card style={rs.card}>
        <RuleBracketCard rounds={SECTION5_CASE3_BRACKET} />
      </Card>

      <Text style={rs.h3}>4 empatados</Text>
      <Text style={rs.paragraph}>Semifinales BO1 cruzadas por su orden interno; los ganadores juegan la final BO3.</Text>
      <Card style={rs.card}>
        <RuleStandingsTable mode="winrate" rows={SECTION5_CASE4_ROWS} />
      </Card>
      <Card style={rs.card}>
        <RuleBracketCard rounds={SECTION5_CASE4_BRACKET} />
      </Card>

      <Text style={rs.h3}>5 o más empatados</Text>
      <Text style={rs.paragraph}>
        El grupo se recorta a 4 aplicando las reglas de la sección 3; a partir de ahí, mismo esquema que el
        caso de 4 empatados.
      </Text>
      <Card style={rs.card}>
        <RuleStandingsTable mode="winrate" rows={SECTION5_CASE5PLUS_ROWS} />
      </Card>
      <Card style={rs.card}>
        <RuleBracketCard rounds={SECTION5_CASE5PLUS_BRACKET} />
      </Card>

      <View style={rs.sectionDivider} />

      {/* Sección 6 */}
      <Text style={rs.h2}>6. Desempate real por el 4to puesto (solo Liga + Top 4)</Text>
      <Text style={rs.paragraph}>
        Este desempate define únicamente quién ocupa, de forma inequívoca, el 4to puesto de la tabla — el
        único que clasifica al Top 4 entre los que llegan empatados a esa frontera. Siempre se juega a BO1.
      </Text>

      <Text style={rs.h3}>2 empatados</Text>
      <Card style={rs.card}>
        <RuleStandingsTable mode="winrate" rows={SECTION6_CASE2_ROWS} />
      </Card>
      <Card style={rs.card}>
        <RuleBracketCard rounds={SECTION6_CASE2_BRACKET} />
      </Card>

      <Text style={rs.h3}>3 empatados</Text>
      <Text style={rs.paragraph}>
        Semifinal entre los 2 peor posicionados; el ganador juega una final contra el mejor posicionado.
      </Text>
      <Card style={rs.card}>
        <RuleStandingsTable mode="winrate" rows={SECTION6_CASE3_ROWS} />
      </Card>
      <Card style={rs.card}>
        <RuleBracketCard rounds={SECTION6_CASE3_BRACKET} />
      </Card>

      <Text style={rs.h3}>4 empatados</Text>
      <Text style={rs.paragraph}>2 semifinales en paralelo, cruzadas por su orden interno.</Text>
      <Card style={rs.card}>
        <RuleStandingsTable mode="winrate" rows={SECTION6_CASE4_ROWS} />
      </Card>
      <Card style={rs.card}>
        <RuleBracketCard rounds={SECTION6_CASE4_BRACKET} />
      </Card>

      <Text style={rs.h3}>5 o más empatados</Text>
      <Text style={rs.paragraph}>
        El mejor ordenado según las reglas de la sección 3 toma el 4to puesto directo, sin jugar nada.
      </Text>
      <Card style={rs.card}>
        <RuleStandingsTable mode="winrate" rows={SECTION6_CASE5PLUS_ROWS} />
      </Card>

      <Text style={rs.h3}>¿Qué pasa si el 3er puesto comparte los mismos puntos que el grupo empatado en 4to lugar?</Text>
      <Text style={rs.paragraph}>
        Nada especial: ese jugador ya clasificó directo al Top 4. La sección 3 resuelve el orden interno del
        grupo entero por sus propios criterios (desempate olímpico, etc.) antes de llegar a esta instancia —
        si esas reglas ya lo dejan en 3er puesto, no entra a esta disputa aunque comparta puntaje con los que
        sí la juegan.
      </Text>
      <Text style={rs.exampleLabel}>Ejemplo — Carla queda 3ra, Diego y Elena disputan el 4to puesto</Text>
      <Card style={rs.card}>
        <RuleStandingsTable mode="winrate" rows={SECTION6_THIRD_PLACE_TIE_ROWS} />
      </Card>

      <View style={rs.sectionDivider} />

      {/* Sección 7 */}
      <Text style={rs.h2}>7. El botón "Me voy"</Text>
      <Text style={rs.paragraph}>
        Si un jugador debe abandonar el draft antes de completar sus enfrentamientos pendientes, puede
        marcarse como "ido". Esto permite que la competencia se cierre igual, sin que sus partidos pendientes
        traben el resultado. Los enfrentamientos pendientes de un jugador que se fue quedan deshabilitados, y
        la tabla se recalcula excluyéndolo de las posiciones en disputa, generando el corrimiento
        correspondiente para el resto.
      </Text>
      <Text style={rs.paragraph}>
        Se puede usar hasta que arranque cualquier desempate o partido de la fase mata-mata. Una vez que eso
        ocurre, ya no se puede modificar.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  spacedTop: { marginTop: 4 },
  situationTable: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 4,
  },
  situationRow: { flexDirection: 'row' },
  situationRowBody: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#eee' },
  situationCell: {
    flex: 1,
    fontSize: 13,
    color: '#111',
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  situationHeaderTxt: { fontWeight: '700', backgroundColor: '#fafafa' },
});

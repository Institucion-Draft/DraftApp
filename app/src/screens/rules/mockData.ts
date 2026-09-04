import type { RuleStandingsRow } from './RuleStandingsTable';
import type { BracketRound } from './RuleBracketCard';
import type { RuleMatchup } from './RuleMatchupSection';

/** Sección 1 — un torneo chico de ejemplo por cada formato. */
export const SECTION1_BO1_ROWS: RuleStandingsRow[] = [
  { id: '1', name: 'Nico', pg: 3, pj: 3 },
  { id: '2', name: 'Fede', pg: 2, pj: 3 },
  { id: '3', name: 'Male', pg: 1, pj: 3 },
  { id: '4', name: 'Juli', pg: 0, pj: 3 },
];

export const SECTION1_BO3_ROWS: RuleStandingsRow[] = [
  { id: '1', name: 'Cami', pg: 3, pj: 3 },
  { id: '2', name: 'Tobi', pg: 2, pj: 3 },
  { id: '3', name: 'Fran', pg: 1, pj: 3 },
  { id: '4', name: 'Vale', pg: 0, pj: 3 },
];

export const SECTION1_POINTS_ROWS: RuleStandingsRow[] = [
  { id: '1', name: 'Nico', pg: 2, pe: 1, pp: 0, pts: 7 },
  { id: '2', name: 'Fede', pg: 1, pe: 2, pp: 0, pts: 5 },
  { id: '3', name: 'Male', pg: 1, pe: 0, pp: 2, pts: 3 },
  { id: '4', name: 'Juli', pg: 0, pe: 1, pp: 2, pts: 1 },
];

/** Sección 2: fase liga de 5 jugadores, sin empates, para mostrar el mecanismo del Top 4. */
export const SECTION2_TOP4_ROWS: RuleStandingsRow[] = [
  { id: '1', name: 'Nico', pg: 4, pj: 4 },
  { id: '2', name: 'Fede', pg: 3, pj: 4 },
  { id: '3', name: 'Male', pg: 2, pj: 4 },
  { id: '4', name: 'Juli', pg: 1, pj: 4 },
  { id: '5', name: 'Santi', pg: 0, pj: 4 },
];

export const SECTION2_BRACKET_ROUNDS: BracketRound[] = [
  {
    title: 'Semifinales',
    matches: [
      { a: { kind: 'player', name: 'Nico (1°)' }, b: { kind: 'player', name: 'Juli (4°)' } },
      { a: { kind: 'player', name: 'Fede (2°)' }, b: { kind: 'player', name: 'Male (3°)' } },
    ],
  },
];

export const SECTION2_SEMIS_MATCHUPS: RuleMatchup[] = [
  { id: 'semi1', phaseLabel: 'Semifinal', a: 'Nico', b: 'Juli' },
  { id: 'semi2', phaseLabel: 'Semifinal', a: 'Fede', b: 'Male' },
];

export const SECTION2_FINAL_MATCHUPS: RuleMatchup[] = [
  { id: 'final', phaseLabel: 'Final', a: 'Nico', b: 'Fede' },
  { id: 'third', phaseLabel: '3er/4to puesto', a: 'Juli', b: 'Male' },
];

/** Sección 5 — desempate real por el 1er puesto (Liga sin top), un set por cada tamaño de grupo. */
export const SECTION5_CASE2_ROWS: RuleStandingsRow[] = [
  { id: '1', name: 'Ana', pg: 3, pj: 4, rank: 1, highlight: true },
  { id: '2', name: 'Bruno', pg: 3, pj: 4, rank: 1, highlight: true },
  { id: '3', name: 'Carla', pg: 2, pj: 4, rank: 3 },
  { id: '4', name: 'Diego', pg: 0, pj: 4, rank: 4 },
];

export const SECTION5_CASE2_BRACKET: BracketRound[] = [
  {
    title: 'Final',
    matches: [{ a: { kind: 'player', name: 'Ana' }, b: { kind: 'player', name: 'Bruno' }, format: 'BO3' }],
  },
];

export const SECTION5_CASE3_ROWS: RuleStandingsRow[] = [
  { id: '1', name: 'Ana', pg: 3, pj: 4, rank: 1, highlight: true },
  { id: '2', name: 'Bruno', pg: 3, pj: 4, rank: 1, highlight: true },
  { id: '3', name: 'Carla', pg: 3, pj: 4, rank: 1, highlight: true },
  { id: '4', name: 'Diego', pg: 1, pj: 4, rank: 4 },
  { id: '5', name: 'Elena', pg: 0, pj: 4, rank: 5 },
];

export const SECTION5_CASE3_BRACKET: BracketRound[] = [
  {
    title: 'Semifinal',
    matches: [{ a: { kind: 'player', name: 'Bruno' }, b: { kind: 'player', name: 'Carla' }, format: 'BO1' }],
  },
  {
    title: 'Final',
    matches: [{ a: { kind: 'player', name: 'Ana' }, b: { kind: 'winnerOf', label: 'la SF' }, format: 'BO3' }],
  },
];

export const SECTION5_CASE4_ROWS: RuleStandingsRow[] = [
  { id: '1', name: 'Ana', pg: 3, pj: 4, rank: 1, highlight: true },
  { id: '2', name: 'Bruno', pg: 3, pj: 4, rank: 1, highlight: true },
  { id: '3', name: 'Carla', pg: 3, pj: 4, rank: 1, highlight: true },
  { id: '4', name: 'Diego', pg: 3, pj: 4, rank: 1, highlight: true },
  { id: '5', name: 'Elena', pg: 0, pj: 4, rank: 5 },
];

export const SECTION5_CASE4_BRACKET: BracketRound[] = [
  {
    title: 'Semifinales',
    matches: [
      { a: { kind: 'player', name: 'Ana' }, b: { kind: 'player', name: 'Diego' }, format: 'BO1' },
      { a: { kind: 'player', name: 'Bruno' }, b: { kind: 'player', name: 'Carla' }, format: 'BO1' },
    ],
  },
  {
    title: 'Final',
    matches: [
      { a: { kind: 'winnerOf', label: 'SF1' }, b: { kind: 'winnerOf', label: 'SF2' }, format: 'BO3' },
    ],
  },
];

/** 5+: el grupo se recorta a los 4 mejor ordenados por la sección 3 (Elena queda afuera, sin
 *  jugar nada) y de ahí en más es exactamente el mismo esquema que el caso de 4. */
export const SECTION5_CASE5PLUS_ROWS: RuleStandingsRow[] = [
  { id: '1', name: 'Ana', pg: 3, pj: 5, rank: 1, highlight: true },
  { id: '2', name: 'Bruno', pg: 3, pj: 5, rank: 1, highlight: true },
  { id: '3', name: 'Carla', pg: 3, pj: 5, rank: 1, highlight: true },
  { id: '4', name: 'Diego', pg: 3, pj: 5, rank: 1, highlight: true },
  { id: '5', name: 'Elena', pg: 3, pj: 5, rank: 1, highlight: true },
  { id: '6', name: 'Facu', pg: 0, pj: 5, rank: 6 },
];

export const SECTION5_CASE5PLUS_BRACKET: BracketRound[] = [
  {
    title: 'Semifinales',
    matches: [
      { a: { kind: 'player', name: 'Ana' }, b: { kind: 'player', name: 'Diego' }, format: 'BO1' },
      { a: { kind: 'player', name: 'Bruno' }, b: { kind: 'player', name: 'Carla' }, format: 'BO1' },
    ],
  },
  {
    title: 'Final',
    matches: [
      { a: { kind: 'winnerOf', label: 'SF1' }, b: { kind: 'winnerOf', label: 'SF2' }, format: 'BO3' },
    ],
  },
];

/**
 * Sección 6 — desempate real por el 4to puesto (Liga + Top 4). Los primeros 3 puestos ya están
 * limpios (sin compartir puntaje con el grupo de abajo) para mostrar cada caso de forma aislada,
 * sin la complicación del 3er puesto (eso se cubre aparte, al final de la sección).
 */
export const SECTION6_CASE2_ROWS: RuleStandingsRow[] = [
  { id: '1', name: 'Ana', pg: 5, pj: 5, rank: 1 },
  { id: '2', name: 'Bruno', pg: 4, pj: 5, rank: 2 },
  { id: '3', name: 'Carla', pg: 3, pj: 5, rank: 3 },
  { id: '4', name: 'Diego', pg: 2, pj: 5, rank: 4, highlight: true },
  { id: '5', name: 'Elena', pg: 2, pj: 5, rank: 4, highlight: true },
  { id: '6', name: 'Facu', pg: 0, pj: 5, rank: 6 },
];

export const SECTION6_CASE2_BRACKET: BracketRound[] = [
  {
    title: 'Desempate',
    matches: [{ a: { kind: 'player', name: 'Diego' }, b: { kind: 'player', name: 'Elena' }, format: 'BO1' }],
  },
];

export const SECTION6_CASE3_ROWS: RuleStandingsRow[] = [
  { id: '1', name: 'Ana', pg: 5, pj: 5, rank: 1 },
  { id: '2', name: 'Bruno', pg: 4, pj: 5, rank: 2 },
  { id: '3', name: 'Carla', pg: 3, pj: 5, rank: 3 },
  { id: '4', name: 'Diego', pg: 2, pj: 5, rank: 4, highlight: true },
  { id: '5', name: 'Elena', pg: 2, pj: 5, rank: 4, highlight: true },
  { id: '6', name: 'Facu', pg: 2, pj: 5, rank: 4, highlight: true },
];

export const SECTION6_CASE3_BRACKET: BracketRound[] = [
  {
    title: 'Semifinal',
    matches: [{ a: { kind: 'player', name: 'Elena' }, b: { kind: 'player', name: 'Facu' }, format: 'BO1' }],
  },
  {
    title: 'Desempate',
    matches: [{ a: { kind: 'player', name: 'Diego' }, b: { kind: 'winnerOf', label: 'la SF' }, format: 'BO1' }],
  },
];

export const SECTION6_CASE4_ROWS: RuleStandingsRow[] = [
  { id: '1', name: 'Ana', pg: 5, pj: 5, rank: 1 },
  { id: '2', name: 'Bruno', pg: 4, pj: 5, rank: 2 },
  { id: '3', name: 'Carla', pg: 3, pj: 5, rank: 3 },
  { id: '4', name: 'Diego', pg: 2, pj: 5, rank: 4, highlight: true },
  { id: '5', name: 'Elena', pg: 2, pj: 5, rank: 4, highlight: true },
  { id: '6', name: 'Facu', pg: 2, pj: 5, rank: 4, highlight: true },
  { id: '7', name: 'Gaby', pg: 2, pj: 5, rank: 4, highlight: true },
];

export const SECTION6_CASE4_BRACKET: BracketRound[] = [
  {
    title: 'Semifinales',
    matches: [
      { a: { kind: 'player', name: 'Diego' }, b: { kind: 'player', name: 'Gaby' }, format: 'BO1' },
      { a: { kind: 'player', name: 'Elena' }, b: { kind: 'player', name: 'Facu' }, format: 'BO1' },
    ],
  },
  {
    title: 'Desempate',
    matches: [{ a: { kind: 'winnerOf', label: 'SF1' }, b: { kind: 'winnerOf', label: 'SF2' }, format: 'BO1' }],
  },
];

/** 5+: el mejor ordenado por la sección 3 (Diego) toma el 4to puesto directo, sin jugar nada. */
export const SECTION6_CASE5PLUS_ROWS: RuleStandingsRow[] = [
  { id: '1', name: 'Ana', pg: 5, pj: 5, rank: 1 },
  { id: '2', name: 'Bruno', pg: 4, pj: 5, rank: 2 },
  { id: '3', name: 'Carla', pg: 3, pj: 5, rank: 3 },
  { id: '4', name: 'Diego', pg: 2, pj: 5, rank: 4, highlight: true },
  { id: '5', name: 'Elena', pg: 2, pj: 5, rank: 4, highlight: true },
  { id: '6', name: 'Facu', pg: 2, pj: 5, rank: 4, highlight: true },
  { id: '7', name: 'Gaby', pg: 2, pj: 5, rank: 4, highlight: true },
  { id: '8', name: 'Hugo', pg: 2, pj: 5, rank: 4, highlight: true },
];

/** Caso especial: Carla comparte % con el grupo de abajo, pero ya quedó 3ra por la sección 3. */
export const SECTION6_THIRD_PLACE_TIE_ROWS: RuleStandingsRow[] = [
  { id: '1', name: 'Ana', pg: 5, pj: 5, rank: 1 },
  { id: '2', name: 'Bruno', pg: 4, pj: 5, rank: 2 },
  { id: '3', name: 'Carla', pg: 3, pj: 5, rank: 3 },
  { id: '4', name: 'Diego', pg: 3, pj: 5, rank: 4, highlight: true },
  { id: '5', name: 'Elena', pg: 3, pj: 5, rank: 4, highlight: true },
  { id: '6', name: 'Facu', pg: 1, pj: 5, rank: 6 },
];

// Movepool por tipo Pokémon para el sistema de turnos.
// Cada movimiento tiene nombre y emoji asociado.

export type PokemonType =
  | 'grass' | 'fire' | 'water' | 'bug' | 'electric'
  | 'ground' | 'rock' | 'ghost' | 'normal' | 'flying'
  | 'poison' | 'psychic' | 'fighting' | 'ice' | 'steel'
  | 'dark' | 'dragon';

export type MoveCategory =
  | 'damage' | 'absorption' | 'self_heal'
  | 'self_damage_both' | 'self_damage_only' | 'neutral';

export type MoveTarget = 'enemy' | 'self' | 'absorb';

export type MovePattern = 'sequential' | 'surround' | 'circular' | 'sequential_around';

export type Move = {
  name: string;
  emoji: string;
  target: MoveTarget;
  /** Cantidad de emojis simultáneos/secuenciales (patrones avanzados). */
  count?: number;
  pattern?: MovePattern;
  /** Segundo emoji para combos secuenciales (p. ej. Pin Misil). */
  emojiAlt?: string;
};

/**
 * Si hay count > 1 sin pattern explícito, el cliente usa secuencial por defecto.
 */
export function getEffectiveAttackPattern(move: Move): MovePattern | undefined {
  if (move.pattern) return move.pattern;
  if ((move.count ?? 1) > 1) return 'sequential';
  return undefined;
}

/** Secuencia de emojis para animación sequential (alterna emojiAlt si existe). */
export function buildSequentialEmojis(move: Move): string[] {
  const n = Math.max(1, move.count ?? 1);
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const useAlt = move.emojiAlt != null && i % 2 === 1;
    out.push(useAlt ? move.emojiAlt! : move.emoji);
  }
  return out;
}

type Movepool = Partial<Record<MoveCategory, Move[]>>;

const MOVEPOOL: Record<PokemonType, Movepool> = {
  grass: {
    damage: [
      { name: 'Hojas Navaja', emoji: '🍃', target: 'enemy' },
      { name: 'Látigo Cepa', emoji: '🌱', target: 'enemy' },
      { name: 'Rayo Solar', emoji: '☀️', target: 'enemy' },
    ],
    absorption: [
      { name: 'Gigadrenado', emoji: '🌿', target: 'absorb' },
      { name: 'Absorción', emoji: '✨', target: 'absorb' },
    ],
    self_heal: [{ name: 'Síntesis', emoji: '☀️', target: 'self' }],
    neutral: [
      { name: 'Gruñido', emoji: '🤬', target: 'enemy' },
      { name: 'Polvo Veneno', emoji: '💨', target: 'enemy' },
    ],
  },
  fire: {
    damage: [
      { name: 'Lanzallamas', emoji: '🔥', target: 'enemy' },
      { name: 'Ascuas', emoji: '🔥', target: 'enemy' },
      { name: 'Llamarada', emoji: '🔥', target: 'enemy' },
    ],
    self_heal: [{ name: 'Día Soleado', emoji: '☀️', target: 'self' }],
    neutral: [
      { name: 'Pantalla de Humo', emoji: '😶‍🌫️', target: 'self' },
      { name: 'Gruñido', emoji: '😠', target: 'enemy' },
    ],
  },
  water: {
    damage: [
      { name: 'Pistola Agua', emoji: '💧', target: 'enemy' },
      { name: 'Hidrobomba', emoji: '🌊', target: 'enemy' },
      { name: 'Burbuja', emoji: '🫧', target: 'enemy' },
    ],
    self_heal: [{ name: 'Danza Lluvia', emoji: '🌧️', target: 'self' }],
    neutral: [
      { name: 'Refugio', emoji: '🐚', target: 'self' },
      { name: 'Niebla', emoji: '😶‍🌫️', target: 'self' },
    ],
  },
  bug: {
    damage: [
      { name: 'Pin Misil', emoji: '🪲', emojiAlt: '💉', count: 2, pattern: 'sequential', target: 'enemy' },
      { name: 'Picadura', emoji: '🪲', emojiAlt: '💉', count: 2, pattern: 'sequential', target: 'enemy' },
      { name: 'Corte Furia', emoji: '🗡️', target: 'enemy' },
      { name: 'Megacuerno', emoji: '🫎', target: 'enemy' },
    ],
    absorption: [{ name: 'Chupavidas', emoji: '🩸', target: 'absorb' }],
    neutral: [
      { name: 'Disparo Demora', emoji: '🕸️', target: 'enemy' },
      { name: 'Doble Equipo', emoji: '👥', target: 'self' },
    ],
  },
  electric: {
    damage: [
      { name: 'Impactrueno', emoji: '⚡', target: 'enemy' },
      { name: 'Trueno', emoji: '⚡', count: 3, pattern: 'sequential', target: 'enemy' },
      { name: 'Rayo', emoji: '⚡', count: 2, pattern: 'sequential', target: 'enemy' },
    ],
    self_damage_both: [{ name: 'Explosión', emoji: '💥', target: 'enemy' }],
    neutral: [
      { name: 'Agilidad', emoji: '👥', target: 'self' },
      { name: 'Gruñido', emoji: '😠', target: 'enemy' },
    ],
  },
  ground: {
    damage: [
      { name: 'Terremoto', emoji: '🫨', target: 'enemy' },
      { name: 'Bomba Lodo', emoji: '💩', target: 'enemy' },
      { name: 'Magnitud', emoji: '🪨', count: 2, pattern: 'sequential', target: 'enemy' },
    ],
    neutral: [{ name: 'Ataque Arena', emoji: '⏳', target: 'enemy' }],
  },
  rock: {
    damage: [
      { name: 'Lanzarrocas', emoji: '🪨', target: 'enemy' },
      { name: 'Magnitud', emoji: '🪨', count: 2, pattern: 'sequential', target: 'enemy' },
    ],
    neutral: [
      { name: 'Ataque Arena', emoji: '⏳', target: 'enemy' },
      { name: 'Defensa Férrea', emoji: '🛡️', target: 'self' },
    ],
  },
  ghost: {
    damage: [
      { name: 'Bola Sombra', emoji: '🌀', target: 'enemy' },
      { name: 'Confusión', emoji: '😵‍💫', target: 'enemy', count: 4, pattern: 'surround' },
      { name: 'Lengüetazo', emoji: '👅', target: 'enemy' },
    ],
    absorption: [{ name: 'Comesueños', emoji: '😴', target: 'absorb', count: 4, pattern: 'surround' }],
    self_damage_only: [{ name: 'Maldición', emoji: '💀', target: 'self' }],
    neutral: [{ name: 'Mal de Ojo', emoji: '👁️', target: 'enemy', count: 3, pattern: 'surround' }],
  },
  normal: {
    damage: [
      { name: 'Placaje', emoji: '💢', target: 'enemy' },
      { name: 'Golpe Cabeza', emoji: '🤕', target: 'enemy' },
      { name: 'Doble Patada', emoji: '🦵', target: 'enemy' },
      { name: 'Hiperrayo', emoji: '☄️', target: 'enemy' },
    ],
    self_damage_both: [{ name: 'Derribo', emoji: '💢', target: 'enemy' }],
    self_heal: [{ name: 'Descanso', emoji: '😴', target: 'self' }],
    neutral: [
      { name: 'Gruñido', emoji: '😠', target: 'enemy' },
      { name: 'Foco Resplandor', emoji: '✨', target: 'self' },
    ],
  },
  flying: {
    damage: [
      { name: 'Ataque Ala', emoji: '🪽', target: 'enemy' },
      { name: 'Pico Taladro', emoji: '🐦', target: 'enemy' },
      { name: 'Tornado', emoji: '🌪️', target: 'enemy' },
    ],
    neutral: [
      { name: 'Ataque Arena', emoji: '⏳', target: 'enemy' },
      { name: 'Gruñido', emoji: '😠', target: 'enemy' },
    ],
  },
  poison: {
    damage: [
      { name: 'Bomba Lodo', emoji: '💩', target: 'enemy' },
      { name: 'Residuos', emoji: '☣️', target: 'enemy' },
      { name: 'Picotazo Veneno', emoji: '💉', target: 'enemy' },
    ],
    self_damage_both: [{ name: 'Autodestrucción', emoji: '💥', target: 'enemy' }],
    neutral: [
      { name: 'Bomba Humo', emoji: '😶‍🌫️', target: 'self' },
      { name: 'Niebla', emoji: '😶‍🌫️', target: 'self' },
    ],
  },
  psychic: {
    damage: [
      { name: 'Confusión', emoji: '😵‍💫', target: 'enemy', count: 4, pattern: 'surround' },
      { name: 'Psicoonda', emoji: '🧠', target: 'enemy' },
      { name: 'Psíquico', emoji: '🔮', target: 'enemy' },
    ],
    absorption: [{ name: 'Comesueños', emoji: '😴', target: 'absorb', count: 4, pattern: 'surround' }],
    self_heal: [{ name: 'Recuperación', emoji: '💫', target: 'self' }],
    neutral: [
      { name: 'Barrera', emoji: '🛡️', target: 'self' },
      { name: 'Premonición', emoji: '🔮', target: 'self' },
    ],
  },
  fighting: {
    damage: [
      { name: 'Movimiento Sísmico', emoji: '🌎', target: 'enemy', pattern: 'circular' },
      { name: 'Golpe Karate', emoji: '🥋', target: 'enemy' },
      { name: 'Patada Salto', emoji: '🦵', target: 'enemy' },
    ],
    self_damage_both: [{ name: 'Sumisión', emoji: '💢', target: 'enemy' }],
    neutral: [{ name: 'Foco Energía', emoji: '💪', target: 'self' }],
  },
  ice: {
    damage: [
      { name: 'Rayo Hielo', emoji: '❄️', target: 'enemy' },
      { name: 'Ventisca', emoji: '🌨️', target: 'enemy' },
      { name: 'Vaho Helado', emoji: '🥶', target: 'enemy' },
    ],
    neutral: [{ name: 'Niebla', emoji: '😶‍🌫️', target: 'self' }],
  },
  steel: {
    damage: [
      { name: 'Ala Acero', emoji: '⚙️', target: 'enemy' },
      { name: 'Cola Férrea', emoji: '⚙️', target: 'enemy' },
    ],
    neutral: [{ name: 'Defensa Férrea', emoji: '🛡️', target: 'self' }],
  },
  dark: {
    damage: [
      { name: 'Mordisco', emoji: '🦷', target: 'enemy' },
      { name: 'Triquiñuela', emoji: '🌑', target: 'enemy' },
    ],
    absorption: [{ name: 'Robo', emoji: '💰', target: 'absorb' }],
    neutral: [{ name: 'Persecución', emoji: '👁️', target: 'enemy' }],
  },
  dragon: {
    damage: [
      { name: 'Furia Dragón', emoji: '🐉', target: 'enemy' },
      { name: 'Hiperrayo', emoji: '☄️', target: 'enemy' },
    ],
    self_heal: [{ name: 'Recuperación', emoji: '💫', target: 'self' }],
    neutral: [{ name: 'Danza Dragón', emoji: '🐲', target: 'self', pattern: 'circular' }],
  },
};

// Mapeo de Pokémon (nombre del avatar: minúsculas, guión bajo) → tipos. Kanto + Johto.
const POKEMON_TYPES: Record<string, PokemonType[]> = {
  // KANTO - Starters
  bulbasaur: ['grass', 'poison'], ivysaur: ['grass', 'poison'], venusaur: ['grass', 'poison'],
  charmander: ['fire'], charmeleon: ['fire'], charizard: ['fire', 'flying'],
  squirtle: ['water'], wartortle: ['water'], blastoise: ['water'],
  // KANTO - Bug
  caterpie: ['bug'], metapod: ['bug'], butterfree: ['bug', 'flying'],
  weedle: ['bug', 'poison'], kakuna: ['bug', 'poison'], beedrill: ['bug', 'poison'],
  paras: ['bug', 'grass'], parasect: ['bug', 'grass'],
  venonat: ['bug', 'poison'], venomoth: ['bug', 'poison'],
  scyther: ['bug', 'flying'], pinsir: ['bug'],
  // KANTO - Flying
  pidgey: ['normal', 'flying'], pidgeotto: ['normal', 'flying'], pidgeot: ['normal', 'flying'],
  spearow: ['normal', 'flying'], fearow: ['normal', 'flying'],
  farfetchd: ['normal', 'flying'], doduo: ['normal', 'flying'], dodrio: ['normal', 'flying'],
  // KANTO - Electric
  pikachu: ['electric'], raichu: ['electric'],
  magnemite: ['electric', 'steel'], magneton: ['electric', 'steel'],
  voltorb: ['electric'], electrode: ['electric'],
  electabuzz: ['electric'],
  zapdos: ['electric', 'flying'],
  // KANTO - Rock/Ground
  geodude: ['rock', 'ground'], graveler: ['rock', 'ground'], golem: ['rock', 'ground'],
  onix: ['rock', 'ground'],
  rhyhorn: ['ground', 'rock'], rhydon: ['ground', 'rock'],
  omanyte: ['rock', 'water'], omastar: ['rock', 'water'],
  kabuto: ['rock', 'water'], kabutops: ['rock', 'water'],
  aerodactyl: ['rock', 'flying'],
  sandshrew: ['ground'], sandslash: ['ground'],
  diglett: ['ground'], dugtrio: ['ground'],
  cubone: ['ground'], marowak: ['ground'],
  // KANTO - Water
  psyduck: ['water'], golduck: ['water'],
  poliwag: ['water'], poliwhirl: ['water'], poliwrath: ['water', 'fighting'],
  tentacool: ['water', 'poison'], tentacruel: ['water', 'poison'],
  slowpoke: ['water', 'psychic'], slowbro: ['water', 'psychic'],
  seel: ['water'], dewgong: ['water', 'ice'],
  shellder: ['water'], cloyster: ['water', 'ice'],
  krabby: ['water'], kingler: ['water'],
  horsea: ['water'], seadra: ['water'],
  goldeen: ['water'], seaking: ['water'],
  staryu: ['water'], starmie: ['water', 'psychic'],
  magikarp: ['water'], gyarados: ['water', 'flying'],
  lapras: ['water', 'ice'],
  vaporeon: ['water'],
  // KANTO - Psychic
  abra: ['psychic'], kadabra: ['psychic'], alakazam: ['psychic'],
  drowzee: ['psychic'], hypno: ['psychic'],
  mr_mime: ['psychic'],
  jynx: ['ice', 'psychic'],
  mewtwo: ['psychic'], mew: ['psychic'],
  exeggcute: ['grass', 'psychic'], exeggutor: ['grass', 'psychic'],
  // KANTO - Fighting
  mankey: ['fighting'], primeape: ['fighting'],
  machop: ['fighting'], machoke: ['fighting'], machamp: ['fighting'],
  hitmonlee: ['fighting'], hitmonchan: ['fighting'],
  // KANTO - Ghost
  gastly: ['ghost', 'poison'], haunter: ['ghost', 'poison'], gengar: ['ghost', 'poison'],
  // KANTO - Normal
  rattata: ['normal'], raticate: ['normal'],
  jigglypuff: ['normal'], wigglytuff: ['normal'],
  meowth: ['normal'], persian: ['normal'],
  snorlax: ['normal'],
  eevee: ['normal'],
  ditto: ['normal'],
  clefairy: ['normal'], clefable: ['normal'],
  lickitung: ['normal'],
  chansey: ['normal'],
  kangaskhan: ['normal'],
  tauros: ['normal'],
  porygon: ['normal'],
  // KANTO - Fire
  vulpix: ['fire'], ninetales: ['fire'],
  growlithe: ['fire'], arcanine: ['fire'],
  ponyta: ['fire'], rapidash: ['fire'],
  magmar: ['fire'],
  flareon: ['fire'],
  moltres: ['fire', 'flying'],
  // KANTO - Ice
  articuno: ['ice', 'flying'],
  // KANTO - Electric (Eevee)
  jolteon: ['electric'],
  // KANTO - Dragon
  dratini: ['dragon'], dragonair: ['dragon'], dragonite: ['dragon', 'flying'],
  // KANTO - Grass
  oddish: ['grass', 'poison'], gloom: ['grass', 'poison'], vileplume: ['grass', 'poison'],
  bellsprout: ['grass', 'poison'], weepinbell: ['grass', 'poison'], victreebel: ['grass', 'poison'],
  tangela: ['grass'],
  // KANTO - Poison
  ekans: ['poison'], arbok: ['poison'],
  nidoran_f: ['poison'], nidorina: ['poison'], nidoqueen: ['poison', 'ground'],
  nidoran_m: ['poison'], nidorino: ['poison'], nidoking: ['poison', 'ground'],
  zubat: ['poison', 'flying'], golbat: ['poison', 'flying'],
  grimer: ['poison'], muk: ['poison'],
  koffing: ['poison'], weezing: ['poison'],
  // JOHTO - Starters
  chikorita: ['grass'], bayleef: ['grass'], meganium: ['grass'],
  cyndaquil: ['fire'], quilava: ['fire'], typhlosion: ['fire'],
  totodile: ['water'], croconaw: ['water'], feraligatr: ['water'],
  // JOHTO - Bug
  sentret: ['normal'], furret: ['normal'],
  hoothoot: ['normal', 'flying'], noctowl: ['normal', 'flying'],
  ledyba: ['bug', 'flying'], ledian: ['bug', 'flying'],
  spinarak: ['bug', 'poison'], ariados: ['bug', 'poison'],
  crobat: ['poison', 'flying'],
  chinchou: ['water', 'electric'], lanturn: ['water', 'electric'],
  pichu: ['electric'],
  cleffa: ['normal'],
  igglybuff: ['normal'],
  togepi: ['normal'], togetic: ['normal', 'flying'],
  natu: ['psychic', 'flying'], xatu: ['psychic', 'flying'],
  mareep: ['electric'], flaaffy: ['electric'], ampharos: ['electric'],
  bellossom: ['grass'],
  marill: ['water'], azumarill: ['water'],
  sudowoodo: ['rock'],
  politoed: ['water'],
  hoppip: ['grass', 'flying'], skiploom: ['grass', 'flying'], jumpluff: ['grass', 'flying'],
  aipom: ['normal'],
  sunkern: ['grass'], sunflora: ['grass'],
  yanma: ['bug', 'flying'],
  wooper: ['water', 'ground'], quagsire: ['water', 'ground'],
  espeon: ['psychic'], umbreon: ['dark'],
  murkrow: ['dark', 'flying'],
  slowking: ['water', 'psychic'],
  misdreavus: ['ghost'],
  unown: ['psychic'],
  wobbuffet: ['psychic'],
  girafarig: ['normal', 'psychic'],
  pineco: ['bug'], forretress: ['bug', 'steel'],
  dunsparce: ['normal'],
  gligar: ['ground', 'flying'],
  steelix: ['steel', 'ground'],
  snubbull: ['normal'], granbull: ['normal'],
  qwilfish: ['water', 'poison'],
  scizor: ['bug', 'steel'],
  shuckle: ['bug', 'rock'],
  heracross: ['bug', 'fighting'],
  sneasel: ['dark', 'ice'],
  teddiursa: ['normal'], ursaring: ['normal'],
  slugma: ['fire'], magcargo: ['fire', 'rock'],
  swinub: ['ice', 'ground'], piloswine: ['ice', 'ground'],
  corsola: ['water', 'rock'],
  remoraid: ['water'], octillery: ['water'],
  delibird: ['ice', 'flying'],
  mantine: ['water', 'flying'],
  skarmory: ['steel', 'flying'],
  houndour: ['dark', 'fire'], houndoom: ['dark', 'fire'],
  kingdra: ['water', 'dragon'],
  phanpy: ['ground'], donphan: ['ground'],
  porygon2: ['normal'],
  stantler: ['normal'],
  smeargle: ['normal'],
  tyrogue: ['fighting'],
  hitmontop: ['fighting'],
  smoochum: ['ice', 'psychic'],
  elekid: ['electric'],
  magby: ['fire'],
  miltank: ['normal'],
  blissey: ['normal'],
  raikou: ['electric'],
  entei: ['fire'],
  suicune: ['water'],
  larvitar: ['rock', 'ground'], pupitar: ['rock', 'ground'], tyranitar: ['rock', 'dark'],
  lugia: ['psychic', 'flying'],
  ho_oh: ['fire', 'flying'],
  celebi: ['psychic', 'grass'],
};

// Pokémon con comportamiento especial
const SPECIAL_BEHAVIOR: Record<string, 'ditto' | 'metronome'> = {
  ditto: 'ditto',
  togepi: 'metronome',
  togetic: 'metronome',
  clefairy: 'metronome',
  clefable: 'metronome',
};

/**
 * Determina la categoría de movimiento según los deltas de vida del turno.
 * Si yo gano vida y el otro pierde, prioriza absorción.
 * Si yo gano y el otro mantiene/gana, self_heal.
 * Si yo pierdo y el otro pierde, self_damage_both.
 * Si yo pierdo y el otro mantiene, self_damage_only.
 * Si yo mantengo/gano y el otro pierde (pero yo no gano), damage.
 * Sino, neutral.
 */
export function categorizeMove(myDelta: number, otherDelta: number): MoveCategory {
  if (myDelta > 0 && otherDelta < 0) return 'absorption';
  if (myDelta > 0 && otherDelta >= 0) return 'self_heal';
  if (myDelta < 0 && otherDelta < 0) return 'self_damage_both';
  if (myDelta < 0 && otherDelta >= 0) return 'self_damage_only';
  if (myDelta >= 0 && otherDelta < 0) return 'damage';
  return 'neutral';
}

/**
 * Devuelve un movimiento aleatorio del Pokémon atacante para la categoría dada.
 * Con fallbacks: si el tipo no tiene esa categoría, intenta 'damage' (si otherDelta<0)
 * o 'neutral' (en cualquier otro caso).
 */
export function pickMove(
  pokemonName: string,
  category: MoveCategory,
  otherDelta: number
): Move {
  const normalized = pokemonName.toLowerCase().replace(/\s+/g, '_');
  const types = POKEMON_TYPES[normalized] ?? ['normal'];

  const pickFromTypes = (cat: MoveCategory): Move | null => {
    for (const type of types) {
      const moves = MOVEPOOL[type]?.[cat];
      if (moves && moves.length > 0) {
        return moves[Math.floor(Math.random() * moves.length)]!;
      }
    }
    return null;
  };

  let move = pickFromTypes(category);
  if (move) return move;

  // Fallback: si el otro perdió vida, intentar damage
  if (otherDelta < 0) {
    move = pickFromTypes('damage');
    if (move) return move;
  }

  // Último fallback: neutral
  move = pickFromTypes('neutral');
  if (move) return move;

  // Si no hay nada, devolver placaje genérico
  return { name: 'Placaje', emoji: '💢', target: 'enemy' };
}

const ALL_MOVE_CATEGORIES: MoveCategory[] = [
  'damage',
  'absorption',
  'self_heal',
  'self_damage_both',
  'self_damage_only',
  'neutral',
];

/**
 * Todos los movimientos definidos en MOVEPOOL (todos los tipos y categorías).
 */
export function getAllMoves(): Move[] {
  const moves: Move[] = [];
  for (const pokeType of Object.keys(MOVEPOOL) as PokemonType[]) {
    const pool = MOVEPOOL[pokeType];
    for (const cat of ALL_MOVE_CATEGORIES) {
      const chunk = pool[cat];
      if (chunk?.length) moves.push(...chunk);
    }
  }
  return moves;
}

/**
 * Un movimiento al azar de todo el movepool (para Metrónomo).
 */
export function pickRandomMoveFromAll(): Move {
  const all = getAllMoves();
  if (all.length === 0) return { name: 'Placaje', emoji: '💢', target: 'enemy' };
  return all[Math.floor(Math.random() * all.length)]!;
}

/**
 * Para Ditto/metronome: devuelve el tipo de comportamiento especial, o null si es normal.
 */
export function getSpecialBehavior(pokemonName: string): 'ditto' | 'metronome' | null {
  const normalized = pokemonName.toLowerCase().replace(/\s+/g, '_');
  return SPECIAL_BEHAVIOR[normalized] ?? null;
}

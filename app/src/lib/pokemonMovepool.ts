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

export type Move = {
  name: string;
  emoji: string;
};

type Movepool = Partial<Record<MoveCategory, Move[]>>;

const MOVEPOOL: Record<PokemonType, Movepool> = {
  grass: {
    damage: [
      { name: 'Hojas Navaja', emoji: '🌿' },
      { name: 'Látigo Cepa', emoji: '🌱' },
      { name: 'Rayo Solar', emoji: '☀️' },
    ],
    absorption: [
      { name: 'Gigadrenado', emoji: '🌿' },
      { name: 'Absorción', emoji: '🍃' },
    ],
    self_heal: [
      { name: 'Síntesis', emoji: '☀️' },
      { name: 'Fotosíntesis', emoji: '🌻' },
    ],
    neutral: [
      { name: 'Gruñido', emoji: '😠' },
      { name: 'Polvo Veneno', emoji: '💨' },
    ],
  },
  fire: {
    damage: [
      { name: 'Lanzallamas', emoji: '🔥' },
      { name: 'Ascuas', emoji: '🔥' },
      { name: 'Llamarada', emoji: '🔥' },
    ],
    self_heal: [
      { name: 'Día Soleado', emoji: '☀️' },
    ],
    neutral: [
      { name: 'Pantalla de Humo', emoji: '💨' },
      { name: 'Gruñido', emoji: '😠' },
    ],
  },
  water: {
    damage: [
      { name: 'Pistola Agua', emoji: '💧' },
      { name: 'Hidrobomba', emoji: '🌊' },
      { name: 'Burbuja', emoji: '🫧' },
    ],
    self_heal: [
      { name: 'Danza Lluvia', emoji: '🌧️' },
    ],
    neutral: [
      { name: 'Refugio', emoji: '🐚' },
      { name: 'Niebla', emoji: '🌫️' },
    ],
  },
  bug: {
    damage: [
      { name: 'Pin Misil', emoji: '🪲' },
      { name: 'Picadura', emoji: '🪲' },
      { name: 'Corte Furia', emoji: '🗡️' },
      { name: 'Megacuerno', emoji: '🐂' },
    ],
    absorption: [
      { name: 'Chupavidas', emoji: '🩸' },
    ],
    neutral: [
      { name: 'Disparo Demora', emoji: '🕸️' },
      { name: 'Doble Equipo', emoji: '👥' },
    ],
  },
  electric: {
    damage: [
      { name: 'Impactrueno', emoji: '⚡' },
      { name: 'Trueno', emoji: '⚡' },
      { name: 'Rayo', emoji: '⚡' },
    ],
    self_damage_both: [
      { name: 'Explosión', emoji: '💥' },
    ],
    neutral: [
      { name: 'Agilidad', emoji: '💨' },
      { name: 'Gruñido', emoji: '😠' },
    ],
  },
  ground: {
    damage: [
      { name: 'Terremoto', emoji: '🌋' },
      { name: 'Bomba Lodo', emoji: '💩' },
      { name: 'Magnitud', emoji: '🌍' },
    ],
    neutral: [
      { name: 'Ataque Arena', emoji: '🏜️' },
    ],
  },
  rock: {
    damage: [
      { name: 'Avalancha', emoji: '🪨' },
      { name: 'Lanzarrocas', emoji: '🪨' },
      { name: 'Magnitud', emoji: '🌍' },
    ],
    neutral: [
      { name: 'Ataque Arena', emoji: '🏜️' },
      { name: 'Defensa Férrea', emoji: '🛡️' },
    ],
  },
  ghost: {
    damage: [
      { name: 'Bola Sombra', emoji: '👻' },
      { name: 'Confusión', emoji: '🌀' },
      { name: 'Lengüetazo', emoji: '👅' },
    ],
    absorption: [
      { name: 'Comesueños', emoji: '😴' },
    ],
    self_damage_only: [
      { name: 'Maldición', emoji: '💀' },
    ],
    neutral: [
      { name: 'Mal de Ojo', emoji: '👁️' },
    ],
  },
  normal: {
    damage: [
      { name: 'Placaje', emoji: '💢' },
      { name: 'Golpe Cabeza', emoji: '🤕' },
      { name: 'Doble Patada', emoji: '🦵' },
      { name: 'Hiperrayo', emoji: '☄️' },
    ],
    self_damage_both: [
      { name: 'Derribo', emoji: '💢' },
    ],
    self_heal: [
      { name: 'Descanso', emoji: '😴' },
    ],
    neutral: [
      { name: 'Gruñido', emoji: '😠' },
      { name: 'Foco Resplandor', emoji: '✨' },
    ],
  },
  flying: {
    damage: [
      { name: 'Ataque Ala', emoji: '🪽' },
      { name: 'Pico Taladro', emoji: '🐦' },
      { name: 'Tornado', emoji: '🌪️' },
    ],
    neutral: [
      { name: 'Ataque Arena', emoji: '🏜️' },
      { name: 'Gruñido', emoji: '😠' },
    ],
  },
  poison: {
    damage: [
      { name: 'Bomba Lodo', emoji: '💩' },
      { name: 'Residuos', emoji: '☣️' },
      { name: 'Picotazo Veneno', emoji: '💉' },
    ],
    self_damage_both: [
      { name: 'Autodestrucción', emoji: '💥' },
    ],
    neutral: [
      { name: 'Bomba Humo', emoji: '💨' },
      { name: 'Niebla', emoji: '🌫️' },
    ],
  },
  psychic: {
    damage: [
      { name: 'Confusión', emoji: '🌀' },
      { name: 'Psicoonda', emoji: '🧠' },
      { name: 'Psíquico', emoji: '🔮' },
    ],
    absorption: [
      { name: 'Comesueños', emoji: '😴' },
    ],
    self_heal: [
      { name: 'Recuperación', emoji: '💫' },
    ],
    neutral: [
      { name: 'Barrera', emoji: '🛡️' },
      { name: 'Premonición', emoji: '🔮' },
    ],
  },
  fighting: {
    damage: [
      { name: 'Movimiento Sísmico', emoji: '🥊' },
      { name: 'Golpe Karate', emoji: '🥋' },
      { name: 'Patada Salto', emoji: '🦵' },
    ],
    self_damage_both: [
      { name: 'Sumisión', emoji: '💢' },
    ],
    neutral: [
      { name: 'Foco Energía', emoji: '💪' },
    ],
  },
  ice: {
    damage: [
      { name: 'Rayo Hielo', emoji: '❄️' },
      { name: 'Ventisca', emoji: '🌨️' },
      { name: 'Vaho Helado', emoji: '🥶' },
    ],
    neutral: [
      { name: 'Niebla', emoji: '🌫️' },
    ],
  },
  steel: {
    damage: [
      { name: 'Ala Acero', emoji: '⚙️' },
      { name: 'Cola Férrea', emoji: '⚙️' },
    ],
    neutral: [
      { name: 'Defensa Férrea', emoji: '🛡️' },
    ],
  },
  dark: {
    damage: [
      { name: 'Mordisco', emoji: '🦷' },
      { name: 'Triquiñuela', emoji: '🌑' },
    ],
    absorption: [
      { name: 'Robo', emoji: '🦹' },
    ],
    neutral: [
      { name: 'Persecución', emoji: '👁️' },
    ],
  },
  dragon: {
    damage: [
      { name: 'Furia Dragón', emoji: '🐉' },
      { name: 'Hiperrayo', emoji: '☄️' },
    ],
    self_heal: [
      { name: 'Recuperación', emoji: '💫' },
    ],
    neutral: [
      { name: 'Danza Dragón', emoji: '🐲' },
    ],
  },
};

// Mapeo de Pokémon (por nombre del avatar) a sus tipos.
// Solo incluyo los más clásicos; el resto se mapea por similitud o se trata como 'normal'.
const POKEMON_TYPES: Record<string, PokemonType[]> = {
  // Starters Kanto
  bulbasaur: ['grass', 'poison'], ivysaur: ['grass', 'poison'], venusaur: ['grass', 'poison'],
  charmander: ['fire'], charmeleon: ['fire'], charizard: ['fire', 'flying'],
  squirtle: ['water'], wartortle: ['water'], blastoise: ['water'],
  // Bugs
  caterpie: ['bug'], metapod: ['bug'], butterfree: ['bug', 'flying'],
  weedle: ['bug', 'poison'], kakuna: ['bug', 'poison'], beedrill: ['bug', 'poison'],
  pinsir: ['bug'], scyther: ['bug', 'flying'], heracross: ['bug', 'fighting'],
  // Flyers
  pidgey: ['normal', 'flying'], pidgeotto: ['normal', 'flying'], pidgeot: ['normal', 'flying'],
  spearow: ['normal', 'flying'], fearow: ['normal', 'flying'],
  // Electric
  pikachu: ['electric'], raichu: ['electric'],
  magnemite: ['electric', 'steel'], magneton: ['electric', 'steel'],
  voltorb: ['electric'], electrode: ['electric'],
  // Rock
  geodude: ['rock', 'ground'], graveler: ['rock', 'ground'], golem: ['rock', 'ground'],
  onix: ['rock', 'ground'], steelix: ['steel', 'ground'],
  // Water
  psyduck: ['water'], golduck: ['water'],
  poliwag: ['water'], poliwhirl: ['water'], poliwrath: ['water', 'fighting'],
  tentacool: ['water', 'poison'], tentacruel: ['water', 'poison'],
  seel: ['water'], dewgong: ['water', 'ice'],
  shellder: ['water'], cloyster: ['water', 'ice'],
  krabby: ['water'], kingler: ['water'],
  horsea: ['water'], seadra: ['water'],
  goldeen: ['water'], seaking: ['water'],
  staryu: ['water'], starmie: ['water', 'psychic'],
  magikarp: ['water'], gyarados: ['water', 'flying'],
  lapras: ['water', 'ice'],
  // Psychic
  abra: ['psychic'], kadabra: ['psychic'], alakazam: ['psychic'],
  drowzee: ['psychic'], hypno: ['psychic'],
  mr_mime: ['psychic'],
  jynx: ['ice', 'psychic'],
  mewtwo: ['psychic'], mew: ['psychic'],
  // Fighting
  machop: ['fighting'], machoke: ['fighting'], machamp: ['fighting'],
  hitmonlee: ['fighting'], hitmonchan: ['fighting'],
  // Ghost
  gastly: ['ghost', 'poison'], haunter: ['ghost', 'poison'], gengar: ['ghost', 'poison'],
  // Normal
  rattata: ['normal'], raticate: ['normal'],
  jigglypuff: ['normal'], wigglytuff: ['normal'],
  meowth: ['normal'], persian: ['normal'],
  snorlax: ['normal'],
  eevee: ['normal'],
  // Ditto especial
  ditto: ['normal'],
  // Fire
  vulpix: ['fire'], ninetales: ['fire'],
  growlithe: ['fire'], arcanine: ['fire'],
  ponyta: ['fire'], rapidash: ['fire'],
  magmar: ['fire'],
  flareon: ['fire'],
  moltres: ['fire', 'flying'],
  // Ice
  articuno: ['ice', 'flying'],
  // Electric
  zapdos: ['electric', 'flying'],
  // Dragon
  dratini: ['dragon'], dragonair: ['dragon'], dragonite: ['dragon', 'flying'],
  // Grass
  oddish: ['grass', 'poison'], gloom: ['grass', 'poison'], vileplume: ['grass', 'poison'],
  bellsprout: ['grass', 'poison'], weepinbell: ['grass', 'poison'], victreebel: ['grass', 'poison'],
  exeggcute: ['grass', 'psychic'], exeggutor: ['grass', 'psychic'],
  tangela: ['grass'],
  // Poison
  ekans: ['poison'], arbok: ['poison'],
  nidoran_f: ['poison'], nidorina: ['poison'], nidoqueen: ['poison', 'ground'],
  nidoran_m: ['poison'], nidorino: ['poison'], nidoking: ['poison', 'ground'],
  zubat: ['poison', 'flying'], golbat: ['poison', 'flying'],
  grimer: ['poison'], muk: ['poison'],
  koffing: ['poison'], weezing: ['poison'],
  // Ground
  sandshrew: ['ground'], sandslash: ['ground'],
  diglett: ['ground'], dugtrio: ['ground'],
  cubone: ['ground'], marowak: ['ground'],
  rhyhorn: ['ground', 'rock'], rhydon: ['ground', 'rock'],
  // Eeveelutions
  vaporeon: ['water'], jolteon: ['electric'],
  // Mantine
  lickitung: ['normal'],
  chansey: ['normal'],
  kangaskhan: ['normal'],
  tauros: ['normal'],
  porygon: ['normal'],
  aerodactyl: ['rock', 'flying'],
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
  return { name: 'Placaje', emoji: '💢' };
}

/**
 * Para Ditto/metronome: devuelve el tipo de comportamiento especial, o null si es normal.
 */
export function getSpecialBehavior(pokemonName: string): 'ditto' | 'metronome' | null {
  const normalized = pokemonName.toLowerCase().replace(/\s+/g, '_');
  return SPECIAL_BEHAVIOR[normalized] ?? null;
}

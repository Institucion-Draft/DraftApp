/**
 * Podio proyectado: campeón declarado (`champion_user_id`), campeón seguro ante BO3 pendientes,
 * o ranking final si no quedan BO3 pendientes jugables.
 */

export type PodiumPlayer = {
  participantId: string;
  userId: string;
  name: string;
  avatarUserId: string;
  bo3Won: number;
  bo3Completed: number;
  bo3WinRate: number;
  matchesWon: number;
  matchesCompleted: number;
  matchWinRate: number;
};

export type PodiumStep = {
  rank: 1 | 2 | 3;
  players: PodiumPlayer[];
  topPlayerOnStool: string | null;
};

export type PodiumState = {
  steps: PodiumStep[];
  spectators: PodiumPlayer[];
  isFinal: boolean;
};

export type PairingRemain = {
  participantAId: string;
  participantBId: string;
  isBlocked: boolean;
};

function emptyStep(rank: 1 | 2 | 3): PodiumStep {
  return { rank, players: [], topPlayerOnStool: null };
}

function eligibilityThreshold(totalPlayers: number): number {
  return Math.ceil((2 * Math.max(0, totalPlayers - 1)) / 3);
}

function pendingUnblockedFor(r: PairingRemain[], participantId: string): number {
  return r.filter(
    (x) => !x.isBlocked && (x.participantAId === participantId || x.participantBId === participantId)
  ).length;
}

function hasUnblockedPending(r: PairingRemain[]): boolean {
  return r.some((x) => !x.isBlocked);
}

function bo3Bounds(p: PodiumPlayer, pending: number): { wrMin: number; wrMax: number; completedMin: number } {
  const denom = p.bo3Completed + pending;
  if (denom <= 0) return { wrMin: 0, wrMax: 0, completedMin: 0 };
  return {
    wrMin: p.bo3Won / denom,
    wrMax: (p.bo3Won + pending) / denom,
    completedMin: denom,
  };
}

/** wP/(cP+pP) > (wQ+qQ)/(cQ+qQ) */
function minWrStrictlyGreaterThanMaxWr(
  p: PodiumPlayer,
  pendP: number,
  q: PodiumPlayer,
  pendQ: number
): boolean {
  const cP = p.bo3Completed + pendP;
  const cQ = q.bo3Completed + pendQ;
  if (cP <= 0) return false;
  const wP = p.bo3Won;
  const wQplus = q.bo3Won + pendQ;
  return wP * cQ > wQplus * cP;
}

function findUniqueSecureLeader(pool: PodiumPlayer[], totalPlayers: number, remaining: PairingRemain[]): PodiumPlayer | null {
  const thr = eligibilityThreshold(totalPlayers);
  let found: PodiumPlayer | null = null;
  for (const p of pool) {
    const pendP = pendingUnblockedFor(remaining, p.participantId);
    const bp = bo3Bounds(p, pendP);
    if (bp.completedMin < thr) continue;

    let ok = true;
    for (const q of pool) {
      if (q.participantId === p.participantId) continue;
      const pendQ = pendingUnblockedFor(remaining, q.participantId);
      if (!minWrStrictlyGreaterThanMaxWr(p, pendP, q, pendQ)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (found) return null;
    found = p;
  }
  return found;
}

/** Comparar w1/c1 vs w2/c2 (+1 primero mayor, -1 segundo, 0 iguales) */
function cmpRational(w1: number, c1: number, w2: number, c2: number): number {
  return w1 * c2 - w2 * c1;
}

function cmpBo3Actual(a: PodiumPlayer, b: PodiumPlayer): number {
  const ca = a.bo3Completed;
  const cb = b.bo3Completed;
  if (ca <= 0 && cb <= 0) return 0;
  if (ca <= 0) return -1;
  if (cb <= 0) return 1;
  return cmpRational(a.bo3Won, ca, b.bo3Won, cb);
}

function sameRationalBo3(a: PodiumPlayer, b: PodiumPlayer): boolean {
  return cmpBo3Actual(a, b) === 0 && cmpBo3Actual(b, a) === 0;
}

/** Todos los del pool con máximo win rate oficial actual (rationals). */
function topBo3RationalTier(pool: PodiumPlayer[]): PodiumPlayer[] {
  if (pool.length === 0) return [];
  let ref = pool[0]!;
  for (const p of pool) if (cmpBo3Actual(p, ref) > 0) ref = p;
  return pool.filter((p) => cmpBo3Actual(p, ref) === 0);
}

function cmpMatchActual(a: PodiumPlayer, b: PodiumPlayer): number {
  const ca = a.matchesCompleted;
  const cb = b.matchesCompleted;
  if (ca <= 0 && cb <= 0) return 0;
  if (ca <= 0) return -1;
  if (cb <= 0) return 1;
  return cmpRational(a.matchesWon, ca, b.matchesWon, cb);
}

function topPlayerOnStoolForStep(players: PodiumPlayer[]): string | null {
  if (players.length < 2) return null;
  const refB = players[0]!;
  for (const p of players) {
    if (!sameRationalBo3(refB, p)) return null;
  }

  let bestM = players[0]!;
  for (const p of players.slice(1)) if (cmpMatchActual(p, bestM) > 0) bestM = p;
  const tops = players.filter((p) => cmpMatchActual(p, bestM) === 0 && cmpMatchActual(bestM, p) === 0);
  return tops.length === 1 ? tops[0]!.participantId : null;
}

function buildStepsWithStools(s1: PodiumPlayer[], s2: PodiumPlayer[], s3: PodiumPlayer[]): PodiumStep[] {
  return [
    { rank: 1, players: s1, topPlayerOnStool: topPlayerOnStoolForStep(s1) },
    { rank: 2, players: s2, topPlayerOnStool: topPlayerOnStoolForStep(s2) },
    { rank: 3, players: s3, topPlayerOnStool: topPlayerOnStoolForStep(s3) },
  ];
}

/** Dos peldaños (2º y 3º) sólo por WR BO3 observado sobre `poolSeed`. */
function podiumNextTwoStepsFromPool(poolSeed: PodiumPlayer[]): {
  s2: PodiumPlayer[];
  s3: PodiumPlayer[];
  spectators: PodiumPlayer[];
} {
  let pool = [...poolSeed];
  const s2 = topBo3RationalTier(pool);
  const rm2 = new Set(s2.map((p) => p.participantId));
  pool = pool.filter((p) => !rm2.has(p.participantId));
  const s3 = topBo3RationalTier(pool);
  const rm3 = new Set(s3.map((p) => p.participantId));
  pool = pool.filter((p) => !rm3.has(p.participantId));
  return { s2, s3, spectators: pool };
}

/** Campeón fijado en el evento: 1° ese jugador; 2º–3º con datos actuales (sin proyección futura). */
function podiumDeclaredChampionMode(
  participants: PodiumPlayer[],
  champion: PodiumPlayer,
  remaining: PairingRemain[]
): PodiumState {
  const s1 = [champion];
  const poolRest = participants.filter((p) => p.participantId !== champion.participantId);
  const { s2, s3, spectators } = podiumNextTwoStepsFromPool(poolRest);
  const steps = buildStepsWithStools(s1, s2, s3);
  const allClosed = !hasUnblockedPending(remaining);
  const isFinal = allClosed && s1.length > 0 && s2.length > 0 && s3.length > 0;
  return { steps, spectators, isFinal };
}

/**
 * Estados finales cerrados sin BO3 jugables pendientes:
 * tres peldaños por mejor WR BO3 sucesivos; resto espectadores.
 */
function podiumSettledMode(participants: PodiumPlayer[], remaining: PairingRemain[]): PodiumState {
  let pool = [...participants];
  const s1 = topBo3RationalTier(pool);
  const rm1 = new Set(s1.map((p) => p.participantId));
  pool = pool.filter((p) => !rm1.has(p.participantId));
  const { s2, s3, spectators } = podiumNextTwoStepsFromPool(pool);

  const steps = buildStepsWithStools(s1, s2, s3);
  const allClosed = !hasUnblockedPending(remaining);
  const isFinal = allClosed && s1.length > 0 && s2.length > 0 && s3.length > 0;
  return { steps, spectators, isFinal };
}

/**
 * Con BO3 pendientes jugables: solo campeones "seguros" por peldaño; si no hay certeza en el 1°, podio vacío.
 */
function podiumPendingMode(participants: PodiumPlayer[], remaining: PairingRemain[], totalPlayers: number): PodiumState {
  let pool = [...participants];
  const s1: PodiumPlayer[] = [];
  const s2: PodiumPlayer[] = [];
  const s3: PodiumPlayer[] = [];

  const l1 = findUniqueSecureLeader(pool, totalPlayers, remaining);
  if (!l1) {
    return {
      steps: [emptyStep(1), emptyStep(2), emptyStep(3)],
      spectators: participants,
      isFinal: false,
    };
  }
  s1.push(l1);
  pool = pool.filter((p) => p.participantId !== l1.participantId);

  const l2 = findUniqueSecureLeader(pool, totalPlayers, remaining);
  if (!l2) {
    const steps = buildStepsWithStools(s1, [], []);
    return {
      steps: [steps[0]!, emptyStep(2), emptyStep(3)],
      spectators: pool,
      isFinal: false,
    };
  }
  s2.push(l2);
  pool = pool.filter((p) => p.participantId !== l2.participantId);

  const l3 = findUniqueSecureLeader(pool, totalPlayers, remaining);
  if (!l3) {
    const steps = buildStepsWithStools(s1, s2, []);
    return {
      steps: [steps[0]!, steps[1]!, emptyStep(3)],
      spectators: pool,
      isFinal: false,
    };
  }
  s3.push(l3);
  pool = pool.filter((p) => p.participantId !== l3.participantId);

  const steps = buildStepsWithStools(s1, s2, s3);
  const isFinal = !hasUnblockedPending(remaining) && s1.length > 0 && s2.length > 0 && s3.length > 0;
  return { steps, spectators: pool, isFinal };
}

export function computePodium(
  participants: PodiumPlayer[],
  pairingsRemaining: PairingRemain[],
  totalPlayers: number,
  championUserId?: string | null
): PodiumState {
  if (participants.length === 0) {
    return {
      steps: [emptyStep(1), emptyStep(2), emptyStep(3)],
      spectators: [],
      isFinal: false,
    };
  }

  if (championUserId != null && String(championUserId).trim() !== '') {
    const champ = participants.find((p) => p.userId === championUserId);
    if (champ) return podiumDeclaredChampionMode(participants, champ, pairingsRemaining);
  }

  if (hasUnblockedPending(pairingsRemaining)) {
    return podiumPendingMode(participants, pairingsRemaining, totalPlayers);
  }
  return podiumSettledMode(participants, pairingsRemaining);
}

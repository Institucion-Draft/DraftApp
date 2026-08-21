/**
 * Podio proyectado: campeón declarado (`champion_user_id`), campeón seguro ante BO3 pendientes,
 * o ranking final si no quedan BO3 pendientes jugables.
 */

export type PodiumPlayer = {
  participantId: string;
  userId: string;
  name: string;
  avatarUserId: string;
  memberBUserId?: string | null;
  bo3Won: number;
  bo3Completed: number;
  bo3WinRate: number;
  matchesWon: number;
  matchesCompleted: number;
  matchWinRate: number;
  /** Banquito individual (p. ej. Copa Polémica vs reconocimiento en el mismo peldaño). */
  onStool?: boolean;
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

export type ActiveTiebreakGroupPodiumInput = {
  id: string;
  group_type: 'round_robin' | 'bracket';
  round_number: number;
  champion_user_id: string | null;
  participants: { participant_id: string; user_id: string; seed: number }[];
};

/** Match de tiebreak cerrado; incluye lados del pairing para detectar placement sin campeón. */
export type TiebreakMatchPodiumInput = {
  pairing_id: string;
  participant_a_id: string;
  participant_b_id: string;
  winner_participant_id: string | null;
  ended_at: string | null;
  tiebreak_round: number | null;
};

/** Fila de event_tiebreak_bracket_matches; usada para reconstruir el podio del bracket de 4. */
export type BracketMatchPodiumInput = {
  bracket_phase: 'semi' | 'final' | 'third_place';
  participant_a_id: string;
  participant_b_id: string;
  winner_participant_id: string | null;
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

/**
 * Copa Polémica / Copa Fragmentada:
 * - Polémica (`mode === 'polemica'`): 1° unión polemica + reconocimiento, banquito solo en polemica.
 * - Fragmentada (`mode === 'fragmentada'`): 1° todos los polemica, sin banquito; recognition se ignora.
 * 2°/3° por WR BO3 del resto en ambos modos.
 */
function podiumPolemicaMode(
  participants: PodiumPlayer[],
  polemicaUserIds: string[],
  recognitionUserIds: string[],
  mode: 'polemica' | 'fragmentada'
): PodiumState {
  const polemicaSet = new Set(
    polemicaUserIds.map((uid) => String(uid).trim()).filter((u) => u.length > 0)
  );
  const seenUser = new Set<string>();
  const s1Raw: PodiumPlayer[] = [];
  const pushByUserId = (uid: string) => {
    const u = String(uid).trim();
    if (!u || seenUser.has(u)) return;
    const p = participants.find((x) => String(x.userId) === u);
    if (!p) return;
    seenUser.add(u);
    s1Raw.push(p);
  };
  for (const uid of polemicaUserIds) pushByUserId(uid);
  if (mode === 'polemica') {
    for (const uid of recognitionUserIds) pushByUserId(uid);
  }

  const s1: PodiumPlayer[] = s1Raw.map((p) => ({
    ...p,
    onStool: mode === 'polemica' && polemicaSet.has(String(p.userId).trim()),
  }));

  const onFirst = new Set(s1.map((p) => p.participantId));
  const poolRest = participants.filter((p) => !onFirst.has(p.participantId));
  const { s2, s3, spectators } = podiumNextTwoStepsFromPool(poolRest);
  const steps = buildStepsWithStools(s1, s2, s3);
  return { steps, spectators, isFinal: s1.length > 0 };
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

/** RR 3 con campeón en el grupo: 1° campeón; 2°/3° solo por partida de placement (tiebreak del round actual sin campeón). */
function podiumRoundRobinTiebreakWithChampion(
  participants: PodiumPlayer[],
  group: ActiveTiebreakGroupPodiumInput,
  tiebreakMatches: TiebreakMatchPodiumInput[],
  remaining: PairingRemain[]
): PodiumState {
  const champUid = group.champion_user_id;
  if (champUid == null || String(champUid).trim() === '') {
    return {
      steps: [emptyStep(1), emptyStep(2), emptyStep(3)],
      spectators: [],
      isFinal: false,
    };
  }
  const champPid = group.participants.find((x) => x.user_id === champUid)?.participant_id;
  const champPlayer = champPid ? participants.find((p) => p.participantId === champPid) : undefined;
  if (!champPlayer) {
    return {
      steps: [emptyStep(1), emptyStep(2), emptyStep(3)],
      spectators: [],
      isFinal: false,
    };
  }

  const roundNum = group.round_number ?? 1;
  const gPidSet = new Set(group.participants.map((x) => x.participant_id));

  const placement = tiebreakMatches.find(
    (m) =>
      m.winner_participant_id != null &&
      String(m.winner_participant_id).length > 0 &&
      (m.tiebreak_round ?? 1) === roundNum &&
      m.participant_a_id !== champPid &&
      m.participant_b_id !== champPid &&
      gPidSet.has(m.participant_a_id) &&
      gPidSet.has(m.participant_b_id)
  );

  const s1 = [champPlayer];
  let s2: PodiumPlayer[] = [];
  let s3: PodiumPlayer[] = [];
  if (placement?.winner_participant_id) {
    const w = placement.winner_participant_id;
    const loserPid =
      w === placement.participant_a_id ? placement.participant_b_id : placement.participant_a_id;
    const second = participants.find((p) => p.participantId === w);
    const third = participants.find((p) => p.participantId === loserPid);
    if (second) s2 = [second];
    if (third) s3 = [third];
  }

  const onPodium = new Set<string>([
    champPlayer.participantId,
    ...s2.map((p) => p.participantId),
    ...s3.map((p) => p.participantId),
  ]);
  const spectators = participants.filter((p) => {
    if (onPodium.has(p.participantId)) return false;
    if (gPidSet.has(p.participantId)) return false;
    return true;
  });

  const steps = buildStepsWithStools(s1, s2, s3);
  const allClosed = !hasUnblockedPending(remaining);
  const isFinal = allClosed && s1.length > 0 && s2.length > 0 && s3.length > 0;
  return { steps, spectators, isFinal };
}

/** Bracket de 4 resuelto: 1º campeón, 2º perdedor de la final, 3º ganador del 3er/4to puesto. */
function podiumBracketFinalMode(
  participants: PodiumPlayer[],
  group: ActiveTiebreakGroupPodiumInput,
  bracketMatches: BracketMatchPodiumInput[],
  remaining: PairingRemain[]
): PodiumState {
  const champUid = group.champion_user_id;
  const champPid = champUid
    ? group.participants.find((x) => x.user_id === champUid)?.participant_id ?? null
    : null;
  const champPlayer = champPid ? participants.find((p) => p.participantId === champPid) : undefined;
  if (!champPlayer) {
    return {
      steps: [emptyStep(1), emptyStep(2), emptyStep(3)],
      spectators: [],
      isFinal: false,
    };
  }

  const finalRow = bracketMatches.find((m) => m.bracket_phase === 'final');
  const thirdRow = bracketMatches.find((m) => m.bracket_phase === 'third_place');

  let s2: PodiumPlayer[] = [];
  let s3: PodiumPlayer[] = [];
  if (finalRow && finalRow.winner_participant_id) {
    const loserPid =
      finalRow.winner_participant_id === finalRow.participant_a_id
        ? finalRow.participant_b_id
        : finalRow.participant_a_id;
    const second = participants.find((p) => p.participantId === loserPid);
    if (second) s2 = [second];
  }
  if (thirdRow && thirdRow.winner_participant_id) {
    const third = participants.find((p) => p.participantId === thirdRow.winner_participant_id);
    if (third) s3 = [third];
  }

  const gPidSet = new Set(group.participants.map((x) => x.participant_id));
  const onPodium = new Set<string>([
    champPlayer.participantId,
    ...s2.map((p) => p.participantId),
    ...s3.map((p) => p.participantId),
  ]);
  const spectators = participants.filter((p) => {
    if (onPodium.has(p.participantId)) return false;
    if (gPidSet.has(p.participantId)) return false;
    return true;
  });

  const steps = buildStepsWithStools([champPlayer], s2, s3);
  const allClosed = !hasUnblockedPending(remaining);
  const isFinal = allClosed && s2.length > 0 && s3.length > 0;
  return { steps, spectators, isFinal };
}

// ── round_robin_bo1_top4: ranking de la fase regular (todos contra todos, BO1) ─────────────
//
// El bracket de top 4 se arma únicamente cuando el torneo terminó al 100% (0 pairings sin
// resolver) — sin proyecciones de "quién puede llegar todavía". `rankRoundRobinBo1Standings`
// calcula el orden completo de la tabla con desempates deterministas; el caller toma los
// primeros 4 y se los pasa ya ordenados al RPC que arma el bracket.

export type RoundRobinStandingInput = {
  participantId: string;
  /** Victorias en la fase regular (pairings oficiales ganados). */
  wins: number;
};

export type RoundRobinPairingResult = {
  participantAId: string;
  participantBId: string;
  winnerParticipantId: string | null;
};

/** Hash determinista y estable de un string (djb2-like). Solo para desempate de último recurso. */
function stableHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

/** Victorias de `pid` contra rivales que están dentro de `groupSet` (subtabla del grupo empatado). */
function intraGroupWins(pid: string, groupSet: Set<string>, pairings: RoundRobinPairingResult[]): number {
  let wins = 0;
  for (const pr of pairings) {
    if (pr.winnerParticipantId !== pid) continue;
    const opponent =
      pr.participantAId === pid ? pr.participantBId : pr.participantBId === pid ? pr.participantAId : null;
    if (opponent != null && groupSet.has(opponent)) wins++;
  }
  return wins;
}

/**
 * Suma de victorias totales (en todo el torneo) de los rivales a los que `pid` le ganó,
 * excluyendo rivales que están en `excludeSet` (el propio ciclo empatado sin orden directo).
 */
function qualityOfRivals(
  pid: string,
  excludeSet: Set<string>,
  pairings: RoundRobinPairingResult[],
  totalWinsMap: Map<string, number>
): number {
  let quality = 0;
  for (const pr of pairings) {
    if (pr.winnerParticipantId !== pid) continue;
    const opponent =
      pr.participantAId === pid ? pr.participantBId : pr.participantBId === pid ? pr.participantAId : null;
    if (opponent != null && !excludeSet.has(opponent)) {
      quality += totalWinsMap.get(opponent) ?? 0;
    }
  }
  return quality;
}

/**
 * Ordena un grupo de jugadores empatados en victorias totales.
 * 1) Sub-tabla interna del grupo (head-to-head): quien le ganó más veces a otros del grupo
 *    va arriba. Con 2 empatados esto es exactamente "quien le ganó al otro va arriba".
 * 2) Si el head-to-head no diferencia a todo el grupo (ciclo tipo A>B>C>A), esos jugadores
 *    quedan con el mismo registro interno: se desempatan por "calidad de rivales" (victorias
 *    totales de los rivales a los que le ganaron, excluyendo al propio ciclo).
 * 3) Si todavía empatan, orden determinista por hash estable del participantId.
 */
function resolveTieGroup(
  group: string[],
  pairings: RoundRobinPairingResult[],
  totalWinsMap: Map<string, number>
): string[] {
  if (group.length <= 1) return group;

  const groupSet = new Set(group);
  const buckets = new Map<number, string[]>();
  for (const pid of group) {
    const iw = intraGroupWins(pid, groupSet, pairings);
    if (!buckets.has(iw)) buckets.set(iw, []);
    buckets.get(iw)!.push(pid);
  }

  const orderedKeys = [...buckets.keys()].sort((a, b) => b - a);
  const result: string[] = [];
  for (const key of orderedKeys) {
    const bucket = buckets.get(key)!;
    if (bucket.length === 1) {
      result.push(bucket[0]!);
    } else if (bucket.length === group.length) {
      // El head-to-head no diferenció a nadie del grupo: ciclo. Calidad de rivales.
      const bucketSet = new Set(bucket);
      const withQuality = bucket.map((pid) => ({
        pid,
        quality: qualityOfRivals(pid, bucketSet, pairings, totalWinsMap),
        hash: stableHash(pid),
      }));
      withQuality.sort((a, b) => (b.quality !== a.quality ? b.quality - a.quality : a.hash - b.hash));
      result.push(...withQuality.map((x) => x.pid));
    } else {
      // Progreso parcial: recursar sobre el subgrupo aún empatado.
      result.push(...resolveTieGroup(bucket, pairings, totalWinsMap));
    }
  }
  return result;
}

/**
 * Ranking completo de la fase regular round_robin_bo1_top4, mejor primero.
 * Solo tiene sentido llamarla con el torneo 100% resuelto (sin pairings pendientes):
 * el desempate por head-to-head asume que cada par de empatados ya jugó su cruce directo.
 */
export function rankRoundRobinBo1Standings(
  participants: RoundRobinStandingInput[],
  pairings: RoundRobinPairingResult[]
): string[] {
  const totalWinsMap = new Map<string, number>();
  for (const p of participants) totalWinsMap.set(p.participantId, p.wins);

  const byWins = new Map<number, string[]>();
  for (const p of participants) {
    if (!byWins.has(p.wins)) byWins.set(p.wins, []);
    byWins.get(p.wins)!.push(p.participantId);
  }

  const ranked: string[] = [];
  for (const w of [...byWins.keys()].sort((a, b) => b - a)) {
    ranked.push(...resolveTieGroup(byWins.get(w)!, pairings, totalWinsMap));
  }
  return ranked;
}

export function computePodium(
  participants: PodiumPlayer[],
  pairingsRemaining: PairingRemain[],
  totalPlayers: number,
  championUserId?: string | null,
  activeTiebreakGroup?: ActiveTiebreakGroupPodiumInput | null,
  tiebreakMatches?: TiebreakMatchPodiumInput[] | null,
  championDecidedBy?: string | null,
  polemicaWinners?: string[] | null,
  recognitionWinners?: string[] | null,
  bracketMatches?: BracketMatchPodiumInput[] | null,
  competitionFormat?: string | null
): PodiumState {
  // round_robin_bo1_top4: el único podio válido sale del bracket (podiumBracketFinalMode).
  // Sin bracket creado todavía, podio vacío — nunca proyectar desde la tabla BO1 (ni
  // podiumPendingMode, podiumSettledMode, ni campeón declarado aplican a este formato).
  if (competitionFormat === 'round_robin_bo1_top4' && activeTiebreakGroup == null) {
    return {
      steps: [emptyStep(1), emptyStep(2), emptyStep(3)],
      spectators: participants,
      isFinal: false,
    };
  }

  if (participants.length === 0) {
    return {
      steps: [emptyStep(1), emptyStep(2), emptyStep(3)],
      spectators: [],
      isFinal: false,
    };
  }

  const polemicaIds = polemicaWinners ?? [];
  if (
    (championDecidedBy === 'polemica' || championDecidedBy === 'fragmentada') &&
    polemicaIds.length > 0
  ) {
    return podiumPolemicaMode(
      participants,
      polemicaIds,
      recognitionWinners ?? [],
      championDecidedBy === 'fragmentada' ? 'fragmentada' : 'polemica'
    );
  }

  if (activeTiebreakGroup != null) {
    const gChamp = activeTiebreakGroup.champion_user_id;
    const noGroupChampion = gChamp == null || String(gChamp).trim() === '';
    if (activeTiebreakGroup.group_type === 'bracket') {
      if (noGroupChampion) {
        return {
          steps: [emptyStep(1), emptyStep(2), emptyStep(3)],
          spectators: [],
          isFinal: false,
        };
      }
      return podiumBracketFinalMode(
        participants,
        activeTiebreakGroup,
        bracketMatches ?? [],
        pairingsRemaining
      );
    } else {
      if (noGroupChampion) {
        return {
          steps: [emptyStep(1), emptyStep(2), emptyStep(3)],
          spectators: [],
          isFinal: false,
        };
      }
      if (activeTiebreakGroup.group_type === 'round_robin') {
        return podiumRoundRobinTiebreakWithChampion(
          participants,
          activeTiebreakGroup,
          tiebreakMatches ?? [],
          pairingsRemaining
        );
      }
    }
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

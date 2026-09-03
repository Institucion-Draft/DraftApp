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
  group_type: 'round_robin' | 'bracket' | 'fourth_place';
  round_number: number;
  champion_user_id: string | null;
  /**
   * Solo relevante cuando group_type='fourth_place': distingue el desempate real de 4to
   * puesto de round_robin_bo1_top4 ('round_robin_fourth_place', el podio sigue vacío hasta
   * que exista el bracket real de top4) del desempate de 1er puesto de round_robin BO3
   * clásico ('round_robin_first_place', ver podiumFirstPlaceTiebreakResolvedMode).
   */
  group_origin?: string | null;
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

/**
 * Desempate de 1er puesto de round_robin BO3 clásico ya resuelto (group_type='fourth_place',
 * group_origin='round_robin_first_place' — mismo bracket 2/3/4 con bye que ya arma
 * computeFourthPlaceTiebreakBracket para el 4to puesto de round_robin_bo1_top4, ver más abajo,
 * pero acá el ganador de la fase 'final' ES el campeón del evento, no un avance de fase).
 *
 * A diferencia del bracket de 4 "real" (podiumBracketFinalMode), esta estructura NO tiene fase
 * 'third_place'. Regla general de "todos contra todos sin top" con desempate: 1° y 2° puesto
 * siempre son únicos (salen de la final del desempate); desde el 3er puesto en adelante se
 * COMPARTE el escalón entre todos los que tengan los mismos puntos originales de la fase
 * regular, sin importar en qué instancia del desempate (semi, o ninguna si no llegaron a jugar
 * nada) hayan quedado. Por tamaño de grupo:
 * - 2: el único partido (fase 'final') define 1° y 2°; 3° sale del resto del campo (fallback genérico,
 *   no hay nadie más del grupo empatado para compartir ese escalón).
 * - 3: la fase 'final' define 2°; el perdedor de la única 'semi' es 3° — único (no hay nadie más
 *   con quien compartir el escalón, es la sola persona en esa situación).
 * - 4: la fase 'final' define 2°; los 2 perdedores de semi nunca jugaron entre sí y NO se
 *   desempatan entre ellos — ambos comparten el 3er puesto (co-terceros), ya que los dos partían
 *   con los mismos puntos originales y ninguno avanzó más que el otro.
 */
function podiumFirstPlaceTiebreakResolvedMode(
  participants: PodiumPlayer[],
  champion: PodiumPlayer,
  group: ActiveTiebreakGroupPodiumInput,
  bracketMatches: BracketMatchPodiumInput[],
  remaining: PairingRemain[]
): PodiumState {
  const finalRow = bracketMatches.find((m) => m.bracket_phase === 'final');
  const semiRows = bracketMatches.filter((m) => m.bracket_phase === 'semi');

  let s2: PodiumPlayer[] = [];
  let s3: PodiumPlayer[] = [];
  const decidedPids = new Set<string>([champion.participantId]);

  if (finalRow && finalRow.winner_participant_id) {
    const loserPid =
      finalRow.winner_participant_id === finalRow.participant_a_id
        ? finalRow.participant_b_id
        : finalRow.participant_a_id;
    const second = participants.find((p) => p.participantId === loserPid);
    if (second) {
      s2 = [second];
      decidedPids.add(second.participantId);
    }
  }

  if (semiRows.length === 1) {
    const semi = semiRows[0]!;
    if (semi.winner_participant_id) {
      const loserPid =
        semi.winner_participant_id === semi.participant_a_id ? semi.participant_b_id : semi.participant_a_id;
      const third = participants.find((p) => p.participantId === loserPid);
      if (third) {
        s3 = [third];
        decidedPids.add(third.participantId);
      }
    }
  } else if (semiRows.length === 2) {
    const semiLoserPids = semiRows
      .filter((m) => m.winner_participant_id != null)
      .map((m) => (m.winner_participant_id === m.participant_a_id ? m.participant_b_id : m.participant_a_id));
    if (semiLoserPids.length === 2) {
      // Los 2 perdedores de semi nunca jugaron entre sí y partían con los mismos puntos
      // originales de tanda1 — comparten el 3er puesto (co-terceros), no se desempatan.
      const losers = semiLoserPids
        .map((pid) => participants.find((p) => p.participantId === pid))
        .filter((p): p is PodiumPlayer => p != null);
      if (losers.length === 2) {
        s3 = losers;
        for (const p of losers) decidedPids.add(p.participantId);
      }
    }
  }

  // Grupo de 2 (sin fase 'semi'): el 3er puesto no lo decide este grupo — se completa con el
  // mismo criterio genérico que un campeón declarado sin desempate (mejor WR BO3 del resto).
  if (s2.length === 0 || s3.length === 0) {
    // podiumNextTwoStepsFromPool asume que el pool arranca en el 2do puesto (su propio s2 =
    // 1ra tanda del pool). Si el 2do puesto YA está resuelto (grupo de 2: final sin semis), el
    // pool en realidad arranca en el 3er puesto — la 1ra tanda del pool (filled.s2) es el 3er
    // puesto real, no filled.s3 (que sería un 4to escalón que este podio de 3 pasos no representa).
    const s2AlreadyDecided = s2.length > 0;
    const poolRest = participants.filter((p) => !decidedPids.has(p.participantId));
    const filled = podiumNextTwoStepsFromPool(poolRest);
    if (s2.length === 0) s2 = filled.s2;
    if (s3.length === 0) {
      const thirdPlaceTier = s2AlreadyDecided ? filled.s2 : filled.s3;
      s3 = thirdPlaceTier.filter((p) => !s2.some((x) => x.participantId === p.participantId));
    }
  }

  const onPodium = new Set<string>([
    champion.participantId,
    ...s2.map((p) => p.participantId),
    ...s3.map((p) => p.participantId),
  ]);
  const spectators = participants.filter((p) => !onPodium.has(p.participantId));

  const steps = buildStepsWithStools([champion], s2, s3);
  const isFinal = !hasUnblockedPending(remaining) && s2.length > 0 && s3.length > 0;
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
  /**
   * Puntos totales en la fase regular, ya calculados por quien arma este input según el
   * sistema de puntos del formato en uso (podium.ts no conoce esa regla): BO1/BO3 = 1 por
   * pairing ganado y 0 por perdido; BO2 = 3 por pairing ganado, 1 por empate, 0 por perdido.
   */
  points: number;
  /** Si está seteado, el participante se excluye del cálculo de standings/desempate. */
  leftEventAt?: string | null;
};

export type RoundRobinPairingResult = {
  participantAId: string;
  participantBId: string;
  winnerParticipantId: string | null;
  /**
   * true si el pairing terminó en empate real (p. ej. BO2 1-1): resuelto, pero sin ganador.
   * false/undefined con winnerParticipantId null sigue significando "todavía sin jugar"
   * (comportamiento actual sin cambios).
   */
  isDraw?: boolean;
  /**
   * Puntos que este pairing le otorgó a cada lado, según el sistema de puntos de quien arma
   * este resultado (BO2: 3/1/0 según gane/empate/pierda; BO1/BO3: 1/0). Si se omiten, se
   * asume 1 para quien ganó y 0 para el resto — el comportamiento BO1 de siempre. podium.ts
   * no decide estos valores, solo los suma.
   */
  pointsA?: number;
  pointsB?: number;
};

/** Hash determinista y estable de un string (djb2-like). Solo para desempate de último recurso. */
function stableHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * Puntos que un pairing (ganado o empatado) le otorgó a `pid`. Usa pointsA/pointsB si quien
 * armó el pairing los proveyó (su propio sistema de puntos); si no, 1 para quien ganó y 0
 * para el resto — el comportamiento BO1 de siempre. podium.ts no decide estos valores, solo
 * los suma.
 */
function pointsAwardedTo(pr: RoundRobinPairingResult, pid: string): number {
  const isA = pr.participantAId === pid;
  const isB = pr.participantBId === pid;
  if (!isA && !isB) return 0;
  if (pr.winnerParticipantId === pid) return isA ? (pr.pointsA ?? 1) : (pr.pointsB ?? 1);
  if (pr.winnerParticipantId == null && pr.isDraw) return isA ? (pr.pointsA ?? 0) : (pr.pointsB ?? 0);
  return 0;
}

/** Puntos de `pid` en pairings contra rivales que están dentro de `groupSet` (subtabla del grupo empatado). */
function intraGroupPoints(pid: string, groupSet: Set<string>, pairings: RoundRobinPairingResult[]): number {
  let points = 0;
  for (const pr of pairings) {
    const isPidA = pr.participantAId === pid;
    const isPidB = pr.participantBId === pid;
    if (!isPidA && !isPidB) continue;
    const opponent = isPidA ? pr.participantBId : pr.participantAId;
    if (!groupSet.has(opponent)) continue;
    points += pointsAwardedTo(pr, pid);
  }
  return points;
}

const GAME_WINRATE_EPSILON = 1e-9;

/** Agrupa `pids` en tiers por `gameWinrateMap`, orden descendente, con tolerancia de punto flotante. */
function tierByGameWinrate(pids: string[], gameWinrateMap: Map<string, number>): string[][] {
  const withWr = pids
    .map((pid) => ({ pid, wr: gameWinrateMap.get(pid) ?? 0 }))
    .sort((a, b) => b.wr - a.wr);
  const tiers: string[][] = [];
  for (const { pid, wr } of withWr) {
    const lastTier = tiers[tiers.length - 1];
    const lastWr = lastTier ? gameWinrateMap.get(lastTier[0]!) ?? 0 : null;
    if (lastTier && lastWr != null && Math.abs(lastWr - wr) < GAME_WINRATE_EPSILON) {
      lastTier.push(pid);
    } else {
      tiers.push([pid]);
    }
  }
  return tiers;
}

/**
 * Suma de puntos totales (en todo el torneo) de los rivales a los que `pid` le ganó,
 * excluyendo rivales que están en `excludeSet` (el propio ciclo empatado sin orden directo).
 */
function qualityOfRivals(
  pid: string,
  excludeSet: Set<string>,
  pairings: RoundRobinPairingResult[],
  totalPointsMap: Map<string, number>
): number {
  let quality = 0;
  for (const pr of pairings) {
    if (pr.winnerParticipantId !== pid) continue;
    const opponent =
      pr.participantAId === pid ? pr.participantBId : pr.participantBId === pid ? pr.participantAId : null;
    if (opponent != null && !excludeSet.has(opponent)) {
      quality += totalPointsMap.get(opponent) ?? 0;
    }
  }
  return quality;
}

/**
 * Ordena un grupo de jugadores empatados en puntos totales.
 * 1) Sub-tabla interna del grupo (head-to-head): quien sumó más puntos contra otros del
 *    grupo va arriba. Con 2 empatados esto es "quien le ganó al otro va arriba" (BO1/BO3) o
 *    el resultado directo entre ambos si hubo empate (BO2).
 * 2) Si el head-to-head no diferencia a todo el grupo (ciclo tipo A>B>C>A) y se proveyó
 *    `gameWinrateMap` (solo BO3), se subdivide primero por ese winrate de partidas
 *    individuales — mayor winrate va arriba; recién si el winrate también empata (o no fue
 *    provisto) se sigue al criterio siguiente.
 * 3) Dentro de cada sub-tier de winrate (o del grupo entero si no hay `gameWinrateMap`): se
 *    elige solo al primero por "calidad de rivales" (puntos totales de los rivales a los que
 *    le ganó, excluyendo al propio ciclo; hash estable como desempate final), y se recursa
 *    sobre el resto de ese tier — así su resultado directo entre ellos (parte del ciclo
 *    original) decide el orden interno, en vez de volver a comparar calidad de rivales.
 * 4) Si todavía empatan, orden determinista por hash estable del participantId.
 *
 * Además del orden, devuelve `arbitrary`: el set de participantIds que en algún nivel de la
 * recursión terminaron desempatados por `stableHash` porque ni el head-to-head, ni el game
 * winrate (si se proveyó), ni la calidad de rivales los distinguieron. Un participante
 * resuelto por head-to-head real, por game winrate, o por una calidad de rivales estrictamente
 * mayor a la del resto, NUNCA entra en este set.
 */
function resolveTieGroup(
  group: string[],
  pairings: RoundRobinPairingResult[],
  totalPointsMap: Map<string, number>,
  gameWinrateMap?: Map<string, number>
): { order: string[]; arbitrary: Set<string> } {
  if (group.length <= 1) return { order: group, arbitrary: new Set() };

  const groupSet = new Set(group);
  const buckets = new Map<number, string[]>();
  for (const pid of group) {
    const iw = intraGroupPoints(pid, groupSet, pairings);
    if (!buckets.has(iw)) buckets.set(iw, []);
    buckets.get(iw)!.push(pid);
  }

  const orderedKeys = [...buckets.keys()].sort((a, b) => b - a);
  const order: string[] = [];
  const arbitrary = new Set<string>();
  for (const key of orderedKeys) {
    const bucket = buckets.get(key)!;
    if (bucket.length === 1) {
      order.push(bucket[0]!);
    } else if (bucket.length === group.length) {
      // El head-to-head no diferenció a nadie del grupo: ciclo. Sin gameWinrateMap, un único
      // tier con todo el bucket reproduce el comportamiento de siempre. Con gameWinrateMap
      // (BO3), primero se subdivide por winrate de partidas individuales.
      const bucketSet = new Set(bucket);
      const tiers = gameWinrateMap ? tierByGameWinrate(bucket, gameWinrateMap) : [bucket];

      for (const tier of tiers) {
        if (tier.length === 1) {
          // Un único integrante en este tier de winrate: lo decidió ese criterio, no es arbitrario.
          order.push(tier[0]!);
          continue;
        }
        // Elegir solo al primero por calidad de rivales (hash como desempate), y recursar
        // sobre el resto del tier: así el resultado directo entre ellos decide su orden, no
        // una nueva comparación de calidad de rivales sobre todo el tier.
        const withQuality = tier.map((pid) => ({
          pid,
          quality: qualityOfRivals(pid, bucketSet, pairings, totalPointsMap),
          hash: stableHash(pid),
        }));
        const maxQuality = Math.max(...withQuality.map((x) => x.quality));
        const topCandidates = withQuality.filter((x) => x.quality === maxQuality);
        withQuality.sort((a, b) => (b.quality !== a.quality ? b.quality - a.quality : a.hash - b.hash));
        const chosen = withQuality[0]!.pid;
        // Solo es arbitrario si la calidad de rivales tampoco distinguió un único candidato top
        // (tuvo que decidir el hash entre 2+ con la misma calidad máxima).
        if (topCandidates.length > 1) arbitrary.add(chosen);
        order.push(chosen);
        const rest = tier.filter((pid) => pid !== chosen);
        const sub = resolveTieGroup(rest, pairings, totalPointsMap, gameWinrateMap);
        order.push(...sub.order);
        for (const pid of sub.arbitrary) arbitrary.add(pid);
      }
    } else {
      // Progreso parcial: recursar sobre el subgrupo aún empatado.
      const sub = resolveTieGroup(bucket, pairings, totalPointsMap, gameWinrateMap);
      order.push(...sub.order);
      for (const pid of sub.arbitrary) arbitrary.add(pid);
    }
  }
  return { order, arbitrary };
}

/** Igual que `rankRoundRobinBo1Standings`, pero además expone qué participantIds quedaron
 *  resueltos arbitrariamente por hash en algún nivel de `resolveTieGroup`. */
function rankWithArbitraryInfo(
  participants: RoundRobinStandingInput[],
  pairings: RoundRobinPairingResult[],
  gameWinrateMap?: Map<string, number>
): { order: string[]; arbitrary: Set<string> } {
  const totalPointsMap = new Map<string, number>();
  for (const p of participants) totalPointsMap.set(p.participantId, p.points);

  const byPoints = new Map<number, string[]>();
  for (const p of participants) {
    if (!byPoints.has(p.points)) byPoints.set(p.points, []);
    byPoints.get(p.points)!.push(p.participantId);
  }

  const order: string[] = [];
  const arbitrary = new Set<string>();
  for (const pts of [...byPoints.keys()].sort((a, b) => b - a)) {
    const sub = resolveTieGroup(byPoints.get(pts)!, pairings, totalPointsMap, gameWinrateMap);
    order.push(...sub.order);
    for (const pid of sub.arbitrary) arbitrary.add(pid);
  }
  return { order, arbitrary };
}

/**
 * Ranking completo de la fase regular round_robin_bo1_top4, mejor primero.
 * Solo tiene sentido llamarla con el torneo 100% resuelto (sin pairings pendientes):
 * el desempate por head-to-head asume que cada par de empatados ya jugó su cruce directo.
 */
export function rankRoundRobinBo1Standings(
  participants: RoundRobinStandingInput[],
  pairings: RoundRobinPairingResult[],
  gameWinrateMap?: Map<string, number>
): string[] {
  return rankWithArbitraryInfo(participants, pairings, gameWinrateMap).order;
}

export type FinalStandingsWithTiebreakSplit = {
  /** Orden completo de la tanda 1 (desempate olímpico → [game winrate] → calidad de rivales → hash), sin left_event_at. */
  standings: string[];
  /**
   * IDs en disputa por la frontera de `cutoffPosition` (0-based; default 3 = 4to puesto):
   * participantes con exactamente los mismos puntos que el de esa posición que además cumplen
   * alguna de estas dos condiciones:
   * - están en esa posición o más abajo, o
   * - fueron resueltos arbitrariamente por hash en algún punto de tanda 1 (aunque hayan quedado
   *   arriba del corte) — un empate que tanda 1 solo pudo "adivinar" no le regala el puesto alto,
   *   se juega en tanda 2.
   * Vacío si no queda más de 1 participante cumpliendo lo anterior (corte ya resuelto con
   * evidencia real). Mismo array que `cutoffTieGroup` — se mantiene por compatibilidad con
   * callers existentes (EventDetailScreen.tsx) que ya destructuran este nombre.
   */
  fourthPlaceTieGroup: string[];
  /** Generalización de `fourthPlaceTieGroup` para un `cutoffPosition` arbitrario (mismo array). */
  cutoffTieGroup: string[];
};

/**
 * Ranking en dos tandas para formatos round-robin con una frontera de corte (top4 de
 * round_robin_bo1_top4 por default; `cutoffPosition` generaliza a cualquier frontera 0-based):
 * - Tanda 1: orden total de TODOS los participantes activos (excluye left_event_at), reutilizando
 *   la misma lógica que `rankRoundRobinBo1Standings` — sin decidir todavía quién entra al corte.
 * - Tanda 2: a partir de ese orden, detecta si hay empate exacto en puntos en `cutoffPosition`
 *   en adelante, sumando también a cualquiera que tanda 1 haya resuelto arbitrariamente por
 *   hash (ver `resolveTieGroup`).
 *
 * `gameWinrateMap` (solo BO3) se reenvía tal cual a `resolveTieGroup`.
 */
export function computeFinalStandingsWithTiebreakSplit(
  participants: RoundRobinStandingInput[],
  pairings: RoundRobinPairingResult[],
  cutoffPosition: number = 3,
  gameWinrateMap?: Map<string, number>
): FinalStandingsWithTiebreakSplit {
  const eligible = participants.filter((p) => !p.leftEventAt);
  const { order: standings, arbitrary } = rankWithArbitraryInfo(eligible, pairings, gameWinrateMap);

  if (standings.length <= cutoffPosition) {
    return { standings, fourthPlaceTieGroup: [], cutoffTieGroup: [] };
  }

  const pointsById = new Map<string, number>();
  for (const p of eligible) pointsById.set(p.participantId, p.points);

  const cutoffPoints = pointsById.get(standings[cutoffPosition]!) ?? 0;
  const tiedFromCutoff = standings.filter((pid, idx) => {
    if ((pointsById.get(pid) ?? 0) !== cutoffPoints) return false;
    return idx >= cutoffPosition || arbitrary.has(pid);
  });

  const cutoffTieGroup = tiedFromCutoff.length > 1 ? tiedFromCutoff : [];
  return { standings, fourthPlaceTieGroup: cutoffTieGroup, cutoffTieGroup };
}

/** Un slot de partido: participante fijo, o el ganador de otro partido del propio bracket de desempate. */
export type FourthPlaceTiebreakSlot = { participantId: string } | { winnerOfMatch: number };

export type FourthPlaceTiebreakMatch = {
  round: number;
  a: FourthPlaceTiebreakSlot;
  b: FourthPlaceTiebreakSlot;
  /** 'final_4th': el ganador de este partido es el 4to puesto. Number: índice del próximo match en `matches`. */
  winnerAdvancesTo: 'final_4th' | number;
};

export type FourthPlaceTiebreakBracket = {
  /** Seteado solo si se resuelve sin partidos (grupo de 5+: el mejor ordenado queda 4to directo). */
  fourthPlaceParticipantId: string | null;
  matches: FourthPlaceTiebreakMatch[];
};

/**
 * Arma el bracket de desempate por la frontera de corte (4to puesto por default) a partir del
 * grupo empatado ya detectado por `computeFinalStandingsWithTiebreakSplit`. Pura lógica de
 * cálculo — no toca DB ni RPCs.
 *
 * Orden interno del grupo empatado (mismos criterios que `resolveTieGroup`, reutilizada tal cual):
 * 1) Puntos dentro del grupo (head-to-head contra los otros integrantes).
 * 2) Si empata y hay `gameWinrateMap` (BO3): winrate de partidas individuales.
 * 3) Si aún empata: calidad de rivales (puntos totales de a quiénes venció, excluyendo rivales
 *    que están dentro del propio grupo).
 * 4) Si aún empata: hash determinístico por participantId.
 *
 * Con ese orden, según el tamaño del grupo:
 * - 2: un BO1 entre ambos, el ganador es el 4to puesto.
 * - 3: el 1° tiene bye; BO1 entre 2° y 3°; el ganador juega BO1 contra el 1°; ese ganador es el 4to puesto.
 * - 4: BO1 entre 1°-4° y BO1 entre 2°-3° (en paralelo); los ganadores juegan BO1 entre sí por el 4to puesto.
 * - 5+: el 1° ordenado queda 4to puesto directo, sin partidos; el resto no pasa al top4.
 */
export function computeFourthPlaceTiebreakBracket(
  tieGroup: string[],
  pairings: RoundRobinPairingResult[],
  gameWinrateMap?: Map<string, number>
): FourthPlaceTiebreakBracket {
  if (tieGroup.length <= 1) {
    return { fourthPlaceParticipantId: tieGroup[0] ?? null, matches: [] };
  }

  const totalPointsMap = new Map<string, number>();
  for (const pr of pairings) {
    totalPointsMap.set(
      pr.participantAId,
      (totalPointsMap.get(pr.participantAId) ?? 0) + pointsAwardedTo(pr, pr.participantAId)
    );
    totalPointsMap.set(
      pr.participantBId,
      (totalPointsMap.get(pr.participantBId) ?? 0) + pointsAwardedTo(pr, pr.participantBId)
    );
  }
  const ordered = resolveTieGroup(tieGroup, pairings, totalPointsMap, gameWinrateMap).order;

  if (ordered.length >= 5) {
    return { fourthPlaceParticipantId: ordered[0]!, matches: [] };
  }

  if (ordered.length === 2) {
    const matches: FourthPlaceTiebreakMatch[] = [
      { round: 1, a: { participantId: ordered[0]! }, b: { participantId: ordered[1]! }, winnerAdvancesTo: 'final_4th' },
    ];
    return { fourthPlaceParticipantId: null, matches };
  }

  if (ordered.length === 3) {
    const matches: FourthPlaceTiebreakMatch[] = [
      { round: 1, a: { participantId: ordered[1]! }, b: { participantId: ordered[2]! }, winnerAdvancesTo: 1 },
      { round: 2, a: { winnerOfMatch: 0 }, b: { participantId: ordered[0]! }, winnerAdvancesTo: 'final_4th' },
    ];
    return { fourthPlaceParticipantId: null, matches };
  }

  // ordered.length === 4
  const matches: FourthPlaceTiebreakMatch[] = [
    { round: 1, a: { participantId: ordered[0]! }, b: { participantId: ordered[3]! }, winnerAdvancesTo: 2 },
    { round: 1, a: { participantId: ordered[1]! }, b: { participantId: ordered[2]! }, winnerAdvancesTo: 2 },
    { round: 2, a: { winnerOfMatch: 0 }, b: { winnerOfMatch: 1 }, winnerAdvancesTo: 'final_4th' },
  ];
  return { fourthPlaceParticipantId: null, matches };
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
  competitionFormat?: string | null,
  topSize?: number | null
): PodiumState {
  // round_robin + top_size=4 (antes 'round_robin_bo1_top4', ver 0076): el único podio válido
  // sale del bracket (podiumBracketFinalMode). Sin bracket creado todavía, podio vacío — nunca
  // proyectar desde la tabla BO1 (ni podiumPendingMode, podiumSettledMode, ni campeón declarado
  // aplican a este formato).
  if (competitionFormat === 'round_robin' && topSize === 4 && activeTiebreakGroup == null) {
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

  if (activeTiebreakGroup != null && activeTiebreakGroup.group_type === 'fourth_place') {
    if (activeTiebreakGroup.group_origin !== 'round_robin_first_place') {
      // 4to puesto real de round_robin_bo1_top4 (u otro futuro uso de este group_type): el
      // podio de ese formato sale únicamente del bracket real de top4
      // (group_origin='round_robin_topcut', group_type='bracket'), nunca de acá — podio vacío
      // mientras se disputa este desempate.
      return {
        steps: [emptyStep(1), emptyStep(2), emptyStep(3)],
        spectators: [],
        isFinal: false,
      };
    }
    // round_robin_first_place: el campeón del EVENTO (no del grupo — este group_type nunca
    // setea event_tiebreak_groups.champion_user_id, ver 0075) es la señal de resuelto.
    if (championUserId == null || String(championUserId).trim() === '') {
      return {
        steps: [emptyStep(1), emptyStep(2), emptyStep(3)],
        spectators: [],
        isFinal: false,
      };
    }
    const champ = participants.find((p) => p.userId === championUserId);
    if (!champ) {
      return {
        steps: [emptyStep(1), emptyStep(2), emptyStep(3)],
        spectators: [],
        isFinal: false,
      };
    }
    return podiumFirstPlaceTiebreakResolvedMode(
      participants,
      champ,
      activeTiebreakGroup,
      bracketMatches ?? [],
      pairingsRemaining
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

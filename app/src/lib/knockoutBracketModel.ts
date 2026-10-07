/**
 * Cuadro de llaves de la Copa (sólo llaves): modelo y layout puros, sin React.
 *
 * El árbol sale de knockout_slots (feeds_slot_id / feeds_as), no de un orden por seed: la final es
 * el slot 'final'; cada semifinal con todo el subárbol que la alimenta forma una mitad. 'a' (arriba)
 * va a la mitad izquierda y 'b' a la derecha, que es como el motor las conecta a la final.
 */
import type { BracketPhase } from './knockoutRounds';

export type KnockoutSlotRow = {
  id: string;
  round_key: BracketPhase;
  position: number;
  participant_a_id: string | null;
  participant_b_id: string | null;
  is_bye: boolean;
  feeds_slot_id: string | null;
  feeds_as: 'a' | 'b' | null;
  winner_participant_id: string | null;
  bracket_match_id: string | null;
};

export type KnockoutBracketMatchRow = {
  id: string;
  pairing_id: string | null;
  winner_participant_id: string | null;
};

export type KnockoutNode = {
  slotId: string;
  round: BracketPhase;
  participantAId: string | null;
  participantBId: string | null;
  isBye: boolean;
  winnerId: string | null;
  bracketMatchId: string | null;
  pairingId: string | null;
  /** Cruces que alimentan a este (ordenados: 'a' arriba, 'b' abajo). Vacío en la primera ronda. */
  children: KnockoutNode[];
};

export type KnockoutBracketModel = {
  final: KnockoutNode;
  /** Semifinal de la mitad izquierda (la que alimenta el lado 'a' de la final). */
  leftSemi: KnockoutNode;
  rightSemi: KnockoutNode;
  third: KnockoutNode | null;
};

const sideOrder = (s: KnockoutSlotRow) => (s.feeds_as === 'a' ? 0 : 1);

export function buildKnockoutBracketModel(
  slots: readonly KnockoutSlotRow[],
  bracketMatches: readonly KnockoutBracketMatchRow[]
): KnockoutBracketModel | null {
  const bmById = new Map(bracketMatches.map((b) => [b.id, b]));
  const finalSlot = slots.find((s) => s.round_key === 'final');
  if (!finalSlot) return null;

  const toNode = (s: KnockoutSlotRow): KnockoutNode => {
    const bm = s.bracket_match_id ? bmById.get(s.bracket_match_id) : undefined;
    const children = slots
      .filter((c) => c.feeds_slot_id === s.id)
      .sort((x, y) => sideOrder(x) - sideOrder(y))
      .map(toNode);
    return {
      slotId: s.id,
      round: s.round_key,
      participantAId: s.participant_a_id,
      participantBId: s.participant_b_id,
      isBye: s.is_bye,
      winnerId: s.winner_participant_id ?? bm?.winner_participant_id ?? null,
      bracketMatchId: s.bracket_match_id,
      pairingId: bm?.pairing_id ?? null,
      children,
    };
  };

  const finalNode = toNode(finalSlot);
  if (finalNode.children.length !== 2) return null;
  const thirdSlot = slots.find((s) => s.round_key === 'third_place');
  return {
    final: finalNode,
    leftSemi: finalNode.children[0]!,
    rightSemi: finalNode.children[1]!,
    third: thirdSlot ? toNode(thirdSlot) : null,
  };
}

export type KnockoutBox = {
  node: KnockoutNode;
  col: number;
  /** Centro vertical de la tarjeta dentro del cuerpo del cuadro. */
  yCenter: number;
  side: 'left' | 'right' | 'center';
};

export type KnockoutLink = {
  fromCol: number;
  fromY: number;
  toCol: number;
  toY: number;
  /** Hacia dónde se dibuja: 'left' sale por el borde derecho del hijo; 'right' por el izquierdo. */
  side: 'left' | 'right';
};

export type KnockoutLayout = {
  /** Columnas totales: 2 * niveles por mitad + 1 (la final al medio). */
  cols: number;
  /** Niveles (rondas) de cada mitad: 2 con 8 jugadores (cuartos, semi); 3 con 9 a 16. */
  levels: number;
  finalCol: number;
  boxes: KnockoutBox[];
  links: KnockoutLink[];
  thirdBox: KnockoutBox | null;
  /** Rondas de cada columna, para los encabezados (índice = columna). */
  columnRounds: BracketPhase[];
  bodyHeight: number;
};

function depthOf(n: KnockoutNode): number {
  return n.children.length === 0 ? 1 : 1 + Math.max(...n.children.map(depthOf));
}

/**
 * Posiciones del cuadro. Las hojas (primera ronda) se reparten parejo y cada cruce queda centrado
 * entre los dos que lo alimentan; la mitad derecha es el espejo de la izquierda.
 * thirdGap: separación entre el borde inferior de la final y el borde superior del 3er puesto.
 */
export function layoutKnockoutBracket(
  model: KnockoutBracketModel,
  cardH: number,
  vGap: number,
  thirdGap: number
): KnockoutLayout {
  const levels = Math.max(depthOf(model.leftSemi), depthOf(model.rightSemi));
  const cols = 2 * levels + 1;
  const finalCol = levels;
  const boxes: KnockoutBox[] = [];
  const links: KnockoutLink[] = [];
  const columnRounds: BracketPhase[] = new Array(cols);
  const pitch = cardH + vGap;

  const placeHalf = (semi: KnockoutNode, side: 'left' | 'right') => {
    let leaf = 0;
    const colOf = (depthFromSemi: number) =>
      side === 'left' ? levels - 1 - depthFromSemi : levels + 1 + depthFromSemi;
    const walk = (n: KnockoutNode, depthFromSemi: number): number => {
      const col = colOf(depthFromSemi);
      columnRounds[col] = n.round;
      let y: number;
      if (n.children.length === 0) {
        y = leaf * pitch + cardH / 2;
        leaf += 1;
      } else {
        const ys = n.children.map((c) => walk(c, depthFromSemi + 1));
        y = ys.reduce((a, b) => a + b, 0) / ys.length;
        n.children.forEach((c, i) => {
          links.push({
            fromCol: colOf(depthFromSemi + 1),
            fromY: ys[i]!,
            toCol: col,
            toY: y,
            side,
          });
        });
      }
      boxes.push({ node: n, col, yCenter: y, side });
      return y;
    };
    const y = walk(semi, 0);
    return { y, leaves: leaf };
  };

  const left = placeHalf(model.leftSemi, 'left');
  const right = placeHalf(model.rightSemi, 'right');
  const finalY = (left.y + right.y) / 2;
  columnRounds[finalCol] = 'final';
  boxes.push({ node: model.final, col: finalCol, yCenter: finalY, side: 'center' });
  links.push({ fromCol: levels - 1, fromY: left.y, toCol: finalCol, toY: finalY, side: 'left' });
  links.push({ fromCol: levels + 1, fromY: right.y, toCol: finalCol, toY: finalY, side: 'right' });

  let thirdBox: KnockoutBox | null = null;
  if (model.third) {
    thirdBox = {
      node: model.third,
      col: finalCol,
      // thirdGap = separación entre el borde inferior de la final y el superior del 3er puesto.
      yCenter: finalY + cardH + thirdGap,
      side: 'center',
    };
  }

  const halfH = Math.max(left.leaves, right.leaves) * pitch - vGap;
  const bodyHeight = Math.max(halfH, thirdBox ? thirdBox.yCenter + cardH / 2 : 0);
  return { cols, levels, finalCol, boxes, links, thirdBox, columnRounds, bodyHeight };
}

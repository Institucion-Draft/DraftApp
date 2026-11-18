// Tests de los permisos para ELIMINAR un evento cancelado (app/src/lib/eventPermissions.ts, 0164).
// node app/scripts/event-delete-permissions.test.mjs
import { canDeleteCancelledEvent, needsMatchCountForDelete, deleteEventRpcName } from '../src/lib/eventPermissions.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };

const can = (o) => canDeleteCancelledEvent({ status: 'cancelled', isOrganizer: false, canManageEvent: true, isOfficial: false, hasMatches: false, ...o });

// --- solo cancelado: en cualquier otro estado, nadie --------------------------------------------------------------------------------------
for (const st of ['scheduled', 'drafting', 'playing', 'completed', 'concluded', null, undefined, '']) {
  ok(!can({ status: st }) && !can({ status: st, isOrganizer: true }), `estado ${JSON.stringify(st)}: no se ofrece ni a la posta ni al organizador`);
}

// --- organizador del workspace: conserva lo de siempre ---------------------------------------------------------------------------------------
ok(can({ isOrganizer: true }), 'organizador, cancelado no oficial: sí');
ok(can({ isOrganizer: true, isOfficial: true, hasMatches: true }), 'organizador, cancelado oficial CON partidas: sí (solo él puede)');
ok(can({ isOrganizer: true, canManageEvent: true, isOfficial: true, hasMatches: null }), 'organizador: no depende de saber si hay partidas');

// --- la posta (gestiona sin ser organizador) -----------------------------------------------------------------------------------------------------
ok(can({ isOfficial: false, hasMatches: true }), 'posta, cancelado NO oficial (aunque tenga partidas): sí');
ok(can({ isOfficial: null, hasMatches: null }) && can({ isOfficial: undefined, hasMatches: undefined }), 'posta, is_official desconocido/vacío (no oficial): sí');
ok(can({ isOfficial: true, hasMatches: false }), 'posta, cancelado OFICIAL sin partidas: sí');
ok(!can({ isOfficial: true, hasMatches: true }), 'posta, cancelado OFICIAL con partidas: NO');
ok(!can({ isOfficial: true, hasMatches: null }) && !can({ isOfficial: true, hasMatches: undefined }), 'posta, oficial y todavía sin saber si hay partidas: NO se ofrece (el servidor decide igual)');

// --- sin permisos ---------------------------------------------------------------------------------------------------------------------------------
ok(!can({ canManageEvent: false }), 'un member sin la posta: NO');
ok(!can({ canManageEvent: false, isOfficial: false, hasMatches: false }), 'ni en un cancelado no oficial sin partidas');

// --- cuándo hace falta contar partidas -----------------------------------------------------------------------------------------------------------
const need = (o) => needsMatchCountForDelete({ status: 'cancelled', isOrganizer: false, canManageEvent: true, isOfficial: true, ...o });
ok(need({}), 'solo la posta, cancelado y oficial: hay que mirar las partidas');
ok(!need({ isOfficial: false }) && !need({ isOfficial: null }), 'no oficial: no hace falta');
ok(!need({ isOrganizer: true }), 'organizador: no hace falta');
ok(!need({ canManageEvent: false }), 'sin permisos: no hace falta');
ok(!need({ status: 'scheduled' }) && !need({ status: 'playing' }), 'no cancelado: no hace falta');

// --- qué RPC usa cada uno ---------------------------------------------------------------------------------------------------------------------------
ok(deleteEventRpcName(true) === 'soft_delete_event', 'el organizador sigue con soft_delete_event (sin cambios)');
ok(deleteEventRpcName(false) === 'soft_delete_cancelled_event', 'quien solo tiene la posta usa soft_delete_cancelled_event (0164)');

console.log(fails ? `\n${fails} FALLAS` : '\nTodo OK');
process.exit(fails ? 1 : 0);

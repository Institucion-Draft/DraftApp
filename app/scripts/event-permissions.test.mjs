// Tests de los permisos de evento (app/src/lib/eventPermissions.ts): la posta, la disponibilidad de cubos y el botón de tabla/cruces.
// node app/scripts/event-permissions.test.mjs
import { canManageEventGate, canEditCubeAvailability, showStandingsButton } from '../src/lib/eventPermissions.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };

// --- canManageEventGate -----------------------------------------------------------------------------------------------------------
ok(canManageEventGate({ workspaceRole: 'organizer', eventOrganizerUserId: 'x', userId: 'u' }), 'organizador del workspace gestiona aunque no tenga la posta');
ok(canManageEventGate({ workspaceRole: 'member', eventOrganizerUserId: 'u', userId: 'u' }), 'member con la posta gestiona');
ok(!canManageEventGate({ workspaceRole: 'member', eventOrganizerUserId: 'x', userId: 'u' }), 'member sin la posta NO gestiona');
ok(canManageEventGate({ workspaceRole: null, eventOrganizerUserId: 'u', userId: 'u' }), 'la posta vale aunque el rol del workspace no haya cargado (null)');
ok(!canManageEventGate({ workspaceRole: 'member', eventOrganizerUserId: null, userId: 'u' }), 'evento sin posta cargada: no gestiona');
ok(!canManageEventGate({ workspaceRole: 'member', eventOrganizerUserId: 'u', userId: null }), 'sin sesión: no gestiona');
ok(!canManageEventGate({ workspaceRole: undefined, eventOrganizerUserId: undefined, userId: undefined }), 'todo undefined: no gestiona');

// --- canEditCubeAvailability (cubes UPDATE = sólo organizador del workspace) -------------------------------------------------------
ok(canEditCubeAvailability('organizer'), 'organizador edita disponibilidad de cubos');
ok(!canEditCubeAvailability('member') && !canEditCubeAvailability(null) && !canEditCubeAvailability(undefined), 'la posta / member / sin rol NO editan cubos');

// --- showStandingsButton ----------------------------------------------------------------------------------------------------------
const base = { isKnockout: false, isZonesEvent: false, zonesDrawn: false, status: 'playing', isOrganizer: false, canManageEvent: false, isWorkspaceMember: true, hasParticipantRow: false, hasDeclaredColors: false };
const ko = (o) => showStandingsButton({ ...base, isKnockout: true, ...o });

// Copa
for (const st of ['playing', 'completed', 'concluded']) {
  ok(ko({ status: st, hasParticipantRow: true }), `copa/${st}: participante SIN colores lo ve (el caso de Martín)`);
  ok(ko({ status: st }), `copa/${st}: miembro que no juega lo ve`);
  ok(ko({ status: st, isOrganizer: true, canManageEvent: true }), `copa/${st}: organizador lo ve`);
  ok(ko({ status: st, isWorkspaceMember: false, canManageEvent: true }), `copa/${st}: posta (aunque no cargue la membresía) lo ve`);
}
for (const st of ['scheduled', 'drafting', 'cancelled', null, undefined]) {
  ok(!ko({ status: st, hasParticipantRow: true, isOrganizer: true, canManageEvent: true }), `copa/${String(st)}: nadie lo ve antes de playing`);
}
ok(!ko({ isWorkspaceMember: false }), 'copa: quien no es miembro ni participante ni gestiona, no lo ve');

// Resto de formatos: condición de siempre
ok(showStandingsButton({ ...base, isOrganizer: true, status: 'scheduled' }), 'otros: organizador del workspace siempre lo ve');
ok(showStandingsButton({ ...base, hasParticipantRow: true, hasDeclaredColors: true, status: 'drafting' }), 'otros: participante con colores lo ve');
ok(!showStandingsButton({ ...base, hasParticipantRow: true, hasDeclaredColors: false }), 'otros: participante SIN colores NO lo ve (sin cambios)');
ok(showStandingsButton({ ...base }), 'otros: miembro que no juega lo ve con el evento en curso');
ok(!showStandingsButton({ ...base, status: 'scheduled' }), 'otros: miembro que no juega NO lo ve antes de playing');
ok(!showStandingsButton({ ...base, canManageEvent: true, hasParticipantRow: true }), 'otros: la posta sola no da el botón (sin cambios)');
ok(!showStandingsButton({ ...base, isZonesEvent: true, zonesDrawn: false, isOrganizer: true }), 'zonas: sin sorteo no hay botón ni para el organizador');
ok(showStandingsButton({ ...base, isZonesEvent: true, zonesDrawn: true, isOrganizer: true }), 'zonas: con sorteo el organizador lo ve');

console.log(fails ? `\n${fails} FALLAS` : '\nTodo OK');
process.exit(fails ? 1 : 0);

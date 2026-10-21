// Tests de la condición del aviso de Gen 3 desbloqueada (app/src/lib/gen3NoticeCondition.ts). node app/scripts/gen3-notice.test.mjs
import { shouldShowGen3Notice, GEN3_NOTICE_TEXT } from '../src/lib/gen3NoticeCondition.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const T = '2026-10-21T12:00:00Z';
const show = (unlockedAt, seenAt, shownThisSession = false) => shouldShowGen3Notice({ unlockedAt, seenAt, shownThisSession });

ok(show(T, null) === true, 'desbloqueado y sin ver: se muestra');
ok(show(null, null) === false, 'sin desbloqueo: no se muestra');
ok(show(undefined, undefined) === false, 'sin datos: no se muestra');
ok(show(T, T) === false, 'desbloqueado y ya visto: no se muestra');
ok(show(null, T) === false, 'visto sin desbloqueo (dato inconsistente): no se muestra');
ok(show(T, null, true) === false, 'ya mostrado en esta sesión: no se vuelve a mostrar (doble foco, re-render, falla del "visto")');
ok(show(T, '', false) === true, 'seen_at vacío cuenta como no visto');
ok(!/logro|5|cinco/i.test(GEN3_NOTICE_TEXT) && GEN3_NOTICE_TEXT === 'Felicidades, desbloqueaste los pokemones de tercera generación', 'texto exacto, sin mencionar logros ni el 5');

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

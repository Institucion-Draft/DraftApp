// Tests del día y mes de nacimiento del registro (app/src/lib/birthDayMonth.ts). node app/scripts/birth-day-month.test.mjs
import {
  BIRTH_FILL_YEAR,
  MONTH_NAMES,
  daysInBirthMonth,
  dayOptions,
  isValidDayMonth,
  dayAfterMonthChange,
  buildBirthDateString,
  birthDateInputState,
  canSubmitBirth,
  birthDateValue,
  birthDateWarning,
  BIRTH_MISSING_DAY,
  BIRTH_MISSING_MONTH,
} from '../src/lib/birthDayMonth.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };

ok(BIRTH_FILL_YEAR === 2000, 'el año de relleno es 2000 (bisiesto: el 29/2 es una fecha válida)');
ok(MONTH_NAMES.length === 12 && MONTH_NAMES[0] === 'Enero' && MONTH_NAMES[11] === 'Diciembre', '12 meses, de Enero a Diciembre');

// --- días por mes -------------------------------------------------------------------------------------------------------------------------------
const esperado = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
ok(esperado.every((n, i) => daysInBirthMonth(i + 1) === n), 'días por mes: febrero 29 (2000 es bisiesto), abril/junio/septiembre/noviembre 30, el resto 31');
ok(daysInBirthMonth(null) === 0 && daysInBirthMonth(0) === 0 && daysInBirthMonth(13) === 0 && daysInBirthMonth(1.5) === 0, 'mes inválido o ausente: 0 días');
ok(dayOptions(2).length === 29 && dayOptions(2)[28] === 29, 'selector de día con febrero: 1..29');
ok(dayOptions(4).length === 30 && dayOptions(6).length === 30 && dayOptions(9).length === 30 && dayOptions(11).length === 30, 'selector de día con abril, junio, septiembre y noviembre: 1..30');
ok(dayOptions(1).length === 31 && dayOptions(12).length === 31, 'enero y diciembre: 1..31');
ok(dayOptions(null).length === 31 && dayOptions(undefined).length === 31, 'sin mes elegido todavía: 1..31 (se puede elegir el día primero)');

// --- validez ------------------------------------------------------------------------------------------------------------------------------------------
ok(isValidDayMonth(29, 2) && !isValidDayMonth(30, 2) && !isValidDayMonth(31, 2), '29/2 sí; 30/2 y 31/2 no');
ok(isValidDayMonth(30, 4) && !isValidDayMonth(31, 4) && isValidDayMonth(31, 12) && isValidDayMonth(31, 1), '30/4 sí, 31/4 no, 31/12 y 31/1 sí');
ok(!isValidDayMonth(0, 1) && !isValidDayMonth(-1, 1) && !isValidDayMonth(1.5, 1), 'día 0, negativo o con decimales: no');
ok(!isValidDayMonth(null, 5) && !isValidDayMonth(5, null) && !isValidDayMonth(undefined, undefined), 'si falta el día o el mes: no es válido');

// --- cambiar de mes con un día ya elegido ----------------------------------------------------------------------------------------------------------
ok(dayAfterMonthChange(31, 2) === null && dayAfterMonthChange(30, 2) === null, 'día 31 o 30 y se cambia a febrero: se descarta (hay que elegirlo de nuevo)');
ok(dayAfterMonthChange(29, 2) === 29, 'día 29 y se cambia a febrero: se conserva');
ok(dayAfterMonthChange(31, 4) === null && dayAfterMonthChange(30, 4) === 30, 'día 31 a abril: se descarta; día 30 a abril: se conserva');
ok(dayAfterMonthChange(15, 7) === 15 && dayAfterMonthChange(null, 7) === null, 'un día válido se conserva; sin día sigue sin día');

// --- fecha para el registro ------------------------------------------------------------------------------------------------------------------------------
ok(buildBirthDateString(17, 5) === '2000-05-17', '17/5 -> 2000-05-17');
ok(buildBirthDateString(1, 1) === '2000-01-01' && buildBirthDateString(31, 12) === '2000-12-31', 'extremos: 2000-01-01 y 2000-12-31');
ok(buildBirthDateString(29, 2) === '2000-02-29', '29/2 -> 2000-02-29 (válida porque 2000 es bisiesto)');
ok(buildBirthDateString(null, 5) === null && buildBirthDateString(5, null) === null && buildBirthDateString(null, null) === null, 'falta el día o el mes: null (el registro no avanza)');
ok(buildBirthDateString(30, 2) === null && buildBirthDateString(31, 11) === null, 'día que no existe en el mes: null');
let allOk = true; let count = 0;
for (let m = 1; m <= 12; m += 1) {
  for (let d = 1; d <= 31; d += 1) {
    const s = buildBirthDateString(d, m);
    const exists = d <= esperado[m - 1];
    if (exists !== (s !== null)) allOk = false;
    if (s) {
      count += 1;
      const dt = new Date(`${s}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || dt.getUTCMonth() + 1 !== m || dt.getUTCDate() !== d || dt.getUTCFullYear() !== 2000) allOk = false;
    }
  }
}
ok(allOk && count === 366, 'las 366 combinaciones válidas producen una fecha ISO real de 2000 (y ninguna inválida produce fecha)');

// --- cumpleaños OPCIONAL del registro ----------------------------------------------------------------------------------------------------------
const vacio = birthDateInputState(null, null);
ok(vacio.status === 'empty' && canSubmitBirth(vacio) && birthDateValue(vacio) === null && birthDateWarning(vacio) === null, 'los dos vacíos: se puede crear la cuenta, no se manda cumpleaños (null) y no hay aviso');
const completo = birthDateInputState(17, 5);
ok(completo.status === 'complete' && canSubmitBirth(completo) && birthDateValue(completo) === '2000-05-17' && birthDateWarning(completo) === null, 'día y mes: se puede crear y se manda 2000-05-17');
ok(birthDateValue(birthDateInputState(29, 2)) === '2000-02-29', '29/2 completo: 2000-02-29');
const soloDia = birthDateInputState(15, null);
ok(soloDia.status === 'missing_month' && !canSubmitBirth(soloDia) && birthDateValue(soloDia) === null && birthDateWarning(soloDia) === BIRTH_MISSING_MONTH, 'solo el día: no se puede crear, aviso "Falta el mes" y no se manda nada');
const soloMes = birthDateInputState(null, 7);
ok(soloMes.status === 'missing_day' && !canSubmitBirth(soloMes) && birthDateValue(soloMes) === null && birthDateWarning(soloMes) === BIRTH_MISSING_DAY, 'solo el mes: no se puede crear, aviso "Falta el día" y no se manda nada');
ok(BIRTH_MISSING_DAY === 'Falta el día' && BIRTH_MISSING_MONTH === 'Falta el mes', 'avisos mínimos y cortos');
const invalido = birthDateInputState(31, 4);
ok(!canSubmitBirth(invalido) && birthDateValue(invalido) === null, 'día que no existe en el mes (31/4): no se puede crear ni se manda');
// vaciar un selector vuelve al estado anterior
ok(canSubmitBirth(birthDateInputState(null, null)) && !canSubmitBirth(birthDateInputState(15, null)) && canSubmitBirth(birthDateInputState(null, null)), 'vaciar el selector que quedó elegido deja el cumpleaños vacío y permite crear la cuenta');
let combos = true;
for (let m = 1; m <= 12; m += 1) for (let d = 1; d <= 31; d += 1) {
  const st = birthDateInputState(d, m);
  if (canSubmitBirth(st) !== (d <= esperado[m - 1]) || (st.status === 'complete' && birthDateValue(st) !== buildBirthDateString(d, m))) combos = false;
}
ok(combos, 'las 372 combinaciones día/mes: se puede crear solo si el día existe en el mes, y el valor es el de buildBirthDateString');

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

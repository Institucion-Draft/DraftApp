// node app/scripts/gendered-text.test.mjs
import { genderedWord, leftWordForPair, resolveGenderedText } from '../src/lib/genderText.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };
const eq = (a, b, m) => ok(a === b, `${m} (${JSON.stringify(a)})`);

// resolveGenderedText: sin cambios
eq(resolveGenderedText('female', 'campeón', 'campeona'), 'campeona', 'resolve female');
eq(resolveGenderedText('male', 'campeón', 'campeona'), 'campeón', 'resolve male');

// genderedWord: female -> femenino; el resto (incl. null/undefined) -> masculino
for (const [key, m, f] of [
  ['left', 'ido', 'ida'],
  ['champion', 'campeón', 'campeona'],
  ['registered', 'inscripto', 'inscripta'],
  ['organizer', 'organizador', 'organizadora'],
  ['eliminated', 'eliminado', 'eliminada'],
]) {
  eq(genderedWord('female', key), f, `${key} female`);
  eq(genderedWord('male', key), m, `${key} male`);
  eq(genderedWord('other', key), m, `${key} other`);
  eq(genderedWord('prefer_not_to_say', key), m, `${key} prefer_not_to_say`);
  eq(genderedWord(null, key), m, `${key} null`);
  eq(genderedWord(undefined, key), m, `${key} undefined`);
}

// capitalize
eq(genderedWord('female', 'champion', { capitalize: true }), 'Campeona', 'capitalize female');
eq(genderedWord('male', 'organizer', { capitalize: true }), 'Organizador', 'capitalize male');
eq(genderedWord('female', 'left', { capitalize: false }), 'ida', 'capitalize false');

// leftWordForPair: solo uno se fue -> su género; los dos (o ninguno) -> masculino
eq(leftWordForPair({ left: true, gender: 'female' }, { left: false, gender: 'male' }), 'ida', 'pair: se fue A mujer');
eq(leftWordForPair({ left: false, gender: 'male' }, { left: true, gender: 'female' }), 'ida', 'pair: se fue B mujer');
eq(leftWordForPair({ left: true, gender: 'male' }, { left: false, gender: 'female' }), 'ido', 'pair: se fue A hombre');
eq(leftWordForPair({ left: true, gender: 'female' }, { left: true, gender: 'female' }), 'ido', 'pair: se fueron los dos');
eq(leftWordForPair({ left: false, gender: 'female' }, { left: false, gender: 'female' }), 'ido', 'pair: ninguno');
eq(leftWordForPair({ left: true, gender: null }, { left: false }), 'ido', 'pair: sin género');

if (fails) { console.log(`\n${fails} FALLOS`); process.exit(1); }
console.log('\nTodo OK');

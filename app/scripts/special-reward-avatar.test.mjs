// Tests de cuándo la recompensa del desbloqueo especial pisa al avatar custom (app/src/lib/specialRewardAvatar.ts).
// node app/scripts/special-reward-avatar.test.mjs
import { isSpecialReward, rewardOverridesCustom, effectiveHasCustomAvatar } from '../src/lib/specialRewardAvatar.ts';

let fails = 0;
const ok = (c, m) => { if (!c) fails += 1; console.log((c ? 'OK   ' : 'FAIL ') + m); };

ok(isSpecialReward('shiny') && isSpecialReward('ditto'), "special_reward válido: 'shiny' y 'ditto'");
ok(!isSpecialReward(null) && !isSpecialReward(undefined) && !isSpecialReward('') && !isSpecialReward('otro') && !isSpecialReward(true), 'null, vacío u otro valor: no es recompensa');

ok(rewardOverridesCustom({ specialReward: 'shiny', hasSprite: true }) === true, "ganador ('shiny') con sprite: el Pokémon pisa al custom");
ok(rewardOverridesCustom({ specialReward: 'ditto', hasSprite: true }) === true, "perdedor ('ditto') con sprite: el Ditto pisa al custom");
ok(rewardOverridesCustom({ specialReward: null, hasSprite: true }) === false, 'sin recompensa: el custom sigue ganando (comportamiento de siempre)');
ok(rewardOverridesCustom({ specialReward: undefined, hasSprite: true }) === false, 'consulta sin special_reward (undefined): el custom sigue ganando');
ok(rewardOverridesCustom({ specialReward: 'shiny', hasSprite: false }) === false, 'con recompensa pero sin sprite que mostrar: se queda el custom');
ok(rewardOverridesCustom({ specialReward: 'shiny', hasSprite: true, isMemberB: true }) === false, 'miembro B de 2HG: nunca se pisa');

ok(effectiveHasCustomAvatar(true, null) === true, 'espejo del Ditto: custom sin recompensa cuenta como custom');
ok(effectiveHasCustomAvatar(true, 'ditto') === false && effectiveHasCustomAvatar(true, 'shiny') === false, 'espejo del Ditto: con recompensa el custom no cuenta (se ve como su Pokémon)');
ok(effectiveHasCustomAvatar(false, 'shiny') === false && effectiveHasCustomAvatar(false, null) === false, 'espejo del Ditto: sin custom nunca cuenta como custom');

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);

-- 0142_gen3_unown.sql
-- Gen 3 desbloqueable por logros de temporada + las 28 formas de Unown.
--
-- QUÉ HACE
--   1. default_avatars: columnas generation (1 = #1-151, 2 = #152-251, 3 = #252-386) y unown_form ('a'..'z',
--      'exclamation', 'question'). La generación de los 251 existentes se carga por storage_path con el orden del Pokédex
--      (los 251 de 0059 coinciden uno a uno con PokeAPI species 1-251). Los 135 de Gen 3 y las 27 formas nuevas de Unown
--      son filas nuevas (idempotente: ON CONFLICT (storage_path)). La fila 'Unown' actual (unown.png) pasa a ser la
--      forma 'a' (lo menos invasivo: los participantes que ya la tienen no cambian).
--   2. user_season_achievement_count(user_id, season_id): logros del usuario en ESA temporada. seasons es POR WORKSPACE
--      (seasons.workspace_id) y achievement_unlocks es único por (workspace, season, user, logro), así que el conteo es
--      por fila de temporada de un workspace: un usuario en varios workspaces cuenta por separado en cada uno y se
--      desbloquea si en CUALQUIERA llega al umbral. Cada temporada tiene su propio season_id: el conteo reinicia solo.
--   3. users.gen3_unlocked_at: lo setea un trigger AFTER INSERT en achievement_unlocks cuando el conteo de esa
--      temporada llega a gen3_unlock_threshold() (5) y sigue null. Nunca vuelve a null: un guard BEFORE INSERT/UPDATE en
--      users impide que anon/authenticated lo escriban (users_update_own deja a cada usuario editar su fila). Backfill de
--      quienes ya tienen >= 5 en alguna temporada.
--   4. assign_rotated_avatar: pool = activos no asignados en el evento y (generation <= 2 o Gen 3 desbloqueada), uniforme.
--      Unown cuenta como UNA especie: sólo entra la fila representante (forma 'a') y sólo si el evento no tiene ya ninguna
--      forma; si sale, la forma sale de la primera letra de display_name (fallback username) con unown_form_for_name().
--      Shiny 1/4096, avatar custom, historial (0017) y 2HG como hasta ahora. Sólo afecta inscripciones nuevas.
--   5. handle_new_user: el avatar por defecto del perfil sólo sale de Gen 1-2 y de la forma 'a' de Unown (si no, un
--      usuario nuevo podría recibir un Gen 3 o una forma de Unown sin haberla desbloqueado).
--
-- ANTES DE CORRER: subir a Storage (bucket default-avatars) la carpeta gen3-unown-upload/ (normal/ -> default-avatars/,
-- shiny/ -> default-avatars/shiny/). Las filas nuevas quedan activas: sin los PNG, un Unown con letra B-Z o un Gen 3
-- desbloqueado mostrarían la inicial en vez del sprite.
--
-- CUERPOS VIVOS QUE REEMPLAZA (md5 del texto entre los delimitadores $$ / $function$; prosrc en pg_proc):
--   assign_rotated_avatar   4b966849bb8fb777c4b48af74008cbba  (1110 caracteres con LF; con CRLF: 87adc55b1943c64223b6109cdb8ae92c, 1155)  [0044]
--   handle_new_user         7f23c3dd8ed0bf736b865810640d97da  (1748 caracteres con LF; con CRLF: 481a1c81c9e682b7e3a4338d27378681, 1817)  [0015]
--   Comparar en Supabase:  select proname, md5(prosrc), length(prosrc) from pg_proc
--                          where pronamespace = 'public'::regnamespace and proname in ('assign_rotated_avatar','handle_new_user');
--
-- OBJETOS NUEVOS: default_avatars.generation / unown_form; users.gen3_unlocked_at; índice único
-- default_avatars_unown_form_key; funciones unown_form_for_name, gen3_unlock_threshold, user_season_achievement_count,
-- achievement_unlock_gen3_check, users_guard_gen3_unlocked; triggers trg_achievement_unlocks_gen3 (achievement_unlocks)
-- y trg_users_guard_gen3_unlocked (users).

-- ===========================================================================
-- 1. Columnas
-- ===========================================================================
alter table public.default_avatars add column if not exists generation smallint;
alter table public.default_avatars add column if not exists unown_form text;
alter table public.users add column if not exists gen3_unlocked_at timestamptz;

alter table public.default_avatars drop constraint if exists default_avatars_generation_check;
alter table public.default_avatars
  add constraint default_avatars_generation_check check (generation is null or generation between 1 and 3);

alter table public.default_avatars drop constraint if exists default_avatars_unown_form_check;
alter table public.default_avatars
  add constraint default_avatars_unown_form_check
    check (unown_form is null or unown_form ~ '^([a-z]|exclamation|question)$');

create unique index if not exists default_avatars_unown_form_key
  on public.default_avatars (unown_form) where unown_form is not null;

-- ===========================================================================
-- 2. Generación de los 251 existentes (por storage_path; orden del Pokédex nacional)
-- ===========================================================================
update public.default_avatars da
set generation = v.gen
from (values
    ('default-avatars/bulbasaur.png', 1),
    ('default-avatars/ivysaur.png', 1),
    ('default-avatars/venusaur.png', 1),
    ('default-avatars/charmander.png', 1),
    ('default-avatars/charmeleon.png', 1),
    ('default-avatars/charizard.png', 1),
    ('default-avatars/squirtle.png', 1),
    ('default-avatars/wartortle.png', 1),
    ('default-avatars/blastoise.png', 1),
    ('default-avatars/caterpie.png', 1),
    ('default-avatars/metapod.png', 1),
    ('default-avatars/butterfree.png', 1),
    ('default-avatars/weedle.png', 1),
    ('default-avatars/kakuna.png', 1),
    ('default-avatars/beedrill.png', 1),
    ('default-avatars/pidgey.png', 1),
    ('default-avatars/pidgeotto.png', 1),
    ('default-avatars/pidgeot.png', 1),
    ('default-avatars/rattata.png', 1),
    ('default-avatars/raticate.png', 1),
    ('default-avatars/spearow.png', 1),
    ('default-avatars/fearow.png', 1),
    ('default-avatars/ekans.png', 1),
    ('default-avatars/arbok.png', 1),
    ('default-avatars/pikachu.png', 1),
    ('default-avatars/raichu.png', 1),
    ('default-avatars/sandshrew.png', 1),
    ('default-avatars/sandslash.png', 1),
    ('default-avatars/nidoran-f.png', 1),
    ('default-avatars/nidorina.png', 1),
    ('default-avatars/nidoqueen.png', 1),
    ('default-avatars/nidoran-m.png', 1),
    ('default-avatars/nidorino.png', 1),
    ('default-avatars/nidoking.png', 1),
    ('default-avatars/clefairy.png', 1),
    ('default-avatars/clefable.png', 1),
    ('default-avatars/vulpix.png', 1),
    ('default-avatars/ninetales.png', 1),
    ('default-avatars/jigglypuff.png', 1),
    ('default-avatars/wigglytuff.png', 1),
    ('default-avatars/zubat.png', 1),
    ('default-avatars/golbat.png', 1),
    ('default-avatars/oddish.png', 1),
    ('default-avatars/gloom.png', 1),
    ('default-avatars/vileplume.png', 1),
    ('default-avatars/paras.png', 1),
    ('default-avatars/parasect.png', 1),
    ('default-avatars/venonat.png', 1),
    ('default-avatars/venomoth.png', 1),
    ('default-avatars/diglett.png', 1),
    ('default-avatars/dugtrio.png', 1),
    ('default-avatars/meowth.png', 1),
    ('default-avatars/persian.png', 1),
    ('default-avatars/psyduck.png', 1),
    ('default-avatars/golduck.png', 1),
    ('default-avatars/mankey.png', 1),
    ('default-avatars/primeape.png', 1),
    ('default-avatars/growlithe.png', 1),
    ('default-avatars/arcanine.png', 1),
    ('default-avatars/poliwag.png', 1),
    ('default-avatars/poliwhirl.png', 1),
    ('default-avatars/poliwrath.png', 1),
    ('default-avatars/abra.png', 1),
    ('default-avatars/kadabra.png', 1),
    ('default-avatars/alakazam.png', 1),
    ('default-avatars/machop.png', 1),
    ('default-avatars/machoke.png', 1),
    ('default-avatars/machamp.png', 1),
    ('default-avatars/bellsprout.png', 1),
    ('default-avatars/weepinbell.png', 1),
    ('default-avatars/victreebel.png', 1),
    ('default-avatars/tentacool.png', 1),
    ('default-avatars/tentacruel.png', 1),
    ('default-avatars/geodude.png', 1),
    ('default-avatars/graveler.png', 1),
    ('default-avatars/golem.png', 1),
    ('default-avatars/ponyta.png', 1),
    ('default-avatars/rapidash.png', 1),
    ('default-avatars/slowpoke.png', 1),
    ('default-avatars/slowbro.png', 1),
    ('default-avatars/magnemite.png', 1),
    ('default-avatars/magneton.png', 1),
    ('default-avatars/farfetchd.png', 1),
    ('default-avatars/doduo.png', 1),
    ('default-avatars/dodrio.png', 1),
    ('default-avatars/seel.png', 1),
    ('default-avatars/dewgong.png', 1),
    ('default-avatars/grimer.png', 1),
    ('default-avatars/muk.png', 1),
    ('default-avatars/shellder.png', 1),
    ('default-avatars/cloyster.png', 1),
    ('default-avatars/gastly.png', 1),
    ('default-avatars/haunter.png', 1),
    ('default-avatars/gengar.png', 1),
    ('default-avatars/onix.png', 1),
    ('default-avatars/drowzee.png', 1),
    ('default-avatars/hypno.png', 1),
    ('default-avatars/krabby.png', 1),
    ('default-avatars/kingler.png', 1),
    ('default-avatars/voltorb.png', 1),
    ('default-avatars/electrode.png', 1),
    ('default-avatars/exeggcute.png', 1),
    ('default-avatars/exeggutor.png', 1),
    ('default-avatars/cubone.png', 1),
    ('default-avatars/marowak.png', 1),
    ('default-avatars/hitmonlee.png', 1),
    ('default-avatars/hitmonchan.png', 1),
    ('default-avatars/lickitung.png', 1),
    ('default-avatars/koffing.png', 1),
    ('default-avatars/weezing.png', 1),
    ('default-avatars/rhyhorn.png', 1),
    ('default-avatars/rhydon.png', 1),
    ('default-avatars/chansey.png', 1),
    ('default-avatars/tangela.png', 1),
    ('default-avatars/kangaskhan.png', 1),
    ('default-avatars/horsea.png', 1),
    ('default-avatars/seadra.png', 1),
    ('default-avatars/goldeen.png', 1),
    ('default-avatars/seaking.png', 1),
    ('default-avatars/staryu.png', 1),
    ('default-avatars/starmie.png', 1),
    ('default-avatars/mr-mime.png', 1),
    ('default-avatars/scyther.png', 1),
    ('default-avatars/jynx.png', 1),
    ('default-avatars/electabuzz.png', 1),
    ('default-avatars/magmar.png', 1),
    ('default-avatars/pinsir.png', 1),
    ('default-avatars/tauros.png', 1),
    ('default-avatars/magikarp.png', 1),
    ('default-avatars/gyarados.png', 1),
    ('default-avatars/lapras.png', 1),
    ('default-avatars/ditto.png', 1),
    ('default-avatars/eevee.png', 1),
    ('default-avatars/vaporeon.png', 1),
    ('default-avatars/jolteon.png', 1),
    ('default-avatars/flareon.png', 1),
    ('default-avatars/porygon.png', 1),
    ('default-avatars/omanyte.png', 1),
    ('default-avatars/omastar.png', 1),
    ('default-avatars/kabuto.png', 1),
    ('default-avatars/kabutops.png', 1),
    ('default-avatars/aerodactyl.png', 1),
    ('default-avatars/snorlax.png', 1),
    ('default-avatars/articuno.png', 1),
    ('default-avatars/zapdos.png', 1),
    ('default-avatars/moltres.png', 1),
    ('default-avatars/dratini.png', 1),
    ('default-avatars/dragonair.png', 1),
    ('default-avatars/dragonite.png', 1),
    ('default-avatars/mewtwo.png', 1),
    ('default-avatars/mew.png', 1),
    ('default-avatars/chikorita.png', 2),
    ('default-avatars/bayleef.png', 2),
    ('default-avatars/meganium.png', 2),
    ('default-avatars/cyndaquil.png', 2),
    ('default-avatars/quilava.png', 2),
    ('default-avatars/typhlosion.png', 2),
    ('default-avatars/totodile.png', 2),
    ('default-avatars/croconaw.png', 2),
    ('default-avatars/feraligatr.png', 2),
    ('default-avatars/sentret.png', 2),
    ('default-avatars/furret.png', 2),
    ('default-avatars/hoothoot.png', 2),
    ('default-avatars/noctowl.png', 2),
    ('default-avatars/ledyba.png', 2),
    ('default-avatars/ledian.png', 2),
    ('default-avatars/spinarak.png', 2),
    ('default-avatars/ariados.png', 2),
    ('default-avatars/crobat.png', 2),
    ('default-avatars/chinchou.png', 2),
    ('default-avatars/lanturn.png', 2),
    ('default-avatars/pichu.png', 2),
    ('default-avatars/cleffa.png', 2),
    ('default-avatars/igglybuff.png', 2),
    ('default-avatars/togepi.png', 2),
    ('default-avatars/togetic.png', 2),
    ('default-avatars/natu.png', 2),
    ('default-avatars/xatu.png', 2),
    ('default-avatars/mareep.png', 2),
    ('default-avatars/flaaffy.png', 2),
    ('default-avatars/ampharos.png', 2),
    ('default-avatars/bellossom.png', 2),
    ('default-avatars/marill.png', 2),
    ('default-avatars/azumarill.png', 2),
    ('default-avatars/sudowoodo.png', 2),
    ('default-avatars/politoed.png', 2),
    ('default-avatars/hoppip.png', 2),
    ('default-avatars/skiploom.png', 2),
    ('default-avatars/jumpluff.png', 2),
    ('default-avatars/aipom.png', 2),
    ('default-avatars/sunkern.png', 2),
    ('default-avatars/sunflora.png', 2),
    ('default-avatars/yanma.png', 2),
    ('default-avatars/wooper.png', 2),
    ('default-avatars/quagsire.png', 2),
    ('default-avatars/espeon.png', 2),
    ('default-avatars/umbreon.png', 2),
    ('default-avatars/murkrow.png', 2),
    ('default-avatars/slowking.png', 2),
    ('default-avatars/misdreavus.png', 2),
    ('default-avatars/unown.png', 2),
    ('default-avatars/wobbuffet.png', 2),
    ('default-avatars/girafarig.png', 2),
    ('default-avatars/pineco.png', 2),
    ('default-avatars/forretress.png', 2),
    ('default-avatars/dunsparce.png', 2),
    ('default-avatars/gligar.png', 2),
    ('default-avatars/steelix.png', 2),
    ('default-avatars/snubbull.png', 2),
    ('default-avatars/granbull.png', 2),
    ('default-avatars/qwilfish.png', 2),
    ('default-avatars/scizor.png', 2),
    ('default-avatars/shuckle.png', 2),
    ('default-avatars/heracross.png', 2),
    ('default-avatars/sneasel.png', 2),
    ('default-avatars/teddiursa.png', 2),
    ('default-avatars/ursaring.png', 2),
    ('default-avatars/slugma.png', 2),
    ('default-avatars/magcargo.png', 2),
    ('default-avatars/swinub.png', 2),
    ('default-avatars/piloswine.png', 2),
    ('default-avatars/corsola.png', 2),
    ('default-avatars/remoraid.png', 2),
    ('default-avatars/octillery.png', 2),
    ('default-avatars/delibird.png', 2),
    ('default-avatars/mantine.png', 2),
    ('default-avatars/skarmory.png', 2),
    ('default-avatars/houndour.png', 2),
    ('default-avatars/houndoom.png', 2),
    ('default-avatars/kingdra.png', 2),
    ('default-avatars/phanpy.png', 2),
    ('default-avatars/donphan.png', 2),
    ('default-avatars/porygon2.png', 2),
    ('default-avatars/stantler.png', 2),
    ('default-avatars/smeargle.png', 2),
    ('default-avatars/tyrogue.png', 2),
    ('default-avatars/hitmontop.png', 2),
    ('default-avatars/smoochum.png', 2),
    ('default-avatars/elekid.png', 2),
    ('default-avatars/magby.png', 2),
    ('default-avatars/miltank.png', 2),
    ('default-avatars/blissey.png', 2),
    ('default-avatars/raikou.png', 2),
    ('default-avatars/entei.png', 2),
    ('default-avatars/suicune.png', 2),
    ('default-avatars/larvitar.png', 2),
    ('default-avatars/pupitar.png', 2),
    ('default-avatars/tyranitar.png', 2),
    ('default-avatars/lugia.png', 2),
    ('default-avatars/ho-oh.png', 2),
    ('default-avatars/celebi.png', 2)
) as v(storage_path, gen)
where da.storage_path = v.storage_path
  and da.generation is distinct from v.gen;

-- La fila 'Unown' existente es la forma 'a' (201.png).
update public.default_avatars
set unown_form = 'a'
where storage_path = 'default-avatars/unown.png'
  and unown_form is distinct from 'a';

-- ===========================================================================
-- 3. Gen 3 (#252-386) y formas B-Z, '!' y '?' de Unown
-- ===========================================================================
insert into public.default_avatars (name, storage_path, storage_path_shiny, pokemon_type, generation, is_active)
select v.name, v.storage_path, v.storage_path_shiny, v.pokemon_type, 3, true
from (values
    ('Treecko', 'default-avatars/treecko.png', 'default-avatars/shiny/treecko.png', 'Planta'),
    ('Grovyle', 'default-avatars/grovyle.png', 'default-avatars/shiny/grovyle.png', 'Planta'),
    ('Sceptile', 'default-avatars/sceptile.png', 'default-avatars/shiny/sceptile.png', 'Planta'),
    ('Torchic', 'default-avatars/torchic.png', 'default-avatars/shiny/torchic.png', 'Fuego'),
    ('Combusken', 'default-avatars/combusken.png', 'default-avatars/shiny/combusken.png', 'Fuego'),
    ('Blaziken', 'default-avatars/blaziken.png', 'default-avatars/shiny/blaziken.png', 'Fuego'),
    ('Mudkip', 'default-avatars/mudkip.png', 'default-avatars/shiny/mudkip.png', 'Agua'),
    ('Marshtomp', 'default-avatars/marshtomp.png', 'default-avatars/shiny/marshtomp.png', 'Agua'),
    ('Swampert', 'default-avatars/swampert.png', 'default-avatars/shiny/swampert.png', 'Agua'),
    ('Poochyena', 'default-avatars/poochyena.png', 'default-avatars/shiny/poochyena.png', 'Siniestro'),
    ('Mightyena', 'default-avatars/mightyena.png', 'default-avatars/shiny/mightyena.png', 'Siniestro'),
    ('Zigzagoon', 'default-avatars/zigzagoon.png', 'default-avatars/shiny/zigzagoon.png', 'Normal'),
    ('Linoone', 'default-avatars/linoone.png', 'default-avatars/shiny/linoone.png', 'Normal'),
    ('Wurmple', 'default-avatars/wurmple.png', 'default-avatars/shiny/wurmple.png', 'Bicho'),
    ('Silcoon', 'default-avatars/silcoon.png', 'default-avatars/shiny/silcoon.png', 'Bicho'),
    ('Beautifly', 'default-avatars/beautifly.png', 'default-avatars/shiny/beautifly.png', 'Bicho'),
    ('Cascoon', 'default-avatars/cascoon.png', 'default-avatars/shiny/cascoon.png', 'Bicho'),
    ('Dustox', 'default-avatars/dustox.png', 'default-avatars/shiny/dustox.png', 'Bicho'),
    ('Lotad', 'default-avatars/lotad.png', 'default-avatars/shiny/lotad.png', 'Agua'),
    ('Lombre', 'default-avatars/lombre.png', 'default-avatars/shiny/lombre.png', 'Agua'),
    ('Ludicolo', 'default-avatars/ludicolo.png', 'default-avatars/shiny/ludicolo.png', 'Agua'),
    ('Seedot', 'default-avatars/seedot.png', 'default-avatars/shiny/seedot.png', 'Planta'),
    ('Nuzleaf', 'default-avatars/nuzleaf.png', 'default-avatars/shiny/nuzleaf.png', 'Planta'),
    ('Shiftry', 'default-avatars/shiftry.png', 'default-avatars/shiny/shiftry.png', 'Planta'),
    ('Taillow', 'default-avatars/taillow.png', 'default-avatars/shiny/taillow.png', 'Normal'),
    ('Swellow', 'default-avatars/swellow.png', 'default-avatars/shiny/swellow.png', 'Normal'),
    ('Wingull', 'default-avatars/wingull.png', 'default-avatars/shiny/wingull.png', 'Agua'),
    ('Pelipper', 'default-avatars/pelipper.png', 'default-avatars/shiny/pelipper.png', 'Agua'),
    ('Ralts', 'default-avatars/ralts.png', 'default-avatars/shiny/ralts.png', 'Psíquico'),
    ('Kirlia', 'default-avatars/kirlia.png', 'default-avatars/shiny/kirlia.png', 'Psíquico'),
    ('Gardevoir', 'default-avatars/gardevoir.png', 'default-avatars/shiny/gardevoir.png', 'Psíquico'),
    ('Surskit', 'default-avatars/surskit.png', 'default-avatars/shiny/surskit.png', 'Bicho'),
    ('Masquerain', 'default-avatars/masquerain.png', 'default-avatars/shiny/masquerain.png', 'Bicho'),
    ('Shroomish', 'default-avatars/shroomish.png', 'default-avatars/shiny/shroomish.png', 'Planta'),
    ('Breloom', 'default-avatars/breloom.png', 'default-avatars/shiny/breloom.png', 'Planta'),
    ('Slakoth', 'default-avatars/slakoth.png', 'default-avatars/shiny/slakoth.png', 'Normal'),
    ('Vigoroth', 'default-avatars/vigoroth.png', 'default-avatars/shiny/vigoroth.png', 'Normal'),
    ('Slaking', 'default-avatars/slaking.png', 'default-avatars/shiny/slaking.png', 'Normal'),
    ('Nincada', 'default-avatars/nincada.png', 'default-avatars/shiny/nincada.png', 'Bicho'),
    ('Ninjask', 'default-avatars/ninjask.png', 'default-avatars/shiny/ninjask.png', 'Bicho'),
    ('Shedinja', 'default-avatars/shedinja.png', 'default-avatars/shiny/shedinja.png', 'Bicho'),
    ('Whismur', 'default-avatars/whismur.png', 'default-avatars/shiny/whismur.png', 'Normal'),
    ('Loudred', 'default-avatars/loudred.png', 'default-avatars/shiny/loudred.png', 'Normal'),
    ('Exploud', 'default-avatars/exploud.png', 'default-avatars/shiny/exploud.png', 'Normal'),
    ('Makuhita', 'default-avatars/makuhita.png', 'default-avatars/shiny/makuhita.png', 'Lucha'),
    ('Hariyama', 'default-avatars/hariyama.png', 'default-avatars/shiny/hariyama.png', 'Lucha'),
    ('Azurill', 'default-avatars/azurill.png', 'default-avatars/shiny/azurill.png', 'Normal'),
    ('Nosepass', 'default-avatars/nosepass.png', 'default-avatars/shiny/nosepass.png', 'Roca'),
    ('Skitty', 'default-avatars/skitty.png', 'default-avatars/shiny/skitty.png', 'Normal'),
    ('Delcatty', 'default-avatars/delcatty.png', 'default-avatars/shiny/delcatty.png', 'Normal'),
    ('Sableye', 'default-avatars/sableye.png', 'default-avatars/shiny/sableye.png', 'Siniestro'),
    ('Mawile', 'default-avatars/mawile.png', 'default-avatars/shiny/mawile.png', 'Acero'),
    ('Aron', 'default-avatars/aron.png', 'default-avatars/shiny/aron.png', 'Acero'),
    ('Lairon', 'default-avatars/lairon.png', 'default-avatars/shiny/lairon.png', 'Acero'),
    ('Aggron', 'default-avatars/aggron.png', 'default-avatars/shiny/aggron.png', 'Acero'),
    ('Meditite', 'default-avatars/meditite.png', 'default-avatars/shiny/meditite.png', 'Lucha'),
    ('Medicham', 'default-avatars/medicham.png', 'default-avatars/shiny/medicham.png', 'Lucha'),
    ('Electrike', 'default-avatars/electrike.png', 'default-avatars/shiny/electrike.png', 'Eléctrico'),
    ('Manectric', 'default-avatars/manectric.png', 'default-avatars/shiny/manectric.png', 'Eléctrico'),
    ('Plusle', 'default-avatars/plusle.png', 'default-avatars/shiny/plusle.png', 'Eléctrico'),
    ('Minun', 'default-avatars/minun.png', 'default-avatars/shiny/minun.png', 'Eléctrico'),
    ('Volbeat', 'default-avatars/volbeat.png', 'default-avatars/shiny/volbeat.png', 'Bicho'),
    ('Illumise', 'default-avatars/illumise.png', 'default-avatars/shiny/illumise.png', 'Bicho'),
    ('Roselia', 'default-avatars/roselia.png', 'default-avatars/shiny/roselia.png', 'Planta'),
    ('Gulpin', 'default-avatars/gulpin.png', 'default-avatars/shiny/gulpin.png', 'Veneno'),
    ('Swalot', 'default-avatars/swalot.png', 'default-avatars/shiny/swalot.png', 'Veneno'),
    ('Carvanha', 'default-avatars/carvanha.png', 'default-avatars/shiny/carvanha.png', 'Agua'),
    ('Sharpedo', 'default-avatars/sharpedo.png', 'default-avatars/shiny/sharpedo.png', 'Agua'),
    ('Wailmer', 'default-avatars/wailmer.png', 'default-avatars/shiny/wailmer.png', 'Agua'),
    ('Wailord', 'default-avatars/wailord.png', 'default-avatars/shiny/wailord.png', 'Agua'),
    ('Numel', 'default-avatars/numel.png', 'default-avatars/shiny/numel.png', 'Fuego'),
    ('Camerupt', 'default-avatars/camerupt.png', 'default-avatars/shiny/camerupt.png', 'Fuego'),
    ('Torkoal', 'default-avatars/torkoal.png', 'default-avatars/shiny/torkoal.png', 'Fuego'),
    ('Spoink', 'default-avatars/spoink.png', 'default-avatars/shiny/spoink.png', 'Psíquico'),
    ('Grumpig', 'default-avatars/grumpig.png', 'default-avatars/shiny/grumpig.png', 'Psíquico'),
    ('Spinda', 'default-avatars/spinda.png', 'default-avatars/shiny/spinda.png', 'Normal'),
    ('Trapinch', 'default-avatars/trapinch.png', 'default-avatars/shiny/trapinch.png', 'Tierra'),
    ('Vibrava', 'default-avatars/vibrava.png', 'default-avatars/shiny/vibrava.png', 'Tierra'),
    ('Flygon', 'default-avatars/flygon.png', 'default-avatars/shiny/flygon.png', 'Tierra'),
    ('Cacnea', 'default-avatars/cacnea.png', 'default-avatars/shiny/cacnea.png', 'Planta'),
    ('Cacturne', 'default-avatars/cacturne.png', 'default-avatars/shiny/cacturne.png', 'Planta'),
    ('Swablu', 'default-avatars/swablu.png', 'default-avatars/shiny/swablu.png', 'Normal'),
    ('Altaria', 'default-avatars/altaria.png', 'default-avatars/shiny/altaria.png', 'Dragón'),
    ('Zangoose', 'default-avatars/zangoose.png', 'default-avatars/shiny/zangoose.png', 'Normal'),
    ('Seviper', 'default-avatars/seviper.png', 'default-avatars/shiny/seviper.png', 'Veneno'),
    ('Lunatone', 'default-avatars/lunatone.png', 'default-avatars/shiny/lunatone.png', 'Roca'),
    ('Solrock', 'default-avatars/solrock.png', 'default-avatars/shiny/solrock.png', 'Roca'),
    ('Barboach', 'default-avatars/barboach.png', 'default-avatars/shiny/barboach.png', 'Agua'),
    ('Whiscash', 'default-avatars/whiscash.png', 'default-avatars/shiny/whiscash.png', 'Agua'),
    ('Corphish', 'default-avatars/corphish.png', 'default-avatars/shiny/corphish.png', 'Agua'),
    ('Crawdaunt', 'default-avatars/crawdaunt.png', 'default-avatars/shiny/crawdaunt.png', 'Agua'),
    ('Baltoy', 'default-avatars/baltoy.png', 'default-avatars/shiny/baltoy.png', 'Tierra'),
    ('Claydol', 'default-avatars/claydol.png', 'default-avatars/shiny/claydol.png', 'Tierra'),
    ('Lileep', 'default-avatars/lileep.png', 'default-avatars/shiny/lileep.png', 'Roca'),
    ('Cradily', 'default-avatars/cradily.png', 'default-avatars/shiny/cradily.png', 'Roca'),
    ('Anorith', 'default-avatars/anorith.png', 'default-avatars/shiny/anorith.png', 'Roca'),
    ('Armaldo', 'default-avatars/armaldo.png', 'default-avatars/shiny/armaldo.png', 'Roca'),
    ('Feebas', 'default-avatars/feebas.png', 'default-avatars/shiny/feebas.png', 'Agua'),
    ('Milotic', 'default-avatars/milotic.png', 'default-avatars/shiny/milotic.png', 'Agua'),
    ('Castform', 'default-avatars/castform.png', 'default-avatars/shiny/castform.png', 'Normal'),
    ('Kecleon', 'default-avatars/kecleon.png', 'default-avatars/shiny/kecleon.png', 'Normal'),
    ('Shuppet', 'default-avatars/shuppet.png', 'default-avatars/shiny/shuppet.png', 'Fantasma'),
    ('Banette', 'default-avatars/banette.png', 'default-avatars/shiny/banette.png', 'Fantasma'),
    ('Duskull', 'default-avatars/duskull.png', 'default-avatars/shiny/duskull.png', 'Fantasma'),
    ('Dusclops', 'default-avatars/dusclops.png', 'default-avatars/shiny/dusclops.png', 'Fantasma'),
    ('Tropius', 'default-avatars/tropius.png', 'default-avatars/shiny/tropius.png', 'Planta'),
    ('Chimecho', 'default-avatars/chimecho.png', 'default-avatars/shiny/chimecho.png', 'Psíquico'),
    ('Absol', 'default-avatars/absol.png', 'default-avatars/shiny/absol.png', 'Siniestro'),
    ('Wynaut', 'default-avatars/wynaut.png', 'default-avatars/shiny/wynaut.png', 'Psíquico'),
    ('Snorunt', 'default-avatars/snorunt.png', 'default-avatars/shiny/snorunt.png', 'Hielo'),
    ('Glalie', 'default-avatars/glalie.png', 'default-avatars/shiny/glalie.png', 'Hielo'),
    ('Spheal', 'default-avatars/spheal.png', 'default-avatars/shiny/spheal.png', 'Hielo'),
    ('Sealeo', 'default-avatars/sealeo.png', 'default-avatars/shiny/sealeo.png', 'Hielo'),
    ('Walrein', 'default-avatars/walrein.png', 'default-avatars/shiny/walrein.png', 'Hielo'),
    ('Clamperl', 'default-avatars/clamperl.png', 'default-avatars/shiny/clamperl.png', 'Agua'),
    ('Huntail', 'default-avatars/huntail.png', 'default-avatars/shiny/huntail.png', 'Agua'),
    ('Gorebyss', 'default-avatars/gorebyss.png', 'default-avatars/shiny/gorebyss.png', 'Agua'),
    ('Relicanth', 'default-avatars/relicanth.png', 'default-avatars/shiny/relicanth.png', 'Agua'),
    ('Luvdisc', 'default-avatars/luvdisc.png', 'default-avatars/shiny/luvdisc.png', 'Agua'),
    ('Bagon', 'default-avatars/bagon.png', 'default-avatars/shiny/bagon.png', 'Dragón'),
    ('Shelgon', 'default-avatars/shelgon.png', 'default-avatars/shiny/shelgon.png', 'Dragón'),
    ('Salamence', 'default-avatars/salamence.png', 'default-avatars/shiny/salamence.png', 'Dragón'),
    ('Beldum', 'default-avatars/beldum.png', 'default-avatars/shiny/beldum.png', 'Acero'),
    ('Metang', 'default-avatars/metang.png', 'default-avatars/shiny/metang.png', 'Acero'),
    ('Metagross', 'default-avatars/metagross.png', 'default-avatars/shiny/metagross.png', 'Acero'),
    ('Regirock', 'default-avatars/regirock.png', 'default-avatars/shiny/regirock.png', 'Roca'),
    ('Regice', 'default-avatars/regice.png', 'default-avatars/shiny/regice.png', 'Hielo'),
    ('Registeel', 'default-avatars/registeel.png', 'default-avatars/shiny/registeel.png', 'Acero'),
    ('Latias', 'default-avatars/latias.png', 'default-avatars/shiny/latias.png', 'Dragón'),
    ('Latios', 'default-avatars/latios.png', 'default-avatars/shiny/latios.png', 'Dragón'),
    ('Kyogre', 'default-avatars/kyogre.png', 'default-avatars/shiny/kyogre.png', 'Agua'),
    ('Groudon', 'default-avatars/groudon.png', 'default-avatars/shiny/groudon.png', 'Tierra'),
    ('Rayquaza', 'default-avatars/rayquaza.png', 'default-avatars/shiny/rayquaza.png', 'Dragón'),
    ('Jirachi', 'default-avatars/jirachi.png', 'default-avatars/shiny/jirachi.png', 'Acero'),
    ('Deoxys', 'default-avatars/deoxys.png', 'default-avatars/shiny/deoxys.png', 'Psíquico')
) as v(name, storage_path, storage_path_shiny, pokemon_type)
on conflict (storage_path) do update
  set generation = 3,
      storage_path_shiny = excluded.storage_path_shiny,
      pokemon_type = excluded.pokemon_type;

insert into public.default_avatars (name, storage_path, storage_path_shiny, pokemon_type, generation, unown_form, is_active)
select v.name, v.storage_path, v.storage_path_shiny, 'Psíquico', 2, v.unown_form, true
from (values
    ('Unown-B', 'default-avatars/unown-b.png', 'default-avatars/shiny/unown-b.png', 'b'),
    ('Unown-C', 'default-avatars/unown-c.png', 'default-avatars/shiny/unown-c.png', 'c'),
    ('Unown-D', 'default-avatars/unown-d.png', 'default-avatars/shiny/unown-d.png', 'd'),
    ('Unown-E', 'default-avatars/unown-e.png', 'default-avatars/shiny/unown-e.png', 'e'),
    ('Unown-F', 'default-avatars/unown-f.png', 'default-avatars/shiny/unown-f.png', 'f'),
    ('Unown-G', 'default-avatars/unown-g.png', 'default-avatars/shiny/unown-g.png', 'g'),
    ('Unown-H', 'default-avatars/unown-h.png', 'default-avatars/shiny/unown-h.png', 'h'),
    ('Unown-I', 'default-avatars/unown-i.png', 'default-avatars/shiny/unown-i.png', 'i'),
    ('Unown-J', 'default-avatars/unown-j.png', 'default-avatars/shiny/unown-j.png', 'j'),
    ('Unown-K', 'default-avatars/unown-k.png', 'default-avatars/shiny/unown-k.png', 'k'),
    ('Unown-L', 'default-avatars/unown-l.png', 'default-avatars/shiny/unown-l.png', 'l'),
    ('Unown-M', 'default-avatars/unown-m.png', 'default-avatars/shiny/unown-m.png', 'm'),
    ('Unown-N', 'default-avatars/unown-n.png', 'default-avatars/shiny/unown-n.png', 'n'),
    ('Unown-O', 'default-avatars/unown-o.png', 'default-avatars/shiny/unown-o.png', 'o'),
    ('Unown-P', 'default-avatars/unown-p.png', 'default-avatars/shiny/unown-p.png', 'p'),
    ('Unown-Q', 'default-avatars/unown-q.png', 'default-avatars/shiny/unown-q.png', 'q'),
    ('Unown-R', 'default-avatars/unown-r.png', 'default-avatars/shiny/unown-r.png', 'r'),
    ('Unown-S', 'default-avatars/unown-s.png', 'default-avatars/shiny/unown-s.png', 's'),
    ('Unown-T', 'default-avatars/unown-t.png', 'default-avatars/shiny/unown-t.png', 't'),
    ('Unown-U', 'default-avatars/unown-u.png', 'default-avatars/shiny/unown-u.png', 'u'),
    ('Unown-V', 'default-avatars/unown-v.png', 'default-avatars/shiny/unown-v.png', 'v'),
    ('Unown-W', 'default-avatars/unown-w.png', 'default-avatars/shiny/unown-w.png', 'w'),
    ('Unown-X', 'default-avatars/unown-x.png', 'default-avatars/shiny/unown-x.png', 'x'),
    ('Unown-Y', 'default-avatars/unown-y.png', 'default-avatars/shiny/unown-y.png', 'y'),
    ('Unown-Z', 'default-avatars/unown-z.png', 'default-avatars/shiny/unown-z.png', 'z'),
    ('Unown-Exclamation', 'default-avatars/unown-exclamation.png', 'default-avatars/shiny/unown-exclamation.png', 'exclamation'),
    ('Unown-Question', 'default-avatars/unown-question.png', 'default-avatars/shiny/unown-question.png', 'question')
) as v(name, storage_path, storage_path_shiny, unown_form)
on conflict (storage_path) do update
  set generation = 2,
      unown_form = excluded.unown_form,
      storage_path_shiny = excluded.storage_path_shiny,
      pokemon_type = excluded.pokemon_type;

-- ===========================================================================
-- 4. Funciones del desbloqueo
-- ===========================================================================
-- Forma de Unown según el nombre: primer carácter (sin espacios iniciales) de display_name, o de username si queda
-- vacío; sin acentos y en minúscula. A-Z -> esa letra; '!' -> exclamation; '?' -> question; cualquier otra cosa
-- (número, símbolo, emoji, vacío) -> question.
create or replace function public.unown_form_for_name(p_display_name text, p_username text)
returns text
language plpgsql
immutable
as $$
declare
  c text;
begin
  c := left(btrim(coalesce(p_display_name, ''), E' \t\r\n'), 1);
  if c = '' then
    c := left(btrim(coalesce(p_username, ''), E' \t\r\n'), 1);
  end if;
  if c = '' then
    return 'question';
  end if;
  c := translate(
    c,
    'ÁÀÄÂÃÅáàäâãåÉÈËÊéèëêÍÌÏÎíìïîÓÒÖÔÕóòöôõÚÙÜÛúùüûÑñÇç',
    'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuNnCc'
  );
  if c ~ '^[A-Za-z]$' then
    return lower(c);
  elsif c = '!' then
    return 'exclamation';
  end if;
  return 'question';
end;
$$;

-- Umbral de logros de temporada para desbloquear Gen 3 (un solo lugar para cambiarlo).
create or replace function public.gen3_unlock_threshold()
returns integer
language sql
immutable
as $$ select 5 $$;

-- Logros del usuario en una temporada (season_id es de un workspace). Genérica: la reutilizan otros desbloqueos.
create or replace function public.user_season_achievement_count(p_user_id uuid, p_season_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.achievement_unlocks au
  where au.user_id = p_user_id
    and au.season_id = p_season_id
$$;

revoke execute on function public.user_season_achievement_count(uuid, uuid) from public, anon, authenticated;

create or replace function public.achievement_unlock_gen3_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.users u where u.id = new.user_id and u.gen3_unlocked_at is null)
     and public.user_season_achievement_count(new.user_id, new.season_id) >= public.gen3_unlock_threshold() then
    update public.users
    set gen3_unlocked_at = now()
    where id = new.user_id
      and gen3_unlocked_at is null;
  end if;
  return new;
end;
$$;

revoke execute on function public.achievement_unlock_gen3_check() from public, anon, authenticated;

drop trigger if exists trg_achievement_unlocks_gen3 on public.achievement_unlocks;
create trigger trg_achievement_unlocks_gen3
  after insert on public.achievement_unlocks
  for each row execute function public.achievement_unlock_gen3_check();

-- users_update_own permite a cada usuario editar su fila: el flag sólo lo mueven las funciones del sistema.
create or replace function public.users_guard_gen3_unlocked()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.gen3_unlocked_at := null;
    else
      new.gen3_unlocked_at := old.gen3_unlocked_at;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_users_guard_gen3_unlocked on public.users;
create trigger trg_users_guard_gen3_unlocked
  before insert or update on public.users
  for each row execute function public.users_guard_gen3_unlocked();

-- ===========================================================================
-- 5. Backfill: quien ya tiene >= umbral logros en alguna temporada queda desbloqueado
-- ===========================================================================
update public.users u
set gen3_unlocked_at = now()
where u.gen3_unlocked_at is null
  and u.id in (
    select au.user_id
    from public.achievement_unlocks au
    group by au.user_id, au.season_id
    having count(*) >= public.gen3_unlock_threshold()
  );

-- ===========================================================================
-- 6. assign_rotated_avatar (cuerpo de 0044 + pool por generación y Unown como una especie)
-- ===========================================================================
create or replace function public.assign_rotated_avatar()
returns trigger
language plpgsql
security definer
as $$

declare
  user_has_custom boolean;
  gen3_ok boolean;
  v_display text;
  v_username text;
  random_avatar_id uuid;
  picked_unown_form text;
  historical_avatar_id uuid;
  historical_is_shiny boolean;
begin
  select (u.custom_avatar_path is not null),
         (u.gen3_unlocked_at is not null),
         u.display_name,
         u.username
  into user_has_custom, gen3_ok, v_display, v_username
  from public.users u
  where u.id = new.user_id;

  if user_has_custom then
    return new;
  end if;

  select rotated_avatar_id, is_shiny
  into historical_avatar_id, historical_is_shiny
  from public.event_participant_avatar_history
  where user_id = new.user_id
    and event_id = new.event_id;

  if historical_avatar_id is not null then
    new.rotated_avatar_id := historical_avatar_id;
    new.is_shiny := coalesce(historical_is_shiny, false);
    return new;
  end if;

  -- Shiny antes de elegir qué Pokémon
  new.is_shiny := (random() < (1.0 / 4096.0));

  -- Pool del jugador: activos, no asignados en el evento, Gen 1-2 (o también Gen 3 si lo desbloqueó) y Unown como
  -- UNA sola especie: sólo entra su fila representante (forma 'a') y sólo si ninguna forma de Unown está asignada
  -- en el evento. Probabilidad uniforme entre los elegibles.
  select da.id, da.unown_form
  into random_avatar_id, picked_unown_form
  from public.default_avatars da
  where da.is_active = true
    and (coalesce(da.generation, 1) <= 2 or coalesce(gen3_ok, false))
    and (da.unown_form is null or da.unown_form = 'a')
    and da.id not in (
      select rotated_avatar_id
      from public.event_participants
      where event_id = new.event_id
        and rotated_avatar_id is not null
    )
    and (
      da.unown_form is null
      or not exists (
        select 1
        from public.event_participants ep
        join public.default_avatars d2 on d2.id = ep.rotated_avatar_id
        where ep.event_id = new.event_id
          and d2.unown_form is not null
      )
    )
  order by random()
  limit 1;

  -- Salió Unown: la forma depende de la inicial del nombre del jugador (sin la forma, queda la 'a').
  if picked_unown_form is not null then
    select da.id
    into random_avatar_id
    from public.default_avatars da
    where da.unown_form = public.unown_form_for_name(v_display, v_username)
      and da.is_active = true
    limit 1;
    if random_avatar_id is null then
      select da.id into random_avatar_id
      from public.default_avatars da
      where da.unown_form = 'a' and da.is_active = true
      limit 1;
    end if;
  end if;

  new.rotated_avatar_id := random_avatar_id;
  return new;
end;
$$;

-- ===========================================================================
-- 7. handle_new_user (cuerpo de 0015; sólo cambia el pool del avatar por defecto)
-- ===========================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $function$

declare
  random_avatar_id uuid;
  generated_username text;
  meta_display text;
  email_local text;
  chosen_display text;
  meta_gender text;
  chosen_gender text;
  meta_birth_date date;
begin
  -- 0142: el avatar por defecto sale sólo de Gen 1-2 y de una sola forma de Unown (la 'a'); Gen 3 y el resto de
  -- las formas de Unown se reservan a la asignación por evento.
  select id into random_avatar_id
  from public.default_avatars
  where is_active = true
    and coalesce(generation, 1) <= 2
    and (unown_form is null or unown_form = 'a')
  order by random()
  limit 1;

  generated_username := 'user_' || substr(replace(new.id::text, '-', ''), 1, 12);

  meta_display := nullif(
    trim(
      coalesce(
        new.raw_user_meta_data->>'display_name',
        new.raw_user_meta_data->>'full_name',
        ''
      )
    ),
    ''
  );
  if meta_display is not null then
    chosen_display := meta_display;
  elsif new.email is not null and position('@' in new.email) > 1 then
    email_local := trim(split_part(new.email, '@', 1));
    if length(email_local) > 0 then
      chosen_display := email_local;
    else
      chosen_display := generated_username;
    end if;
  else
    chosen_display := generated_username;
  end if;

  -- Resolver gender desde metadata, validar que sea uno de los valores permitidos
  meta_gender := nullif(trim(coalesce(new.raw_user_meta_data->>'gender', '')), '');
  if meta_gender in ('male', 'female', 'other', 'prefer_not_to_say') then
    chosen_gender := meta_gender;
  else
    chosen_gender := 'prefer_not_to_say';
  end if;

  -- Resolver birth_date desde metadata
  begin
    meta_birth_date := (new.raw_user_meta_data->>'birth_date')::date;
  exception when others then
    meta_birth_date := null;
  end;

  insert into public.users (id, username, display_name, default_avatar_id, gender, birth_date)
  values (
    new.id,
    generated_username,
    chosen_display,
    random_avatar_id,
    chosen_gender,
    meta_birth_date
  );

  return new;
end;
$function$;

-- ===========================================================================
-- 8. Verificación
-- ===========================================================================
do $verify$
declare
  v_total integer;
  v_gen1 integer;
  v_gen2 integer;
  v_gen3 integer;
  v_null integer;
  v_unown integer;
begin
  select count(*), count(*) filter (where generation = 1), count(*) filter (where generation = 2),
         count(*) filter (where generation = 3), count(*) filter (where is_active and generation is null),
         count(*) filter (where unown_form is not null)
  into v_total, v_gen1, v_gen2, v_gen3, v_null, v_unown
  from public.default_avatars;

  raise notice '0142: default_avatars total=% gen1=% gen2=% (incluye formas de Unown) gen3=% activos sin generación=% formas de Unown=%',
    v_total, v_gen1, v_gen2, v_gen3, v_null, v_unown;

  if v_gen3 <> 135 then
    raise exception '0142: se esperaban 135 Pokémon de Gen 3 y hay %', v_gen3;
  end if;
  -- En una base reconstruida desde cero no están los 251 originales (se cargan a mano): sin la fila unown.png no hay
  -- forma 'a' y sólo se esperan las 27 nuevas.
  if exists (select 1 from public.default_avatars where storage_path = 'default-avatars/unown.png') then
    if v_unown <> 28 then
      raise exception '0142: se esperaban 28 formas de Unown y hay %', v_unown;
    end if;
  elsif v_unown <> 27 then
    raise exception '0142: se esperaban 27 formas nuevas de Unown y hay %', v_unown;
  end if;
  if v_null > 0 then
    raise warning '0142: % avatares activos sin generación (se tratan como Gen 1)', v_null;
  end if;
  if public.unown_form_for_name('Álvaro', 'x') <> 'a'
     or public.unown_form_for_name('', 'zeta') <> 'z'
     or public.unown_form_for_name('7up', 'x') <> 'question'
     or public.unown_form_for_name('!hola', 'x') <> 'exclamation'
     or public.unown_form_for_name(null, null) <> 'question' then
    raise exception '0142: unown_form_for_name devolvió algo inesperado';
  end if;
  raise notice '0142: usuarios con Gen 3 desbloqueada tras el backfill=%',
    (select count(*) from public.users where gen3_unlocked_at is not null);
end;
$verify$;

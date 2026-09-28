// Todos los require() deben ser estáticos para Metro bundler.
// Medallas: app/assets/achievements/medals/<code>.webp y <code>_locked.webp
// (generadas offline a partir de los 15 originales en app/assets/achievements/).

export type AchievementMedalSource = {
  normal: ReturnType<typeof require>;
  locked: ReturnType<typeof require>;
};

export const ACHIEVEMENT_MEDAL_IMAGES: Record<string, AchievementMedalSource> = {
  plaga: {
    normal: require('../../assets/achievements/medals/plaga.webp'),
    locked: require('../../assets/achievements/medals/plaga_locked.webp'),
  },
  super_plaga: {
    normal: require('../../assets/achievements/medals/super_plaga.webp'),
    locked: require('../../assets/achievements/medals/super_plaga_locked.webp'),
  },
  dalo_vuelta: {
    normal: require('../../assets/achievements/medals/dalo_vuelta.webp'),
    locked: require('../../assets/achievements/medals/dalo_vuelta_locked.webp'),
  },
  remontada_providencial: {
    normal: require('../../assets/achievements/medals/remontada_providencial.webp'),
    locked: require('../../assets/achievements/medals/remontada_providencial_locked.webp'),
  },
  por_la_ventana: {
    normal: require('../../assets/achievements/medals/por_la_ventana.webp'),
    locked: require('../../assets/achievements/medals/por_la_ventana_locked.webp'),
  },
  ventana_puerta_grande: {
    normal: require('../../assets/achievements/medals/ventana_puerta_grande.webp'),
    locked: require('../../assets/achievements/medals/ventana_puerta_grande_locked.webp'),
  },
  duro_de_matar: {
    normal: require('../../assets/achievements/medals/duro_de_matar.webp'),
    locked: require('../../assets/achievements/medals/duro_de_matar_locked.webp'),
  },
  merecido: {
    normal: require('../../assets/achievements/medals/merecido.webp'),
    locked: require('../../assets/achievements/medals/merecido_locked.webp'),
  },
  largar_el_blanco: {
    normal: require('../../assets/achievements/medals/largar_el_blanco.webp'),
    locked: require('../../assets/achievements/medals/largar_el_blanco_locked.webp'),
  },
  bancame_un_toque: {
    normal: require('../../assets/achievements/medals/bancame_un_toque.webp'),
    locked: require('../../assets/achievements/medals/bancame_un_toque_locked.webp'),
  },
  sospechoso: {
    normal: require('../../assets/achievements/medals/sospechoso.webp'),
    locked: require('../../assets/achievements/medals/sospechoso_locked.webp'),
  },
  tiempo_de_reflexionar: {
    normal: require('../../assets/achievements/medals/tiempo_de_reflexionar.webp'),
    locked: require('../../assets/achievements/medals/tiempo_de_reflexionar_locked.webp'),
  },
  buen_companero: {
    normal: require('../../assets/achievements/medals/buen_companero.webp'),
    locked: require('../../assets/achievements/medals/buen_companero_locked.webp'),
  },
  fanatico_del_registro: {
    normal: require('../../assets/achievements/medals/fanatico_del_registro.webp'),
    locked: require('../../assets/achievements/medals/fanatico_del_registro_locked.webp'),
  },
  invicto: {
    normal: require('../../assets/achievements/medals/invicto.webp'),
    locked: require('../../assets/achievements/medals/invicto_locked.webp'),
  },
};

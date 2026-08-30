/**
 * The THREE localized display names of every seeded category, keyed by its
 * stable id — the single place category translations live.
 *
 * Why one shared table instead of per-script literals: `part_categories`
 * requires all three names (name_ru / name_uz / name_en are NOT NULL), and four
 * different entry points write category rows — the main seed, the subcategory
 * seed, the buyer-bucket restore, and the projection's fallback upsert. Each
 * inventing its own translations is how a category ends up named one thing in
 * the bot and another in the buyer app.
 *
 * Uzbek is in LATIN script, matching the `uz` locale the apps ship.
 *
 * An id absent from this table is not an error: {@link localizedNamesFor} falls
 * back to the canonical `name` for every language, which is exactly right for
 * an admin-created category that the seeds know nothing about.
 */

/** Display names of one category, in the three supported languages. */
export interface CategoryNames {
  ru: string;
  uz: string;
  en: string;
}

/** The Prisma column shape — what a create/upsert spreads into `data`. */
export interface CategoryNameColumns {
  nameRu: string;
  nameUz: string;
  nameEn: string;
}

export const CATEGORY_NAMES: Readonly<Record<string, CategoryNames>> = {
  // ── Level-0 roots (the seller bot's first category screen) ────────────────
  'brake-system': {
    ru: 'Тормозная система',
    uz: 'Tormoz tizimi',
    en: 'Brake System',
  },
  'engine-system': { ru: 'Двигатель', uz: 'Dvigatel', en: 'Engine' },
  'suspension-and-steering': {
    ru: 'Подвеска и рулевое',
    uz: 'Osma va rul boshqaruvi',
    en: 'Suspension & Steering',
  },
  transmission: {
    ru: 'Трансмиссия',
    uz: 'Transmissiya',
    en: 'Transmission',
  },
  'heating-and-cooling': {
    ru: 'Отопление и охлаждение',
    uz: 'Isitish va sovutish',
    en: 'Heating & Cooling',
  },
  'electrical-and-lighting': {
    ru: 'Электрика и освещение',
    uz: 'Elektr va yoritish',
    en: 'Electrical & Lighting',
  },
  'maintenance-and-fluids': {
    ru: 'ТО и жидкости',
    uz: 'Texnik xizmat va suyuqliklar',
    en: 'Maintenance & Fluids',
  },
  'motor-oil': { ru: 'Моторные масла', uz: 'Motor moylari', en: 'Motor Oils' },
  'tuning-and-accessories': {
    ru: 'Тюнинг и аксессуары',
    uz: 'Tyuning va aksessuarlar',
    en: 'Tuning & Accessories',
  },
  other: { ru: 'Другое', uz: 'Boshqa', en: 'Other' },
  cat_uncategorized: {
    ru: 'Без категории',
    uz: 'Turkumlanmagan',
    en: 'Uncategorized',
  },

  // ── The 12 canonical buyer-grid buckets (level 1) ─────────────────────────
  brakes: { ru: 'Тормоза', uz: 'Tormozlar', en: 'Brakes' },
  batteries: { ru: 'Аккумуляторы', uz: 'Akkumulyatorlar', en: 'Batteries' },
  filters: { ru: 'Фильтры', uz: 'Filtrlar', en: 'Filters' },
  ignition: { ru: 'Зажигание', uz: 'Yondirish tizimi', en: 'Ignition' },
  engine: { ru: 'Двигатель', uz: 'Dvigatel', en: 'Engine' },
  'electrical-parts': {
    ru: 'Электрооборудование',
    uz: 'Elektr jihozlari',
    en: 'Electrical Parts',
  },
  'oil-and-fluids': {
    ru: 'Масла и жидкости',
    uz: 'Moylar va suyuqliklar',
    en: 'Oil & Fluids',
  },
  'belts-and-hoses': {
    ru: 'Ремни и шланги',
    uz: 'Remenlar va shlanglar',
    en: 'Belts & Hoses',
  },
  wipers: {
    ru: 'Стеклоочистители',
    uz: 'Oyna tozalagichlar',
    en: 'Wipers',
  },
  lighting: { ru: 'Освещение', uz: 'Yoritish', en: 'Lighting' },
  suspension: { ru: 'Подвеска', uz: 'Osma', en: 'Suspension' },
  exterior: {
    ru: 'Кузов и экстерьер',
    uz: 'Kuzov va tashqi qism',
    en: 'Exterior',
  },

  // ── Brakes ────────────────────────────────────────────────────────────────
  'front-brake-pads': {
    ru: 'Передние тормозные колодки',
    uz: 'Old tormoz kolodkalari',
    en: 'Front Brake Pads',
  },
  'rear-brake-pads': {
    ru: 'Задние тормозные колодки',
    uz: 'Orqa tormoz kolodkalari',
    en: 'Rear Brake Pads',
  },
  'brake-discs': {
    ru: 'Тормозные диски',
    uz: 'Tormoz disklari',
    en: 'Brake Discs',
  },
  'brake-calipers-kits': {
    ru: 'Суппорты и ремкомплекты',
    uz: "Supportlar va ta'mirlash to'plamlari",
    en: 'Calipers & Repair Kits',
  },
  'brake-cylinders': {
    ru: 'Тормозные цилиндры',
    uz: 'Tormoz silindrlari',
    en: 'Brake Cylinders',
  },
  'brake-hoses-cables': {
    ru: 'Шланги и тросы',
    uz: 'Shlanglar va troslar',
    en: 'Brake Hoses & Cables',
  },

  // ── Suspension & steering ─────────────────────────────────────────────────
  'shock-absorbers': {
    ru: 'Амортизаторы',
    uz: 'Amortizatorlar',
    en: 'Shock Absorbers',
  },
  'springs-and-mounts': {
    ru: 'Пружины и опоры',
    uz: 'Prujinalar va tayanchlar',
    en: 'Springs & Mounts',
  },
  'stabilizer-links-bushings': {
    ru: 'Стойки и втулки стабилизатора',
    uz: 'Stabilizator stoykalari va vtulkalari',
    en: 'Stabilizer Links & Bushings',
  },
  'control-arms-bushings': {
    ru: 'Рычаги и сайлентблоки',
    uz: 'Richaglar va saylentbloklar',
    en: 'Control Arms & Bushings',
  },
  'ball-joints': {
    ru: 'Шаровые опоры',
    uz: 'Sharsimon tayanchlar',
    en: 'Ball Joints',
  },
  'steering-racks-tie-rods': {
    ru: 'Рулевые рейки и наконечники',
    uz: 'Rul reykalari va nakonechniklari',
    en: 'Steering Racks & Tie Rods',
  },
  'wheel-hubs-bearings': {
    ru: 'Ступицы и подшипники',
    uz: 'Stupitsalar va podshipniklar',
    en: 'Wheel Hubs & Bearings',
  },

  // ── Engine ────────────────────────────────────────────────────────────────
  'timing-belt-kits': {
    ru: 'Комплекты ГРМ и ролики',
    uz: "GRM to'plamlari va roliklar",
    en: 'Timing Belt Kits & Rollers',
  },
  'accessory-drive-belts': {
    ru: 'Ремни навесного оборудования',
    uz: 'Navesnoy uskunalar remenlari',
    en: 'Accessory Drive Belts',
  },
  'gaskets-and-seals': {
    ru: 'Прокладки и сальники',
    uz: 'Prokladkalar va salniklar',
    en: 'Gaskets & Seals',
  },
  'piston-group': {
    ru: 'Поршневая группа',
    uz: 'Porshen guruhi',
    en: 'Piston Group',
  },
  'valves-and-cylinder-head': {
    ru: 'Клапаны и ГБЦ',
    uz: 'Klapanlar va silindr kallagi',
    en: 'Valves & Cylinder Head',
  },
  'engine-mounts': {
    ru: 'Подушки двигателя',
    uz: 'Dvigatel podushkalari',
    en: 'Engine Mounts',
  },

  // ── Heating & cooling ─────────────────────────────────────────────────────
  'cooling-radiators': {
    ru: 'Радиаторы охлаждения',
    uz: 'Sovutish radiatorlari',
    en: 'Cooling Radiators',
  },
  'heater-cores': {
    ru: 'Радиаторы печки',
    uz: 'Pechka radiatorlari',
    en: 'Heater Cores',
  },
  'water-pumps': {
    ru: 'Водяные помпы',
    uz: 'Suv pompalari',
    en: 'Water Pumps',
  },
  thermostats: { ru: 'Термостаты', uz: 'Termostatlar', en: 'Thermostats' },
  'coolant-hoses-tanks': {
    ru: 'Патрубки и бачки',
    uz: 'Patrubkalar va bachoklar',
    en: 'Coolant Hoses & Tanks',
  },
  'cooling-fans': {
    ru: 'Вентиляторы охлаждения',
    uz: 'Sovutish ventilyatorlari',
    en: 'Cooling Fans',
  },

  // ── Maintenance & fluids ──────────────────────────────────────────────────
  'oil-filters': {
    ru: 'Масляные фильтры',
    uz: 'Moy filtrlari',
    en: 'Oil Filters',
  },
  'air-filters': {
    ru: 'Воздушные фильтры',
    uz: 'Havo filtrlari',
    en: 'Air Filters',
  },
  'cabin-filters': {
    ru: 'Салонные фильтры',
    uz: 'Salon filtrlari',
    en: 'Cabin Filters',
  },
  'fuel-filters': {
    ru: 'Топливные фильтры',
    uz: "Yoqilg'i filtrlari",
    en: 'Fuel Filters',
  },
  antifreeze: { ru: 'Антифризы', uz: 'Antifrizlar', en: 'Antifreeze' },
  'technical-fluids': {
    ru: 'Технические жидкости',
    uz: 'Texnik suyuqliklar',
    en: 'Technical Fluids',
  },

  // ── Electrical & lighting ─────────────────────────────────────────────────
  'spark-plugs': {
    ru: 'Свечи зажигания',
    uz: 'Uchqun svechalari',
    en: 'Spark Plugs',
  },
  'ignition-coils-wires': {
    ru: 'Катушки и провода',
    uz: 'Katushkalar va simlar',
    en: 'Ignition Coils & Wires',
  },
  alternators: { ru: 'Генераторы', uz: 'Generatorlar', en: 'Alternators' },
  starters: { ru: 'Стартеры', uz: 'Starterlar', en: 'Starters' },
  'engine-sensors': {
    ru: 'Датчики двигателя',
    uz: 'Dvigatel datchiklari',
    en: 'Engine Sensors',
  },
  'headlights-and-bulbs': {
    ru: 'Оптика и лампы',
    uz: 'Faralar va chiroqlar',
    en: 'Headlights & Bulbs',
  },

  // ── Transmission ──────────────────────────────────────────────────────────
  'clutch-kits': {
    ru: 'Комплекты сцепления',
    uz: "Sseplenie to'plamlari",
    en: 'Clutch Kits',
  },
  'cv-joints-driveshafts': {
    ru: 'ШРУСы и приводы',
    uz: 'Granatalar va privodlar',
    en: 'CV Joints & Driveshafts',
  },
  'cv-joint-boots': {
    ru: 'Пыльники ШРУСа',
    uz: 'Granata pilniklari',
    en: 'CV Joint Boots',
  },
  flywheels: { ru: 'Маховики', uz: 'Mahoviklar', en: 'Flywheels' },
  'gear-linkages-cables': {
    ru: 'Кулисы и тросы',
    uz: 'Kulisalar va troslar',
    en: 'Gear Linkages & Cables',
  },

  // ── Tuning & accessories ──────────────────────────────────────────────────
  'floor-mats': { ru: 'Коврики', uz: 'Gilamchalar', en: 'Floor Mats' },
  'skid-plates': {
    ru: 'Защита картера',
    uz: 'Karter himoyasi',
    en: 'Skid Plates',
  },
  'wind-deflectors-mudflaps': {
    ru: 'Ветровики и брызговики',
    uz: 'Shamol deflektorlari va loyqaytargichlar',
    en: 'Wind Deflectors & Mudflaps',
  },
  'seat-covers': { ru: 'Чехлы', uz: 'Chexollar', en: 'Seat Covers' },

  // ── Motor oil ─────────────────────────────────────────────────────────────
  // The per-viscosity entries ('motor-oil-5w30' …) were removed with the
  // categories themselves: a SAE grade is Product.oilViscosity, not a node in
  // the tree. Transmission oil is a product TYPE and keeps its names.
  'transmission-oil': {
    ru: 'Трансмиссионное масло',
    uz: 'Transmissiya moyi',
    en: 'Transmission Oil',
  },

  // ── The "Другое" catalogue (admin-managed from here on) ───────────────────
  'industrial-oil': {
    ru: 'Индустриальные масла',
    uz: 'Industrial moylar',
    en: 'Industrial Oils',
  },
  'motorcycle-oil': {
    ru: 'Мотоциклетные масла',
    uz: 'Mototsikl moylari',
    en: 'Motorcycle Oils',
  },
  'agricultural-machinery': {
    ru: 'Сельхозтехника',
    uz: "Qishloq xo'jaligi texnikasi",
    en: 'Agricultural Machinery',
  },
  'other-lubricants': {
    ru: 'Прочие смазочные материалы',
    uz: 'Boshqa moylash materiallari',
    en: 'Other Lubricants',
  },

  // ── Misc shared subcategories ─────────────────────────────────────────────
  'fasteners-and-clips': {
    ru: 'Крепеж и клипсы',
    uz: 'Mahkamlagichlar va klipsalar',
    en: 'Fasteners & Clips',
  },
  'wiper-blades': {
    ru: 'Щетки стеклоочистителя',
    uz: "Oyna tozalagich cho'tkalari",
    en: 'Wiper Blades',
  },
};

/**
 * The three name columns to write for `id`. An unknown id falls back to
 * `fallbackName` in every language — never null, so the NOT NULL columns are
 * always satisfiable and a seed can never fail on a category the table has yet
 * to learn about.
 */
export function localizedNamesFor(
  id: string,
  fallbackName: string,
): CategoryNameColumns {
  // Own-property lookup only: an id like 'constructor' must not inherit a
  // truthy value off Object.prototype and be written as a name.
  const names = Object.prototype.hasOwnProperty.call(CATEGORY_NAMES, id)
    ? CATEGORY_NAMES[id]
    : undefined;
  return {
    nameRu: names?.ru ?? fallbackName,
    nameUz: names?.uz ?? fallbackName,
    nameEn: names?.en ?? fallbackName,
  };
}

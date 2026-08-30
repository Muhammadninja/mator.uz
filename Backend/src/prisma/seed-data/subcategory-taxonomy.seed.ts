/**
 * The SUBCATEGORY taxonomy — which subcategories hang under which level-0 root.
 *
 * Pure data, deliberately kept out of `prisma/seed-categories.ts`: that file
 * opens a PrismaClient and runs its seed on import, so anything that merely
 * wants to READ the tree shape (the translations export, tests, tooling) cannot
 * import it without executing a database write. This module can be imported by
 * anyone.
 *
 * Parent ids are the live PartCategory root ids; `friendlySlug` documents the
 * brakes→brake-system style mapping the product owner approved. The Russian
 * `name` here is the canonical label; the three localized display names live in
 * {@link ./category-names.seed} keyed by the same slug.
 */

/** A subcategory to create under a root: Russian display name + stable ASCII slug (= id). */
export interface Sub {
  name: string;
  slug: string;
}

/** One root and the subcategories to seed beneath it. */
export interface RootGroup {
  /** Real PartCategory root id in the DB (NOT the friendly slug). */
  parentId: string;
  /** Canonical root display name — used only if the root is missing and must be created. */
  parentName: string;
  /** Friendly slug some tools display, kept here purely for traceability. */
  friendlySlug: string;
  subs: Sub[];
}

/**
 * The taxonomy. Parent ids are the live root ids resolved from
 * GET /v1/reference/categories; the `friendlySlug` column documents the
 * brakes→brake-system style mapping the product owner approved.
 */
export const TAXONOMY: RootGroup[] = [
  {
    friendlySlug: 'brakes',
    parentId: 'brake-system',
    parentName: 'Brake System',
    subs: [
      { name: 'Передние тормозные колодки', slug: 'front-brake-pads' },
      { name: 'Задние тормозные колодки', slug: 'rear-brake-pads' },
      { name: 'Тормозные диски', slug: 'brake-discs' },
      { name: 'Суппорты и ремкомплекты', slug: 'brake-calipers-kits' },
      { name: 'Тормозные цилиндры', slug: 'brake-cylinders' },
      { name: 'Шланги и тросы', slug: 'brake-hoses-cables' },
    ],
  },
  {
    friendlySlug: 'suspension',
    parentId: 'suspension-and-steering',
    parentName: 'Suspension & Steering',
    subs: [
      { name: 'Амортизаторы', slug: 'shock-absorbers' },
      { name: 'Пружины и опоры', slug: 'springs-and-mounts' },
      { name: 'Стойки и втулки стабилизатора', slug: 'stabilizer-links-bushings' },
      { name: 'Рычаги и сайлентблоки', slug: 'control-arms-bushings' },
      { name: 'Шаровые опоры', slug: 'ball-joints' },
      { name: 'Рулевые рейки и наконечники', slug: 'steering-racks-tie-rods' },
      { name: 'Ступицы и подшипники', slug: 'wheel-hubs-bearings' },
    ],
  },
  {
    friendlySlug: 'engine',
    parentId: 'engine-system',
    parentName: 'Engine',
    subs: [
      { name: 'Комплекты ГРМ и ролики', slug: 'timing-belt-kits' },
      { name: 'Ремни навесного оборудования', slug: 'accessory-drive-belts' },
      { name: 'Прокладки и сальники', slug: 'gaskets-and-seals' },
      { name: 'Поршневая группа', slug: 'piston-group' },
      { name: 'Клапаны и ГБЦ', slug: 'valves-and-cylinder-head' },
      { name: 'Подушки двигателя', slug: 'engine-mounts' },
    ],
  },
  {
    friendlySlug: 'cooling',
    parentId: 'heating-and-cooling',
    parentName: 'Heating & Cooling',
    subs: [
      { name: 'Радиаторы охлаждения', slug: 'cooling-radiators' },
      { name: 'Радиаторы печки', slug: 'heater-cores' },
      { name: 'Водяные помпы', slug: 'water-pumps' },
      { name: 'Термостаты', slug: 'thermostats' },
      { name: 'Патрубки и бачки', slug: 'coolant-hoses-tanks' },
      { name: 'Вентиляторы охлаждения', slug: 'cooling-fans' },
    ],
  },
  {
    friendlySlug: 'oil',
    parentId: 'maintenance-and-fluids',
    parentName: 'Maintenance & Fluids',
    subs: [
      { name: 'Масляные фильтры', slug: 'oil-filters' },
      { name: 'Воздушные фильтры', slug: 'air-filters' },
      { name: 'Салонные фильтры', slug: 'cabin-filters' },
      { name: 'Топливные фильтры', slug: 'fuel-filters' },
      { name: 'Антифризы', slug: 'antifreeze' },
      { name: 'Технические жидкости', slug: 'technical-fluids' },
    ],
  },
  {
    friendlySlug: 'electrical',
    parentId: 'electrical-and-lighting',
    parentName: 'Electrical & Lighting',
    subs: [
      { name: 'Свечи зажигания', slug: 'spark-plugs' },
      { name: 'Катушки и провода', slug: 'ignition-coils-wires' },
      { name: 'Генераторы', slug: 'alternators' },
      { name: 'Стартеры', slug: 'starters' },
      { name: 'Датчики двигателя', slug: 'engine-sensors' },
      { name: 'Оптика и лампы', slug: 'headlights-and-bulbs' },
    ],
  },
  {
    friendlySlug: 'transmissions',
    parentId: 'transmission',
    parentName: 'Transmissions',
    subs: [
      { name: 'Комплекты сцепления', slug: 'clutch-kits' },
      { name: 'ШРУСы и приводы', slug: 'cv-joints-driveshafts' },
      { name: 'Пыльники ШРУСа', slug: 'cv-joint-boots' },
      { name: 'Маховики', slug: 'flywheels' },
      { name: 'Кулисы и тросы', slug: 'gear-linkages-cables' },
    ],
  },
  {
    friendlySlug: 'tuning',
    parentId: 'tuning-and-accessories',
    parentName: 'Tuning & Accessories',
    subs: [
      { name: 'Коврики', slug: 'floor-mats' },
      { name: 'Защита картера', slug: 'skid-plates' },
      { name: 'Ветровики и брызговики', slug: 'wind-deflectors-mudflaps' },
      { name: 'Чехлы', slug: 'seat-covers' },
    ],
  },
  {
    friendlySlug: 'oil-motor',
    parentId: 'motor-oil',
    parentName: 'Моторные масла',
    // NO VISCOSITY NODES. "Масло 5W-30" and its siblings were retired (see
    // migrations/20260830020000_retire_viscosity_categories): a SAE grade is an
    // ATTRIBUTE of a listing (Product.oilViscosity), not a place in the tree —
    // one 5W-40 may be synthetic and another mineral, and it is the oil TYPE,
    // not the grade, that decides the MXIK. Re-adding one here would recreate
    // the very rows that migration deletes.
    //
    // Transmission oil stays: it is a product TYPE, not a grade.
    subs: [{ name: 'Трансмиссионное масло', slug: 'transmission-oil' }],
  },
  {
    friendlySlug: 'other',
    parentId: 'cat_uncategorized',
    parentName: 'Другое',
    subs: [
      { name: 'Крепеж и клипсы', slug: 'fasteners-and-clips' },
      { name: 'Щетки стеклоочистителя', slug: 'wiper-blades' },
    ],
  },
];

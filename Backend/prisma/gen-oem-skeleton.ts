/**
 * Generate a SKELETON price-list CSV covering every Chevrolet model × every one
 * of the 52 subcategories (520 rows). Titles are the real Russian subcategory
 * names + the model; `oemNumbers` and `priceUzs` (and `brand`) are LEFT EMPTY
 * for the supplier to fill. Once filled, import with `npm run seed:oem:csv`.
 *
 * The importer skips rows whose oemNumbers/priceUzs/brand are empty, so an
 * unfilled skeleton imports nothing — fill the rows you actually stock, delete
 * the rest, then import.
 *
 * Self-contained (no DB): the subcategory ru-titles mirror prisma/seed-category-
 * titles.ts. Run:  npm run gen:oem-skeleton   → writes prisma/data/oem-catalog-skeleton.csv
 */
import { writeFileSync } from 'fs';
import { resolve } from 'path';

/** Chevrolet UZ-market lineup — canonical names (what the garage sends as `model`). */
const MODELS = [
  'Cobalt', 'Gentra', 'Nexia', 'Spark', 'Tracker',
  'Malibu', 'Onix', 'Lacetti', 'Captiva', 'Damas',
];

/** The 52 subcategory slugs → Russian titles (mirrors seed-category-titles.ts). */
const SUBCATEGORIES: Array<{ slug: string; ru: string }> = [
  { slug: 'front-brake-pads', ru: 'Передние тормозные колодки' },
  { slug: 'rear-brake-pads', ru: 'Задние тормозные колодки' },
  { slug: 'brake-discs', ru: 'Тормозные диски' },
  { slug: 'brake-calipers-kits', ru: 'Суппорты и ремкомплекты' },
  { slug: 'brake-cylinders', ru: 'Тормозные цилиндры' },
  { slug: 'brake-hoses-cables', ru: 'Шланги и тросы' },
  { slug: 'shock-absorbers', ru: 'Амортизаторы' },
  { slug: 'springs-and-mounts', ru: 'Пружины и опоры' },
  { slug: 'stabilizer-links-bushings', ru: 'Стойки и втулки стабилизатора' },
  { slug: 'control-arms-bushings', ru: 'Рычаги и сайлентблоки' },
  { slug: 'ball-joints', ru: 'Шаровые опоры' },
  { slug: 'steering-racks-tie-rods', ru: 'Рулевые рейки и наконечники' },
  { slug: 'wheel-hubs-bearings', ru: 'Ступицы и подшипники' },
  { slug: 'timing-belt-kits', ru: 'Комплекты ГРМ и ролики' },
  { slug: 'accessory-drive-belts', ru: 'Ремни навесного оборудования' },
  { slug: 'gaskets-and-seals', ru: 'Прокладки и сальники' },
  { slug: 'piston-group', ru: 'Поршневая группа' },
  { slug: 'valves-and-cylinder-head', ru: 'Клапаны и ГБЦ' },
  { slug: 'engine-mounts', ru: 'Подушки двигателя' },
  { slug: 'cooling-radiators', ru: 'Радиаторы охлаждения' },
  { slug: 'heater-cores', ru: 'Радиаторы печки' },
  { slug: 'water-pumps', ru: 'Водяные помпы' },
  { slug: 'thermostats', ru: 'Термостаты' },
  { slug: 'coolant-hoses-tanks', ru: 'Патрубки и бачки' },
  { slug: 'cooling-fans', ru: 'Вентиляторы охлаждения' },
  { slug: 'oil-filters', ru: 'Масляные фильтры' },
  { slug: 'air-filters', ru: 'Воздушные фильтры' },
  { slug: 'cabin-filters', ru: 'Салонные фильтры' },
  { slug: 'fuel-filters', ru: 'Топливные фильтры' },
  { slug: 'antifreeze', ru: 'Антифризы' },
  { slug: 'technical-fluids', ru: 'Технические жидкости' },
  { slug: 'spark-plugs', ru: 'Свечи зажигания' },
  { slug: 'ignition-coils-wires', ru: 'Катушки и провода' },
  { slug: 'alternators', ru: 'Генераторы' },
  { slug: 'starters', ru: 'Стартеры' },
  { slug: 'engine-sensors', ru: 'Датчики двигателя' },
  { slug: 'headlights-and-bulbs', ru: 'Оптика и лампы' },
  { slug: 'clutch-kits', ru: 'Комплекты сцепления' },
  { slug: 'cv-joints-driveshafts', ru: 'ШРУСы и приводы' },
  { slug: 'cv-joint-boots', ru: 'Пыльники ШРУСа' },
  { slug: 'flywheels', ru: 'Маховики' },
  { slug: 'gear-linkages-cables', ru: 'Кулисы и тросы' },
  { slug: 'floor-mats', ru: 'Коврики' },
  { slug: 'skid-plates', ru: 'Защита картера' },
  { slug: 'wind-deflectors-mudflaps', ru: 'Ветровики и брызговики' },
  { slug: 'seat-covers', ru: 'Чехлы' },
  { slug: 'motor-oil-5w30', ru: 'Масло 5W-30' },
  { slug: 'motor-oil-5w40', ru: 'Масло 5W-40' },
  { slug: 'motor-oil-10w40', ru: 'Масло 10W-40' },
  { slug: 'transmission-oil', ru: 'Трансмиссионное масло' },
  { slug: 'fasteners-and-clips', ru: 'Крепеж и клипсы' },
  { slug: 'wiper-blades', ru: 'Щетки стеклоочистителя' },
];

/** Quote a CSV cell only when it contains a comma, quote or newline. */
function cell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const HEADER = ['title', 'brand', 'make', 'models', 'categorySlug', 'mainCategory', 'oemNumbers', 'priceUzs', 'stockQty', 'isOem'];

function main(): void {
  const lines: string[] = [HEADER.join(',')];
  for (const model of MODELS) {
    for (const { slug, ru } of SUBCATEGORIES) {
      lines.push(
        [
          cell(`${ru} ${model}`), // title
          '',                     // brand — supplier fills
          'Chevrolet',            // make
          cell(model),            // models
          slug,                   // categorySlug
          '',                     // mainCategory — importer derives from the category
          '',                     // oemNumbers — supplier fills
          '',                     // priceUzs — supplier fills
          '10',                   // stockQty
          'false',                // isOem
        ].join(','),
      );
    }
  }
  const out = resolve(__dirname, 'data/oem-catalog-skeleton.csv');
  writeFileSync(out, lines.join('\n') + '\n', 'utf8');
  // eslint-disable-next-line no-console
  console.log(`✓ wrote ${lines.length - 1} rows (${MODELS.length} models × ${SUBCATEGORIES.length} subcategories) → ${out}`);
}

main();

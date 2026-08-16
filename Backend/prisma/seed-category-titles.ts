/**
 * RE-RUNNABLE BACKFILL: localized titles (title_ru / title_uz) for the category
 * tree — the 10 system roots + the 52 seeded subcategories.
 *
 * The buyer app renders `title_uz` (uz) or `title_ru` (else), each falling back
 * to `name`. `name` is left untouched (canonical/legacy label). Idempotent:
 * every write is an `update` keyed on the stable id, so re-runs converge.
 *
 * Uzbek is in Latin script (the app's uz locale). Rows whose id is absent are
 * skipped with a note rather than created — this only annotates existing rows.
 *
 * Run:  npm run seed:category-titles
 *   (= ts-node --compiler-options '{"module":"commonjs"}' prisma/seed-category-titles.ts)
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** id → localized titles. Keys are the live category ids (roots + subcategories). */
const TITLES: Record<string, { ru: string; uz: string }> = {
  // ── Roots (level 0) ────────────────────────────────────────────────────────
  'brake-system': { ru: 'Тормозная система', uz: 'Tormoz tizimi' },
  'engine-system': { ru: 'Двигатель', uz: 'Dvigatel' },
  'suspension-and-steering': { ru: 'Подвеска и рулевое', uz: 'Osma va rul boshqaruvi' },
  transmission: { ru: 'Трансмиссия', uz: 'Transmissiya' },
  'heating-and-cooling': { ru: 'Отопление и охлаждение', uz: 'Isitish va sovutish' },
  'electrical-and-lighting': { ru: 'Электрика и освещение', uz: 'Elektr va yoritish' },
  'maintenance-and-fluids': { ru: 'ТО и жидкости', uz: 'Texnik xizmat va suyuqliklar' },
  'motor-oil': { ru: 'Моторные масла', uz: 'Motor moylari' },
  'tuning-and-accessories': { ru: 'Тюнинг и аксессуары', uz: 'Tyuning va aksessuarlar' },
  cat_uncategorized: { ru: 'Другое', uz: 'Boshqa' },

  // ── Brakes ─────────────────────────────────────────────────────────────────
  'front-brake-pads': { ru: 'Передние тормозные колодки', uz: 'Old tormoz kolodkalari' },
  'rear-brake-pads': { ru: 'Задние тормозные колодки', uz: 'Orqa tormoz kolodkalari' },
  'brake-discs': { ru: 'Тормозные диски', uz: 'Tormoz disklari' },
  'brake-calipers-kits': { ru: 'Суппорты и ремкомплекты', uz: "Supportlar va ta'mirlash to'plamlari" },
  'brake-cylinders': { ru: 'Тормозные цилиндры', uz: 'Tormoz silindrlari' },
  'brake-hoses-cables': { ru: 'Шланги и тросы', uz: 'Shlanglar va troslar' },

  // ── Suspension & steering ────────────────────────────────────────────────────
  'shock-absorbers': { ru: 'Амортизаторы', uz: 'Amortizatorlar' },
  'springs-and-mounts': { ru: 'Пружины и опоры', uz: 'Prujinalar va tayanchlar' },
  'stabilizer-links-bushings': { ru: 'Стойки и втулки стабилизатора', uz: 'Stabilizator stoykalari va vtulkalari' },
  'control-arms-bushings': { ru: 'Рычаги и сайлентблоки', uz: 'Richaglar va saylentbloklar' },
  'ball-joints': { ru: 'Шаровые опоры', uz: 'Sharsimon tayanchlar' },
  'steering-racks-tie-rods': { ru: 'Рулевые рейки и наконечники', uz: 'Rul reykalari va nakonechniklari' },
  'wheel-hubs-bearings': { ru: 'Ступицы и подшипники', uz: 'Stupitsalar va podshipniklar' },

  // ── Engine ───────────────────────────────────────────────────────────────────
  'timing-belt-kits': { ru: 'Комплекты ГРМ и ролики', uz: "GRM to'plamlari va roliklar" },
  'accessory-drive-belts': { ru: 'Ремни навесного оборудования', uz: 'Navesnoy uskunalar remenlari' },
  'gaskets-and-seals': { ru: 'Прокладки и сальники', uz: 'Prokladkalar va salniklar' },
  'piston-group': { ru: 'Поршневая группа', uz: 'Porshen guruhi' },
  'valves-and-cylinder-head': { ru: 'Клапаны и ГБЦ', uz: 'Klapanlar va silindr kallagi' },
  'engine-mounts': { ru: 'Подушки двигателя', uz: 'Dvigatel podushkalari' },

  // ── Heating & cooling ────────────────────────────────────────────────────────
  'cooling-radiators': { ru: 'Радиаторы охлаждения', uz: 'Sovutish radiatorlari' },
  'heater-cores': { ru: 'Радиаторы печки', uz: 'Pechka radiatorlari' },
  'water-pumps': { ru: 'Водяные помпы', uz: 'Suv pompalari' },
  thermostats: { ru: 'Термостаты', uz: 'Termostatlar' },
  'coolant-hoses-tanks': { ru: 'Патрубки и бачки', uz: 'Patrubkalar va bachoklar' },
  'cooling-fans': { ru: 'Вентиляторы охлаждения', uz: 'Sovutish ventilyatorlari' },

  // ── Maintenance & fluids ─────────────────────────────────────────────────────
  'oil-filters': { ru: 'Масляные фильтры', uz: 'Moy filtrlari' },
  'air-filters': { ru: 'Воздушные фильтры', uz: 'Havo filtrlari' },
  'cabin-filters': { ru: 'Салонные фильтры', uz: 'Salon filtrlari' },
  'fuel-filters': { ru: 'Топливные фильтры', uz: "Yoqilg'i filtrlari" },
  antifreeze: { ru: 'Антифризы', uz: 'Antifrizlar' },
  'technical-fluids': { ru: 'Технические жидкости', uz: 'Texnik suyuqliklar' },

  // ── Electrical & lighting ────────────────────────────────────────────────────
  'spark-plugs': { ru: 'Свечи зажигания', uz: 'Uchqun svechalari' },
  'ignition-coils-wires': { ru: 'Катушки и провода', uz: 'Katushkalar va simlar' },
  alternators: { ru: 'Генераторы', uz: 'Generatorlar' },
  starters: { ru: 'Стартеры', uz: 'Starterlar' },
  'engine-sensors': { ru: 'Датчики двигателя', uz: 'Dvigatel datchiklari' },
  'headlights-and-bulbs': { ru: 'Оптика и лампы', uz: 'Faralar va chiroqlar' },

  // ── Transmission ─────────────────────────────────────────────────────────────
  'clutch-kits': { ru: 'Комплекты сцепления', uz: "Sseplenie to'plamlari" },
  'cv-joints-driveshafts': { ru: 'ШРУСы и приводы', uz: 'Granatalar va privodlar' },
  'cv-joint-boots': { ru: 'Пыльники ШРУСа', uz: 'Granata pilniklari' },
  flywheels: { ru: 'Маховики', uz: 'Mahoviklar' },
  'gear-linkages-cables': { ru: 'Кулисы и тросы', uz: 'Kulisalar va troslar' },

  // ── Tuning & accessories ─────────────────────────────────────────────────────
  'floor-mats': { ru: 'Коврики', uz: 'Gilamchalar' },
  'skid-plates': { ru: 'Защита картера', uz: 'Karter himoyasi' },
  'wind-deflectors-mudflaps': { ru: 'Ветровики и брызговики', uz: "Shamol deflektorlari va loyqaytargichlar" },
  'seat-covers': { ru: 'Чехлы', uz: 'Chexollar' },

  // ── Motor oil ────────────────────────────────────────────────────────────────
  'motor-oil-5w30': { ru: 'Масло 5W-30', uz: '5W-30 moy' },
  'motor-oil-5w40': { ru: 'Масло 5W-40', uz: '5W-40 moy' },
  'motor-oil-10w40': { ru: 'Масло 10W-40', uz: '10W-40 moy' },
  'transmission-oil': { ru: 'Трансмиссионное масло', uz: 'Transmissiya moyi' },

  // ── Other ────────────────────────────────────────────────────────────────────
  'fasteners-and-clips': { ru: 'Крепеж и клипсы', uz: 'Mahkamlagichlar va klipsalar' },
  'wiper-blades': { ru: 'Щетки стеклоочистителя', uz: "Oyna tozalagich cho'tkalari" },
};

async function main(): Promise<void> {
  console.log(`Backfilling titles for ${Object.keys(TITLES).length} categories…\n`);
  let updated = 0;
  let missing = 0;

  for (const [id, { ru, uz }] of Object.entries(TITLES)) {
    const exists = await prisma.partCategory.findUnique({ where: { id }, select: { id: true } });
    if (!exists) {
      console.log(`  · skip ${id} — not present`);
      missing++;
      continue;
    }
    await prisma.partCategory.update({ where: { id }, data: { titleRu: ru, titleUz: uz } });
    updated++;
  }

  console.log(`\nDone. ${updated} categories localized, ${missing} skipped (absent).`);
  console.log('Reference caches expire within 300s; force with: redis-cli DEL cache:reference:categories');
}

main()
  .catch((err) => {
    console.error('seed-category-titles FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

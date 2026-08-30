/**
 * Second-level (subcategory) classifier.
 *
 * The main {@link part-classifier} maps a part's text to one of the 12
 * PartMainCategory buckets. This one goes a level deeper: it maps the same text
 * to one of the seeded PartCategory SUBCATEGORY leaves (front-brake-pads,
 * oil-filters, …), so parts can be filed into the browse taxonomy instead of the
 * bucket.
 *
 * Matching mirrors the main classifier: keywords are lowercase, substring-based
 * and scored (a longer, more specific keyword scores higher). A `rootHint`
 * (the part's system root, e.g. 'brake-system') scopes scoring to that root's
 * subcategories first — only if nothing matches there does it fall back to a
 * global best, so a mis-tagged root can't strand a part. Returns null when
 * nothing scores: the caller then leaves the part where it is.
 *
 * Keep SUBCATEGORY_RULES in sync with the seeded subcategories
 * (prisma/seed-categories.ts). ids/roots must match live PartCategory rows.
 */

export interface SubcategoryRule {
  /** The subcategory leaf id (= its PartCategory id/slug). */
  id: string;
  /** The root (level-0 system) this subcategory lives under. */
  root: string;
  /** Lowercase ru/en/uz-latin keywords; substring-matched and length-scored. */
  keywords: string[];
}

export const SUBCATEGORY_RULES: SubcategoryRule[] = [
  { id: 'front-brake-pads', root: 'brake-system', keywords: ['передние тормозные колодки', 'передние колодки', 'перед колодки', 'колодки передние', 'тормозные колодки перед', 'front brake pad', 'front pads', 'oldingi kolodka', 'oldingi tormoz kolodka', 'перед колодка', 'brake pad front', 'передний тормоз колодка', 'old kolodka'] },
  { id: 'rear-brake-pads', root: 'brake-system', keywords: ['задние тормозные колодки', 'задние колодки', 'зад колодки', 'колодки задние', 'тормозные колодки зад', 'rear brake pad', 'rear pads', 'orqa kolodka', 'orqa tormoz kolodka', 'зад колодка', 'brake pad rear', 'задний тормоз колодка', 'orqa tomon kolodka'] },
  { id: 'brake-discs', root: 'brake-system', keywords: ['тормозные диски', 'тормозной диск', 'диск тормозной', 'тормоз диск', 'brake disc', 'brake rotor', 'brake disk', 'tormoz disk', 'disk tormoz', 'передний тормозной диск', 'задний тормозной диск', 'вентилируемый диск'] },
  { id: 'brake-calipers-kits', root: 'brake-system', keywords: ['суппорт', 'тормозной суппорт', 'ремкомплект суппорта', 'суппорты', 'brake caliper', 'caliper kit', 'caliper', 'суппорт ремкомплект', 'поршень суппорта', 'support tormoz', 'suport', 'направляющие суппорта', 'ремкомплект тормозного суппорта'] },
  { id: 'brake-cylinders', root: 'brake-system', keywords: ['тормозной цилиндр', 'главный тормозной цилиндр', 'рабочий цилиндр', 'гтц', 'brake cylinder', 'master cylinder', 'wheel cylinder', 'цилиндр тормозной', 'tormoz silindr', 'рабочий тормозной цилиндр', 'silindr tormoz'] },
  { id: 'brake-hoses-cables', root: 'brake-system', keywords: ['тормозной шланг', 'тормозные шланги', 'тормозной трос', 'трос ручника', 'brake hose', 'brake cable', 'handbrake cable', 'шланг тормозной', 'трос стояночного тормоза', 'tormoz shlang', 'tormoz tros', 'трос ручного тормоза', 'шланг тормоза'] },
  { id: 'shock-absorbers', root: 'suspension-and-steering', keywords: ['амортизатор', 'амортизаторы', 'аммортизатор', 'amartizator', 'shock absorber', 'shock', 'передний амортизатор', 'задний амортизатор', 'amortizator', 'стойка амортизатора', 'газовый амортизатор', 'масляный амортизатор', 'damper'] },
  { id: 'springs-and-mounts', root: 'suspension-and-steering', keywords: ['пружина', 'пружины', 'опора стойки', 'опора амортизатора', 'spring', 'coil spring', 'strut mount', 'пружина подвески', 'верхняя опора', 'prujina', 'опорный подшипник', 'чашка пружины'] },
  { id: 'stabilizer-links-bushings', root: 'suspension-and-steering', keywords: ['стойка стабилизатора', 'втулка стабилизатора', 'линк стабилизатора', 'стабилизатор', 'stabilizer link', 'sway bar link', 'stabilizer bushing', 'тяга стабилизатора', 'stabilizator', 'втулки стабилизатора', 'косточка стабилизатора'] },
  { id: 'control-arms-bushings', root: 'suspension-and-steering', keywords: ['рычаг', 'рычаг подвески', 'сайлентблок', 'сайлентблоки', 'control arm', 'wishbone', 'control arm bushing', 'нижний рычаг', 'верхний рычаг', 'richag', 'saylentblok', 'рычаг передний', 'сайлент блок'] },
  { id: 'ball-joints', root: 'suspension-and-steering', keywords: ['шаровая опора', 'шаровая', 'шаровые опоры', 'ball joint', 'sharovaya', 'шаровой шарнир', 'опора шаровая', 'sharoviy', 'нижняя шаровая', 'верхняя шаровая', 'шаровая опора рычага'] },
  { id: 'steering-racks-tie-rods', root: 'suspension-and-steering', keywords: ['рулевая рейка', 'рулевой наконечник', 'рулевая тяга', 'наконечник рулевой', 'steering rack', 'tie rod', 'tie rod end', 'rulevaya reyka', 'наконечник рулевой тяги', 'rulevoy nakonechnik', 'рейка рулевая', 'тяга рулевая'] },
  { id: 'wheel-hubs-bearings', root: 'suspension-and-steering', keywords: ['ступица', 'ступичный подшипник', 'подшипник ступицы', 'ступицы', 'wheel hub', 'wheel bearing', 'hub bearing', 'подшипник ступичный', 'stupitsa', 'podshipnik stupitsa', 'ступичный узел', 'передняя ступица', 'задняя ступица'] },
  { id: 'timing-belt-kits', root: 'engine-system', keywords: ['ремень грм', 'комплект грм', 'ролик грм', 'timing belt', 'timing belt kit', 'timing roller', 'ремень газораспределения', 'grm remen', 'натяжной ролик грм', 'grm komplekt', 'цепь грм', 'ролик натяжной'] },
  { id: 'accessory-drive-belts', root: 'engine-system', keywords: ['ремень навесного', 'приводной ремень', 'ремень генератора', 'поликлиновой ремень', 'drive belt', 'serpentine belt', 'accessory belt', 'ремень кондиционера', 'ручейковый ремень', 'remen generator', 'приводной ремень навесного', 'belt v-ribbed'] },
  { id: 'gaskets-and-seals', root: 'engine-system', keywords: ['прокладка', 'сальник', 'прокладки', 'сальники', 'gasket', 'seal', 'oil seal', 'прокладка гбц', 'сальник коленвала', 'prokladka', 'salnik', 'прокладка клапанной крышки', 'прокладка головки'] },
  { id: 'piston-group', root: 'engine-system', keywords: ['поршень', 'поршневая группа', 'кольца поршневые', 'поршни', 'piston', 'piston ring', 'piston group', 'поршневые кольца', 'гильза цилиндра', 'porshen', 'палец поршневой', 'поршневой'] },
  { id: 'valves-and-cylinder-head', root: 'engine-system', keywords: ['клапан', 'гбц', 'клапаны', 'головка блока', 'valve', 'cylinder head', 'engine valve', 'головка блока цилиндров', 'впускной клапан', 'выпускной клапан', 'klapan', 'распредвал гбц'] },
  { id: 'engine-mounts', root: 'engine-system', keywords: ['подушка двигателя', 'опора двигателя', 'подушки двигателя', 'подушка мотора', 'engine mount', 'motor mount', 'opora dvigatelya', 'подушка двс', 'podushka dvigatel', 'опора мотора', 'dvigatel podushka', 'подушка коробки'] },
  { id: 'cooling-radiators', root: 'heating-and-cooling', keywords: ['радиатор охлаждения', 'радиатор двигателя', 'основной радиатор', 'cooling radiator', 'engine radiator', 'радиатор охлаждения двигателя', 'radiator ohlazhdeniya', 'радиатор антифриза', 'sovutish radiator', 'радиатор дв'] },
  { id: 'heater-cores', root: 'heating-and-cooling', keywords: ['радиатор печки', 'печка радиатор', 'радиатор отопителя', 'heater core', 'heater radiator', 'радиатор печка', 'otopitel radiator', 'pechka radiator', 'радиатор салона', 'радиатор обогрева', 'печной радиатор'] },
  { id: 'water-pumps', root: 'heating-and-cooling', keywords: ['помпа', 'водяная помпа', 'водяной насос', 'помпа охлаждения', 'water pump', 'coolant pump', 'pompa', 'vodyanaya pompa', 'насос охлаждения', 'помпа водяная', 'suv pompa', 'помпа двигателя'] },
  { id: 'thermostats', root: 'heating-and-cooling', keywords: ['термостат', 'термостаты', 'термостат в сборе', 'thermostat', 'termostat', 'корпус термостата', 'термостат охлаждения', 'thermostat housing', 'термостат двигателя', 'termostat korpus', 'крышка термостата'] },
  { id: 'coolant-hoses-tanks', root: 'heating-and-cooling', keywords: ['патрубок', 'расширительный бачок', 'патрубки', 'бачок охлаждения', 'coolant hose', 'expansion tank', 'radiator hose', 'патрубок радиатора', 'бачок расширительный', 'patrubok', 'bachok', 'шланг охлаждения', 'патрубок системы охлаждения'] },
  { id: 'cooling-fans', root: 'heating-and-cooling', keywords: ['вентилятор охлаждения', 'вентилятор радиатора', 'вентилятор', 'крыльчатка', 'cooling fan', 'radiator fan', 'ventilyator', 'мотор вентилятора', 'ventilyator ohlazhdeniya', 'диффузор вентилятора', 'вентилятор двигателя'] },
  { id: 'oil-filters', root: 'maintenance-and-fluids', keywords: ['масляный фильтр', 'фильтр масляный', 'масляные фильтры', 'фильтр масла', 'oil filter', 'moy filtr', 'maslyaniy filtr', 'фильтр моторного масла', 'фильтр для масла', 'moyli filtr', 'oil filtr', 'масл фильтр'] },
  { id: 'air-filters', root: 'maintenance-and-fluids', keywords: ['воздушный фильтр', 'фильтр воздушный', 'воздушные фильтры', 'фильтр воздуха', 'air filter', 'vozdushniy filtr', 'havo filtr', 'фильтр двигателя воздушный', 'air filtr', 'havo filtri', 'воздушн фильтр'] },
  { id: 'cabin-filters', root: 'maintenance-and-fluids', keywords: ['салонный фильтр', 'фильтр салона', 'салонные фильтры', 'фильтр салонный', 'cabin filter', 'salon filtr', 'salonniy filtr', 'фильтр кондиционера салон', 'угольный фильтр салона', 'salon filtri', 'pollen filter', 'фильтр печки салон'] },
  { id: 'fuel-filters', root: 'maintenance-and-fluids', keywords: ['топливный фильтр', 'фильтр топливный', 'топливные фильтры', 'фильтр топлива', 'fuel filter', 'toplivniy filtr', 'yoqilgi filtr', 'фильтр бензонасоса', 'фильтр грубой очистки топлива', 'yonilgi filtr', 'benzin filtr', 'fuel filtr'] },
  { id: 'antifreeze', root: 'maintenance-and-fluids', keywords: ['антифриз', 'антифризы', 'охлаждающая жидкость', 'тосол', 'antifreeze', 'coolant', 'antifriz', 'антифриз красный', 'антифриз зеленый', 'ohlazhdayushchaya jidkost', 'g12', 'антифриз концентрат', 'tosol'] },
  { id: 'technical-fluids', root: 'maintenance-and-fluids', keywords: ['тормозная жидкость', 'жидкость гур', 'техническая жидкость', 'омывайка', 'brake fluid', 'power steering fluid', 'technical fluid', 'жидкость гидроусилителя', 'dot4', 'tormoz jidkost', 'жидкость сцепления', 'жидкость омывателя', 'жидкость стеклоомывателя'] },
  { id: 'spark-plugs', root: 'electrical-and-lighting', keywords: ['свеча зажигания', 'свечи зажигания', 'свечи', 'свеча', 'spark plug', 'svecha', 'iridievye svechi', 'иридиевые свечи', 'sham', 'свеча накала', 'spark plug iridium', 'свечи зажигания комплект', 'svechi'] },
  { id: 'ignition-coils-wires', root: 'electrical-and-lighting', keywords: ['катушка зажигания', 'высоковольтные провода', 'провода зажигания', 'катушка', 'ignition coil', 'spark plug wire', 'katushka zajiganiya', 'бронепровода', 'модуль зажигания', 'katushka', 'провода высоковольтные'] },
  { id: 'alternators', root: 'electrical-and-lighting', keywords: ['генератор', 'генераторы', 'щетки генератора', 'регулятор напряжения', 'alternator', 'generator', 'generator zaryadka', 'шкив генератора', 'генератор в сборе', 'diode bridge', 'obmotka generator'] },
  { id: 'starters', root: 'electrical-and-lighting', keywords: ['стартер', 'стартеры', 'бендикс', 'втягивающее реле', 'starter', 'starter motor', 'starter rele', 'бендикс стартера', 'реле стартера', 'щетки стартера', 'стартер в сборе'] },
  { id: 'engine-sensors', root: 'electrical-and-lighting', keywords: ['датчик двигателя', 'датчик коленвала', 'датчик кислорода', 'лямбда зонд', 'engine sensor', 'abs sensor', 'датчик распредвала', 'датчик детонации', 'datchik', 'лямбда', 'датчик температуры двигателя', 'датчик положения', 'sensor dvigatel'] },
  { id: 'headlights-and-bulbs', root: 'electrical-and-lighting', keywords: ['фара', 'лампа', 'оптика', 'лампочка', 'headlight', 'bulb', 'led lamp', 'передняя фара', 'лампа галогенная', 'fara', 'lampochka', 'ксенон лампа', 'габаритная лампа'] },
  { id: 'clutch-kits', root: 'transmission', keywords: ['сцепление', 'комплект сцепления', 'диск сцепления', 'корзина сцепления', 'clutch kit', 'clutch disc', 'clutch', 'выжимной подшипник', 'stseplenie komplekt', 'sceplenie', 'clutch komplekt', 'муфта сцепления'] },
  { id: 'cv-joints-driveshafts', root: 'transmission', keywords: ['шрус', 'привод', 'приводной вал', 'граната', 'cv joint', 'driveshaft', 'shrus', 'наружный шрус', 'внутренний шрус', 'privod', 'полуось', 'шрус наружный'] },
  { id: 'cv-joint-boots', root: 'transmission', keywords: ['пыльник шруса', 'пыльник привода', 'пыльник гранаты', 'пыльник', 'cv boot', 'cv joint boot', 'shrus pylnik', 'пыльник наружного шруса', 'pylnik shrus', 'пыльник внутренний', 'chexol shrus', 'пыльник шрус наружный'] },
  { id: 'flywheels', root: 'transmission', keywords: ['маховик', 'маховики', 'демпферный маховик', 'двухмассовый маховик', 'flywheel', 'dual mass flywheel', 'mahovik', 'венец маховика', 'маховик в сборе', 'flywheel dual', 'маховик двс'] },
  { id: 'gear-linkages-cables', root: 'transmission', keywords: ['кулиса', 'трос кпп', 'тросы переключения', 'механизм переключения', 'gear linkage', 'shift cable', 'kulisa', 'трос переключения передач', 'тяга кулисы', 'shift linkage', 'kpp tros', 'трос коробки передач'] },
  { id: 'floor-mats', root: 'tuning-and-accessories', keywords: ['коврик', 'коврики', 'коврики в салон', 'коврик салонный', 'floor mat', 'car mat', 'kovrik', 'резиновые коврики', 'eva коврики', 'коврики автомобильные', 'polik', 'коврик багажника'] },
  { id: 'skid-plates', root: 'tuning-and-accessories', keywords: ['защита картера', 'защита двигателя', 'защита поддона', 'картер защита', 'skid plate', 'engine guard', 'zashita kartera', 'защита двс', 'стальная защита картера', 'himoya kartera', 'защита картера двигателя'] },
  { id: 'wind-deflectors-mudflaps', root: 'tuning-and-accessories', keywords: ['ветровик', 'брызговик', 'ветровики', 'брызговики', 'wind deflector', 'mud flap', 'vetrovik', 'дефлектор окна', 'bryzgovik', 'дефлекторы окон', 'mud guard', 'ветровики на окна'] },
  { id: 'seat-covers', root: 'tuning-and-accessories', keywords: ['чехлы', 'чехлы на сиденья', 'авточехлы', 'чехол сиденья', 'seat cover', 'seat covers', 'chexol', 'чехлы модельные', 'чехлы сидений', 'chexol sedeniya', 'накидка на сиденье', 'чехлы автомобильные'] },
  { id: 'transmission-oil', root: 'motor-oil', keywords: ['трансмиссионное масло', 'масло кпп', 'масло в коробку', 'масло акпп', 'transmission oil', 'gear oil', 'atf', 'масло трансмиссионное', '75w90', 'transmission moyi', 'масло мкпп', 'масло для коробки передач'] },
  { id: 'fasteners-and-clips', root: 'cat_uncategorized', keywords: ['крепеж', 'клипса', 'клипсы', 'пистоны', 'fastener', 'clip', 'krepej', 'клипсы обшивки', 'pistony', 'клипса бампера', 'саморез'] },
  { id: 'wiper-blades', root: 'cat_uncategorized', keywords: ['щетки стеклоочистителя', 'дворники', 'щетка стеклоочистителя', 'щетки дворников', 'wiper blade', 'wiper', 'dvorniki', 'щетки дворники', 'стеклоочиститель', 'shetki', 'бескаркасные дворники', 'щетка дворника'] },
];

/** Every subcategory leaf id — used to tell "already on a sub" from "on a bucket/root". */
export const SUBCATEGORY_IDS: ReadonlySet<string> = new Set(
  SUBCATEGORY_RULES.map((r) => r.id),
);

export interface SubMatch {
  id: string;
  root: string;
  score: number;
}

/**
 * The motor-oil grade named by `text`, or null.
 *
 * Re-exported here — beside the subcategory rules — because it REPLACES three of
 * them. "масло 5W-40" used to classify to a `motor-oil-5w40` CATEGORY; those
 * nodes are retired, so the same text now yields an ATTRIBUTE and the listing
 * stays on `motor-oil`:
 *
 *     classifyOilViscosity('масло 5W-40')  →  '5W-40'   (Product.oilViscosity)
 *     classifySubcategory('масло 5W-40')   →  null      (no category to move to)
 *
 * The recognition itself is unchanged vocabulary — it just has a new destination.
 * The oil TYPE is NOT derived here: "синтетика 5w30" names a grade for certain,
 * while its base composition decides the MXIK and must come from the seller.
 */
export { extractViscosity as classifyOilViscosity } from '../telegram/motor-oil-catalog';

/**
 * Best subcategory for `text`, scoped to `rootHint` first when given.
 * Returns null when no keyword matches.
 *
 * VISCOSITY IS NOT A SUBCATEGORY. The three `motor-oil-5w*` rules were removed
 * with their categories; use {@link classifyOilViscosity} for the grade. A
 * motor-oil listing therefore classifies to `transmission-oil` or to nothing,
 * and "nothing" correctly leaves it on `motor-oil`.
 */
export function classifySubcategory(
  text: string,
  rootHint?: string | null,
): SubMatch | null {
  const hay = ` ${text.toLowerCase()} `;
  const scoreRule = (rule: SubcategoryRule): number => {
    let s = 0;
    for (const kw of rule.keywords) if (kw && hay.includes(kw)) s += kw.length;
    return s;
  };
  const pick = (rules: SubcategoryRule[]): SubMatch | null => {
    let best: SubMatch | null = null;
    for (const r of rules) {
      const s = scoreRule(r);
      if (s > 0 && (!best || s > best.score)) best = { id: r.id, root: r.root, score: s };
    }
    return best;
  };

  if (rootHint) {
    const scoped = pick(SUBCATEGORY_RULES.filter((r) => r.root === rootHint));
    if (scoped) return scoped;
  }
  return pick(SUBCATEGORY_RULES);
}

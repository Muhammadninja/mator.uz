/**
 * Cross-language part-term synonyms for the sourcing RAG.
 *
 * The catalog titles are Russian, but customers write in Russian, Uzbek-Latin,
 * Uzbek-Cyrillic or English ("тормозные колодки" vs "tormoz kolodkalari" vs
 * "brake pads"). A raw substring/token match against a Russian title therefore
 * finds NOTHING for an Uzbek or English query, so an in-stock part wrongly opens
 * a sourcing ticket.
 *
 * This maps each surface form of a common auto-part term to the whole synonym
 * group, so a single query token is expanded to every language's spelling before
 * it hits the catalog. Deliberately small and hand-curated (the catalog is
 * small); the scalable path is a translated/normalized search column — see the
 * AI-sourcing follow-ups.
 */

/**
 * Each row is one concept; every entry is a lowercase surface form across RU /
 * UZ-Latin / UZ-Cyrillic / EN. Order inside a row is irrelevant. Keep forms as
 * SUBSTRINGS that appear in real titles ("колодк" matches "колодки"/"колодка").
 */
const SYNONYM_GROUPS: string[][] = [
  // brake pads
  ['колодк', 'калодк', 'тормозн', 'тормоз', 'kolodka', 'kolodkalari', 'kolodkasi', 'tormoz', 'pads', 'brake', 'brakes'],
  // engine oil
  ['масло', 'мотор', 'моторн', 'moy', 'moyi', 'мойи', 'мой', 'oil', 'maslo', 'moslo'],
  // oil/air/fuel filter
  ['фильтр', 'фильтер', 'filtr', 'filter', 'suzgich', 'сузгич'],
  // shock absorber / strut
  ['амортизатор', 'amortizator', 'shock', 'stoyka', 'стойк'],
  // steering wheel / rack
  ['руль', 'рул', 'rul', 'ruli', 'steering'],
  // battery
  ['аккумулятор', 'акумулятор', 'akkumulyator', 'batareya', 'батаре', 'battery'],
  // spark plug
  ['свеч', 'svecha', 'svechi', 'spark', 'uchqun'],
  // belt (timing / drive)
  ['ремень', 'ремн', 'remen', 'kamar', 'belt'],
  // tire
  ['шина', 'покрышк', 'shina', 'tire', 'tyre', 'ballon', 'баллон'],
  // brake disc / rotor
  ['диск', 'disk', 'rotor', 'ротор'],
  // radiator
  ['радиатор', 'radiator'],
  // pump (water / fuel)
  ['насос', 'nasos', 'pompa', 'pump'],
  // clutch
  ['сцеплен', 'stseplenie', 'clutch'],
  // headlight / lamp
  ['фара', 'фар', 'fara', 'headlight', 'chiroq'],
  // bumper
  ['бампер', 'bamper', 'bumper'],
  // mirror
  ['зеркал', 'oyna', 'ойна', 'mirror'],
  // positional — front (helps titles like "Колодки передние")
  ['передн', 'перед', 'oldi', 'oldingi', 'old', 'front'],
  // positional — rear
  ['задн', 'зад', 'orqa', 'orqadagi', 'rear', 'back'],
];

/** form → its group (built once). */
const FORM_TO_GROUP = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) {
  for (const form of group) FORM_TO_GROUP.set(form, group);
}

/**
 * Expand one query token to every search form it should match on. Returns the
 * token itself plus all cross-language synonyms of any group it belongs to
 * (matched by prefix so inflected forms like "kolodkalari" resolve). Always
 * includes the original token so unknown parts still match by themselves.
 */
export function expandToken(token: string): string[] {
  const t = token.toLowerCase();
  const forms = new Set<string>([t]);
  // A token matches a group if it starts with, or is contained by, any known
  // form — so "kolodkalari" (declined) still resolves via the "kolodka" form.
  for (const [form, group] of FORM_TO_GROUP) {
    if (t === form || t.startsWith(form) || form.startsWith(t) || t.includes(form)) {
      for (const g of group) forms.add(g);
    }
  }
  return Array.from(forms);
}

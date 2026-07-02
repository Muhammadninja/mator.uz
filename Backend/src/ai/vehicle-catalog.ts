// src/ai/vehicle-catalog.ts
//
// Local, offline dictionary of car brands and models with aliases.
// Single source of truth for rule-based parsing and sanitization.
// The AI fallback must NOT look anything up on the internet — known
// brands/models are resolved here first.

export interface CatalogModel {
  /** Canonical model name, e.g. "Cobalt". */
  canonical: string;
  /** Lowercased aliases (latin + cyrillic + common typos), no canonical form. */
  aliases: string[];
}

export interface CatalogBrand {
  /** Canonical brand name, e.g. "Chevrolet". */
  canonical: string;
  /** Lowercased aliases for the brand name itself. */
  aliases: string[];
  /** Models that belong to this brand. */
  models: CatalogModel[];
}

// ── Brand + model dictionary ────────────────────────────────────────────────
// Aliases are always lowercase. The canonical form is matched case-insensitively
// in addition to the aliases, so it never needs to be repeated in `aliases`.
export const VEHICLE_CATALOG: CatalogBrand[] = [
  {
    canonical: 'Chevrolet',
    aliases: ['chevrolet', 'chevy', 'шевроле', 'шеврале', 'шевролет', 'шевралет', 'шевролэт', 'шевролит', 'шевролетт'],
    models: [
      { canonical: 'Cobalt', aliases: ['cobalt', 'кобальт', 'koblt', 'cobolt', 'kobalt', 'кобалт'] },
      { canonical: 'Spark', aliases: ['spark', 'спарк'] },
      { canonical: 'Nexia 3', aliases: ['nexia 3', 'nexia3', 'нексия 3', 'нексия3', 'некся 3'] },
      { canonical: 'Nexia 2', aliases: ['nexia 2', 'nexia2', 'нексия 2', 'нексия2', 'некся 2'] },
      { canonical: 'Damas', aliases: ['damas', 'дамас', 'damass', 'дамаз'] },
      { canonical: 'Labo', aliases: ['labo', 'лабо', 'labbo'] },
      { canonical: 'Lacetti (Gentra)', aliases: ['lacetti', 'лачетти', 'лачети', 'laceti', 'lachetti', 'gentra', 'джентра', 'гентра', 'жентра', 'jentra'] },
      { canonical: 'Matiz', aliases: ['matiz', 'матиз', 'matis', 'матис'] },
      { canonical: 'Captiva', aliases: ['captiva', 'каптива', 'kaptiva'] },
      { canonical: 'Tracker', aliases: ['tracker', 'трекер', 'treker'] },
      { canonical: 'Equinox', aliases: ['equinox', 'эквинокс', 'ekvinoks'] },
      { canonical: 'Malibu', aliases: ['malibu', 'малибу', 'malebu'] },
      { canonical: 'Cruze', aliases: ['cruze', 'круз', 'kruz', 'cruz'] },
      { canonical: 'Orlando', aliases: ['orlando', 'орландо', 'orland'] },
      { canonical: 'Onix', aliases: ['onix', 'оникс', 'oniks'] },
      { canonical: 'Tahoe', aliases: ['tahoe', 'тахо', 'taho'] },
      { canonical: 'Trailblazer', aliases: ['trailblazer', 'трейлблейзер', 'treylbleyzer'] },
    ],
  },
  {
    canonical: 'Daewoo',
    aliases: ['daewoo', 'дэу', 'део', 'daewo'],
    models: [
      { canonical: 'Nexia 1', aliases: ['nexia 1', 'nexia1', 'нексия 1', 'нексия1', 'некся 1', 'neksya 1', 'neksya1', 'nexia', 'нексия'] },
      { canonical: 'Nexia 2', aliases: ['nexia 2', 'nexia2', 'нексия 2', 'нексия2', 'некся 2', 'neksya 2', 'neksya2'] },
      { canonical: 'Gentra', aliases: ['gentra', 'джентра', 'гентра', 'жентра', 'jentra'] },    
      { canonical: 'Matiz', aliases: ['matiz', 'матиз'] },
      { canonical: 'Damas', aliases: ['damas', 'дамас'] },
      { canonical: 'Lanos', aliases: ['lanos', 'ланос'] },
      { canonical: 'Tico', aliases: ['tico', 'тико'] },
    ],
  },
  {
    canonical: 'Ravon',
    aliases: ['ravon', 'равон'],
    models: [
      { canonical: 'R2 (Spark)', aliases: ['r2', 'р2', 'spark', 'спарк'] },
      { canonical: 'R3 (Nexia)', aliases: ['r3', 'р3', 'nexia r3', 'нексия r3', 'neksya r3', 'нексия', 'neksya', 'nexia'] },
      { canonical: 'R4 (Cobalt)', aliases: ['r4', 'р4', 'cobalt', 'кобальт'] },
      { canonical: 'Gentra', aliases: ['gentra', 'джентра', 'гентра', 'жентра', 'jentra'] },
      { canonical: 'Matiz', aliases: ['matiz', 'матиз'] },
    ],
  },
  {
    canonical: 'Hyundai',
    aliases: ['hyundai', 'хендай', 'хундай', 'хёндэ', 'hunday'],
    models: [
      { canonical: 'Elantra', aliases: ['elantra', 'элантра'] },
      { canonical: 'Sonata', aliases: ['sonata', 'соната'] },
      { canonical: 'Accent', aliases: ['accent', 'акцент', 'aksent'] },
      { canonical: 'Azera', aliases: ['azera', 'азера'] },
      { canonical: 'Tucson', aliases: ['tucson', 'туксон', 'takson'] },
      { canonical: 'Santa Fe', aliases: ['santa fe', 'santafe', 'санта фе', 'санафе'] },
      { canonical: 'Palisade', aliases: ['palisade', 'палисад', 'палисейд'] },
      { canonical: 'Creta', aliases: ['creta', 'крета'] },
      { canonical: 'Staria', aliases: ['staria', 'стария'] },
      { canonical: 'H-1', aliases: ['h-1', 'h1', 'аш1'] },
      { canonical: 'Ioniq 5', aliases: ['ioniq 5', 'ioniq5', 'иоником 5', 'ионик 5'] },
      { canonical: 'Ioniq 6', aliases: ['ioniq 6', 'ioniq6', 'ионик 6'] },
      { canonical: 'Solaris', aliases: ['solaris', 'солярис'] },
    ],
  },
  {
    canonical: 'Kia',
    aliases: ['kia', 'киа', 'кия'],
    models: [
      { canonical: 'K3', aliases: ['k3', 'к3'] },
      { canonical: 'K4', aliases: ['k4', 'к4'] },
      { canonical: 'K5', aliases: ['k5', 'к5'] },
      { canonical: 'K7', aliases: ['k7', 'к7'] },
      { canonical: 'K8', aliases: ['k8', 'к8'] },
      { canonical: 'K9', aliases: ['k9', 'к9'] },
      { canonical: 'Cerato', aliases: ['cerato', 'церато', 'serato'] },
      { canonical: 'Rio', aliases: ['rio', 'рио'] },
      { canonical: 'Seltos', aliases: ['seltos', 'селтос'] },
      { canonical: 'Sportage', aliases: ['sportage', 'спортейдж', 'sportej'] },
      { canonical: 'Sorento', aliases: ['sorento', 'соренто'] },
      { canonical: 'Mohave', aliases: ['mohave', 'мохаве'] },
      { canonical: 'Telluride', aliases: ['telluride', 'теллурайд'] },
      { canonical: 'Carnival', aliases: ['carnival', 'карнивал'] },
      { canonical: 'EV5', aliases: ['ev5'] },
      { canonical: 'EV6', aliases: ['ev6'] },
      { canonical: 'EV9', aliases: ['ev9'] },
      { canonical: 'Soul', aliases: ['soul', 'соул'] },
      { canonical: 'Sonet', aliases: ['sonet', 'сонет', 'сонэт'] },
      { canonical: 'Optima', aliases: ['optima', 'оптима'] },
    ],
  },
  {
    canonical: 'Toyota',
    aliases: ['toyota', 'тойота', 'tayota'],
    models: [
      { canonical: 'Corolla Cross', aliases: ['corolla cross', 'королла кросс'] },
      { canonical: 'Corolla', aliases: ['corolla', 'королла', 'corola', 'карола'] },
      { canonical: 'Camry', aliases: ['camry', 'камри', 'kamri'] },
      { canonical: 'RAV4', aliases: ['rav4', 'rav 4', 'рав4', 'рав 4'] },
      { canonical: 'Highlander', aliases: ['highlander', 'хайлендер'] },
      { canonical: 'Land Cruiser Prado', aliases: ['land cruiser prado', 'lc prado', 'ленд крузер прадо'] },
      { canonical: 'Land Cruiser 200', aliases: ['land cruiser 200', 'lc 200', 'lc200', 'ленд крузер 200', 'крузак 200'] },
      { canonical: 'Land Cruiser 300', aliases: ['land cruiser 300', 'lc 300', 'lc300', 'ленд крузер 300', 'крузак 300'] },
      { canonical: 'Land Cruiser', aliases: ['land cruiser', 'landcruiser', 'ленд крузер', 'крузак'] },
      { canonical: 'Prado', aliases: ['prado', 'прадо'] },
    ],
  },
  {
    canonical: 'Volkswagen',
    aliases: ['volkswagen', 'фольксваген', 'vw', 'вв'],
    models: [
      { canonical: 'Polo', aliases: ['polo', 'поло'] },
      { canonical: 'Jetta', aliases: ['jetta', 'джетта'] },
      { canonical: 'Passat', aliases: ['passat', 'пассат', 'pasat'] },
      { canonical: 'Arteon', aliases: ['arteon', 'артеон'] },
      { canonical: 'Golf', aliases: ['golf', 'гольф'] },
      { canonical: 'e-Bora', aliases: ['e-bora', 'ebora', 'e-lavida', 'elavida', 'е-бора'] },
      { canonical: 'Caddy', aliases: ['caddy', 'кадди'] },
      { canonical: 'Tiguan', aliases: ['tiguan', 'тигуан'] },
      { canonical: 'Teramont', aliases: ['teramont', 'терамонт'] },
      { canonical: 'Touareg', aliases: ['touareg', 'туарег'] },
      { canonical: 'T-Roc', aliases: ['t-roc', 'troc', 'т-рок'] },
      { canonical: 'ID.3', aliases: ['id.3', 'id3'] },
      { canonical: 'ID.4', aliases: ['id.4', 'id4'] },
      { canonical: 'ID.6', aliases: ['id.6', 'id6'] },
      { canonical: 'ID.7', aliases: ['id.7', 'id7'] },
    ],
  },
  {
    canonical: 'BMW',
    aliases: ['bmw', 'бмв', 'бэхэ'],
    models: [
      { canonical: 'E30', aliases: ['e30', 'е30'] },
      { canonical: 'E34', aliases: ['e34', 'е34'] },
      { canonical: 'E36', aliases: ['e36', 'е36'] },
      { canonical: 'E39', aliases: ['e39', 'е39'] },
      { canonical: 'E46', aliases: ['e46', 'е46'] },
      { canonical: 'E60', aliases: ['e60', 'е60'] },
      { canonical: 'E90', aliases: ['e90', 'е90'] },
      { canonical: 'F10', aliases: ['f10', 'ф10'] },
      { canonical: 'G30', aliases: ['g30', 'г30'] },
      { canonical: 'X5', aliases: ['x5', 'х5'] },
      { canonical: 'X6', aliases: ['x6', 'х6'] },
      { canonical: 'X7', aliases: ['x7', 'х7'] },
      { canonical: 'M2', aliases: ['m2', 'м2'] },
      { canonical: 'M3', aliases: ['m3', 'м3'] },
      { canonical: 'M4', aliases: ['m4', 'м4'] },
      { canonical: 'M5', aliases: ['m5', 'м5'] },
      { canonical: 'M8', aliases: ['m8', 'м8'] },
      { canonical: 'i3', aliases: ['i3', 'и3'] },
      { canonical: 'i5', aliases: ['i5', 'и5'] },
      { canonical: 'i7', aliases: ['i7', 'и7'] },
      { canonical: 'iX', aliases: ['ix', 'икс'] },
      { canonical: 'iX3', aliases: ['ix3'] },
    ],
  },
  {
    canonical: 'Mercedes-Benz',
    aliases: ['mercedes-benz', 'mercedes', 'мерседес', 'мерс', 'benz'],
    models: [
      { canonical: 'C-Class', aliases: ['c-class', 'c class', 'cclass', 'с-класс', 'с класс'] },
      { canonical: 'C180', aliases: ['c180', 'с180'] },
      { canonical: 'C200', aliases: ['c200', 'с200'] },
      { canonical: 'C300', aliases: ['c300', 'с300'] },
      { canonical: 'C43 AMG', aliases: ['c43 amg', 'c43', 'с43'] },
      { canonical: 'C63 AMG', aliases: ['c63 amg', 'c63', 'с63'] },
      { canonical: 'E-Class', aliases: ['e-class', 'e class', 'eclass', 'е-класс', 'е класс'] },
      { canonical: 'E200', aliases: ['e200', 'е200'] },
      { canonical: 'E300', aliases: ['e300', 'е300'] },
      { canonical: 'E350', aliases: ['e350', 'е350'] },
      { canonical: 'W210', aliases: ['w210', 'в210'] },
      { canonical: 'W211', aliases: ['w211', 'в211'] },
      { canonical: 'W212', aliases: ['w212', 'в212'] },
      { canonical: 'W213', aliases: ['w213', 'в213'] },
      { canonical: 'W124', aliases: ['w124', 'в124'] },
      { canonical: 'S-Class', aliases: ['s-class', 's class', 'sclass', 'с-класс s', 'эс класс'] },
      { canonical: 'S320', aliases: ['s320'] },
      { canonical: 'S350', aliases: ['s350'] },
      { canonical: 'S500', aliases: ['s500'] },
      { canonical: 'S550', aliases: ['s550'] },
      { canonical: 'S580', aliases: ['s580'] },
      { canonical: 'W140', aliases: ['w140', 'в140'] },
      { canonical: 'W220', aliases: ['w220', 'в220'] },
      { canonical: 'W221', aliases: ['w221', 'в221'] },
      { canonical: 'W222', aliases: ['w222', 'в222'] },
      { canonical: 'W223', aliases: ['w223', 'в223'] },
      { canonical: 'CLS', aliases: ['cls', 'цлс'] },
      { canonical: 'CLS350', aliases: ['cls350'] },
      { canonical: 'CLS450', aliases: ['cls450'] },
      { canonical: 'CLS53 AMG', aliases: ['cls53 amg', 'cls53'] },
      { canonical: 'CLS63 AMG', aliases: ['cls63 amg', 'cls63'] },
      { canonical: 'GLA', aliases: ['gla', 'гла'] },
      { canonical: 'GLB', aliases: ['glb', 'глб'] },
      { canonical: 'GLC', aliases: ['glc', 'глц'] },
      { canonical: 'GLE Coupe', aliases: ['gle coupe', 'gle купе'] },
      { canonical: 'GLE', aliases: ['gle', 'гле'] },
      { canonical: 'GLS', aliases: ['gls', 'глс'] },
      { canonical: 'G-Class', aliases: ['g-class', 'g class', 'gclass', 'гелик', 'гелендваген', 'г-класс'] },
      { canonical: 'G500', aliases: ['g500'] },
      { canonical: 'G63 AMG', aliases: ['g63 amg', 'g63', 'г63'] },
      { canonical: 'EQC', aliases: ['eqc', 'экьюси'] },
      { canonical: 'EQE', aliases: ['eqe'] },
      { canonical: 'EQS', aliases: ['eqs'] },
      { canonical: 'V-Class', aliases: ['v-class', 'v class', 'vclass', 'в-класс'] },
    ],
  },
  {
    canonical: 'Audi',
    aliases: ['audi', 'ауди', 'авди'],
    models: [
      { canonical: 'A3', aliases: ['a3', 'а3'] },
      { canonical: 'A4', aliases: ['a4', 'а4'] },
      { canonical: 'A5', aliases: ['a5', 'а5'] },
      { canonical: 'A6', aliases: ['a6', 'а6'] },
      { canonical: 'A7', aliases: ['a7', 'а7'] },
      { canonical: 'A8', aliases: ['a8', 'а8'] },
      { canonical: 'Q2', aliases: ['q2', 'ку2'] },
      { canonical: 'Q5 e-tron', aliases: ['q5 e-tron', 'q5 etron'] },
      { canonical: 'Q5', aliases: ['q5', 'ку5'] },
      { canonical: 'Q7', aliases: ['q7', 'ку7'] },
      { canonical: 'Q8', aliases: ['q8', 'ку8'] },
      { canonical: 'TT', aliases: ['tt', 'тт'] },
      { canonical: 'e-tron GT', aliases: ['e-tron gt', 'etron gt'] },
      { canonical: 'e-tron', aliases: ['e-tron', 'etron', 'этрон'] },
      { canonical: 'S4', aliases: ['s4'] },
      { canonical: 'S6', aliases: ['s6'] },
      { canonical: 'S8', aliases: ['s8'] },
      { canonical: 'RS4', aliases: ['rs4'] },
      { canonical: 'RS6', aliases: ['rs6'] },
      { canonical: 'RS7', aliases: ['rs7'] },
      { canonical: '80', aliases: ['ауди 80', 'audi 80', 'бочка'] },
      { canonical: '100', aliases: ['ауди 100', 'audi 100', 'сотка'] },
    ],
  },
  {
    canonical: 'Chery',
    aliases: ['chery', 'чери', 'черри'],
    models: [
      { canonical: 'Arrizo 5', aliases: ['arrizo 5', 'arrizo5', 'аризо 5'] },
      { canonical: 'Arrizo 6', aliases: ['arrizo 6', 'arrizo6', 'аризо 6'] },
      { canonical: 'Arrizo 8', aliases: ['arrizo 8', 'arrizo8', 'аризо 8'] },
      { canonical: 'Tiggo 2', aliases: ['tiggo 2', 'tiggo2', 'тигго 2'] },
      { canonical: 'Tiggo 4', aliases: ['tiggo 4', 'tiggo4', 'тигго 4'] },
      { canonical: 'Tiggo 7 Pro', aliases: ['tiggo 7 pro', 'tiggo7 pro', 'тигго 7 про'] },
      { canonical: 'Tiggo 8 Pro', aliases: ['tiggo 8 pro', 'tiggo8 pro', 'тигго 8 про'] },
      { canonical: 'Tiggo 9', aliases: ['tiggo 9', 'tiggo9', 'тигго 9'] },
      { canonical: 'eQ7', aliases: ['eq7'] },
    ],
  },
  {
    canonical: 'Geely',
    aliases: ['geely', 'джили', 'жили'],
    models: [
      { canonical: 'Emgrand', aliases: ['emgrand', 'эмгранд'] },
      { canonical: 'Coolray', aliases: ['coolray', 'кулрей'] },
      { canonical: 'Atlas', aliases: ['atlas', 'атлас'] },
      { canonical: 'Monjaro', aliases: ['monjaro', 'монжаро'] },
      { canonical: 'Okavango', aliases: ['okavango', 'окаванго'] },
      { canonical: 'Geometry C', aliases: ['geometry c', 'геометри c'] },
      { canonical: 'Galaxy E5', aliases: ['galaxy e5', 'гэлакси e5'] },
      { canonical: 'Galaxy M9', aliases: ['galaxy m9', 'гэлакси m9'] },
      { canonical: 'Galaxy Star 8', aliases: ['galaxy star 8', 'гэлакси стар 8'] },
    ],
  },
  {
    canonical: 'Haval',
    aliases: ['haval', 'хавал', 'хавейл'],
    models: [
      { canonical: 'H6', aliases: ['h6'] },
      { canonical: 'H9', aliases: ['h9'] },
      { canonical: 'Jolion', aliases: ['jolion', 'джолион'] },
      { canonical: 'Dargo', aliases: ['dargo', 'дарго'] },
      { canonical: 'M6', aliases: ['m6'] },
    ],
  },
  {
    canonical: 'BYD',
    aliases: ['byd', 'бид'],
    models: [
      { canonical: 'Chazor', aliases: ['chazor', 'чазор'] },
      { canonical: 'Song Plus', aliases: ['song plus', 'сонг плюс'] },
      { canonical: 'Song Pro', aliases: ['song pro', 'сонг про'] },
      { canonical: 'Song L', aliases: ['song l', 'сонг l'] },
      { canonical: 'Seagull', aliases: ['seagull', 'сигал'] },
      { canonical: 'Dolphin', aliases: ['dolphin', 'дольфин', 'долфин'] },
      { canonical: 'Seal', aliases: ['seal', 'сил'] },
      { canonical: 'Han', aliases: ['byd han', 'хан'] },
      { canonical: 'Qin Plus', aliases: ['qin plus', 'цинь плюс'] },
      { canonical: 'Yuan Up', aliases: ['yuan up', 'юань ап'] },
      { canonical: 'Yuan Plus', aliases: ['yuan plus', 'юань плюс'] },
      { canonical: 'Tang', aliases: ['byd tang', 'тан'] },
      { canonical: 'Destroyer 05', aliases: ['destroyer 05', 'дестройер 05'] },
      { canonical: 'Sealion 07', aliases: ['sealion 07', 'силион 07'] },
      { canonical: 'Leopard 5', aliases: ['leopard 5', 'леопард 5'] },
    ],
  },
  {
    canonical: 'Changan',
    aliases: ['changan', 'чанган'],
    models: [
      { canonical: 'Alsvin', aliases: ['alsvin', 'алсвин'] },
      { canonical: 'Eado Plus', aliases: ['eado plus', 'эадо плюс'] },
      { canonical: 'Lamore', aliases: ['lamore', 'ламор'] },
      { canonical: 'CS35 Plus', aliases: ['cs35 plus', 'cs35plus'] },
      { canonical: 'CS55 Plus', aliases: ['cs55 plus', 'cs55plus'] },
      { canonical: 'CS75 Plus', aliases: ['cs75 plus', 'cs75plus'] },
      { canonical: 'CS95', aliases: ['cs95'] },
      { canonical: 'UNI-T', aliases: ['uni-t', 'uni t', 'unit'] },
      { canonical: 'UNI-K', aliases: ['uni-k', 'uni k', 'unik'] },
      { canonical: 'UNI-V', aliases: ['uni-v', 'uni v', 'univ'] },
      { canonical: 'Deepal S05', aliases: ['deepal s05', 'дипал s05'] },
      { canonical: 'Deepal S07', aliases: ['deepal s07', 'дипал s07'] },
      { canonical: 'Deepal L07', aliases: ['deepal l07', 'дипал l07'] },
      { canonical: 'Deepal G318', aliases: ['deepal g318', 'дипал g318'] },
      { canonical: 'Deepal SL03', aliases: ['deepal sl03', 'дипал sl03'] },
    ],
  },
  {
    canonical: 'Dongfeng',
    aliases: ['dongfeng', 'донгфенг', 'дунфэн'],
    models: [
      { canonical: 'Shine Max', aliases: ['shine max', 'шайн макс'] },
      { canonical: 'Shine', aliases: ['shine', 'шайн'] },
      { canonical: 'Mage', aliases: ['mage', 'мейдж'] },
      { canonical: 'Aeolus AX7', aliases: ['aeolus ax7', 'ax7'] },
      { canonical: 'Nammi 01', aliases: ['nammi 01', 'nammi01', 'нэмми 01'] },
      { canonical: 'Forthing T5 EVO', aliases: ['forthing t5 evo', 't5 evo'] },
      { canonical: 'Forthing M4', aliases: ['forthing m4'] },
    ],
  },
  {
    canonical: 'Ford',
    aliases: ['ford', 'форд'],
    models: [
      { canonical: 'Focus', aliases: ['focus', 'фокус'] },
      { canonical: 'Mondeo', aliases: ['mondeo', 'мондео'] },
      { canonical: 'Fusion', aliases: ['fusion', 'фьюжн'] },
      { canonical: 'Taurus', aliases: ['taurus', 'таурус'] },
      { canonical: 'Escape', aliases: ['escape', 'эскейп'] },
      { canonical: 'Edge', aliases: ['edge', 'эдж'] },
      { canonical: 'Explorer', aliases: ['explorer', 'эксплорер'] },
      { canonical: 'Expedition', aliases: ['expedition', 'экспедишн'] },
      { canonical: 'Mustang', aliases: ['mustang', 'мустанг'] },
      { canonical: 'Transit', aliases: ['transit', 'транзит'] },
    ],
  },
  {
    canonical: 'GAC',
    aliases: ['gac', 'гак'],
    models: [
      { canonical: 'Empow', aliases: ['empow', 'эмпоу'] },
      { canonical: 'GS3', aliases: ['gs3'] },
      { canonical: 'GS4', aliases: ['gs4'] },
      { canonical: 'GS8', aliases: ['gs8'] },
      { canonical: 'Emkoo', aliases: ['emkoo', 'эмку'] },
      { canonical: 'Emzoom', aliases: ['emzoom', 'эмзум'] },
      { canonical: 'Aion Y', aliases: ['aion y', 'айон y'] },
      { canonical: 'Aion V', aliases: ['aion v', 'айон v'] },
      { canonical: 'Aion LX', aliases: ['aion lx', 'айон lx'] },
      { canonical: 'Aion S', aliases: ['aion s', 'айон s'] },
    ],
  },
  {
    canonical: 'Honda',
    aliases: ['honda', 'хонда'],
    models: [
      { canonical: 'Fit', aliases: ['fit', 'фит'] },
      { canonical: 'City', aliases: ['city', 'сити'] },
      { canonical: 'Civic', aliases: ['civic', 'цивик', 'сивик'] },
      { canonical: 'Accord', aliases: ['accord', 'аккорд'] },
      { canonical: 'HR-V', aliases: ['hr-v', 'hrv', 'хрв'] },
      { canonical: 'ZR-V', aliases: ['zr-v', 'zrv', 'зрв'] },
      { canonical: 'CR-V', aliases: ['cr-v', 'crv', 'црв'] },
      { canonical: 'WR-V', aliases: ['wr-v', 'wrv', 'врв'] },
      { canonical: 'Pilot', aliases: ['pilot', 'пилот'] },
      { canonical: 'Passport', aliases: ['passport', 'паспорт'] },
      { canonical: 'Odyssey', aliases: ['odyssey', 'одиссей'] },
      { canonical: 'e:NS1', aliases: ['e:ns1', 'ens1'] },
    ],
  },
  {
    canonical: 'Hongqi',
    aliases: ['hongqi', 'хончи', 'хунци'],
    models: [
      { canonical: 'H5', aliases: ['hongqi h5'] },
      { canonical: 'HS3', aliases: ['hs3'] },
      { canonical: 'HS5', aliases: ['hs5'] },
      { canonical: 'HS7', aliases: ['hs7'] },
      { canonical: 'E-QM5', aliases: ['e-qm5', 'eqm5'] },
      { canonical: 'EH7', aliases: ['eh7'] },
      { canonical: 'EHS9', aliases: ['ehs9'] },
    ],
  },
  {
    canonical: 'JAC',
    aliases: ['jac', 'джак'],
    models: [
      { canonical: 'J7', aliases: ['j7'] },
      { canonical: 'JS2', aliases: ['js2'] },
      { canonical: 'JS3', aliases: ['js3'] },
      { canonical: 'JS4', aliases: ['js4'] },
      { canonical: 'JS6', aliases: ['js6'] },
      { canonical: 'T8 Pro', aliases: ['t8 pro', 't8pro'] },
      { canonical: 'T8', aliases: ['t8'] },
      { canonical: 'E30X', aliases: ['e30x'] },
    ],
  },
  {
    canonical: 'Jetour',
    aliases: ['jetour', 'джетур'],
    models: [
      { canonical: 'X50', aliases: ['x50'] },
      { canonical: 'X70 Plus', aliases: ['x70 plus', 'x70plus'] },
      { canonical: 'X70', aliases: ['x70'] },
      { canonical: 'X90 Plus', aliases: ['x90 plus', 'x90plus'] },
      { canonical: 'Dashing', aliases: ['dashing', 'дашинг'] },
      { canonical: 'T2', aliases: ['jetour t2'] },
      { canonical: 'Traveller', aliases: ['traveller', 'тревеллер'] },
    ],
  },
  {
    canonical: 'Leapmotor',
    aliases: ['leapmotor', 'липмотор', 'лип мотор'],
    models: [
      { canonical: 'T03', aliases: ['t03'] },
      { canonical: 'C01', aliases: ['c01'] },
      { canonical: 'C10', aliases: ['c10'] },
      { canonical: 'C11', aliases: ['c11'] },
      { canonical: 'C16', aliases: ['c16'] },
      { canonical: 'B10', aliases: ['b10'] },
    ],
  },
  {
    canonical: 'Lexus',
    aliases: ['lexus', 'лексус'],
    models: [
      { canonical: 'IS', aliases: ['lexus is', 'ис'] },
      { canonical: 'ES', aliases: ['lexus es', 'ес'] },
      { canonical: 'GS', aliases: ['lexus gs'] },
      { canonical: 'LS', aliases: ['lexus ls'] },
      { canonical: 'UX', aliases: ['lexus ux'] },
      { canonical: 'NX', aliases: ['lexus nx', 'нх'] },
      { canonical: 'RX', aliases: ['lexus rx', 'рх'] },
      { canonical: 'GX', aliases: ['lexus gx'] },
      { canonical: 'LX', aliases: ['lexus lx', 'лх'] },
      { canonical: 'LM', aliases: ['lexus lm'] },
      { canonical: 'RC', aliases: ['lexus rc'] },
      { canonical: 'RZ', aliases: ['lexus rz'] },
    ],
  },
  {
    canonical: 'Li Auto',
    aliases: ['li auto', 'li xiang', 'лисян', 'ли сян', 'лиауто'],
    models: [
      { canonical: 'L6', aliases: ['li l6'] },
      { canonical: 'L7', aliases: ['li l7'] },
      { canonical: 'L8', aliases: ['li l8'] },
      { canonical: 'L9', aliases: ['li l9'] },
      { canonical: 'Mega', aliases: ['li mega', 'мега'] },
    ],
  },
  {
    canonical: 'Mazda',
    aliases: ['mazda', 'мазда'],
    models: [
      { canonical: 'Mazda 2', aliases: ['mazda 2', 'mazda2', 'мазда 2'] },
      { canonical: 'Mazda 3', aliases: ['mazda 3', 'mazda3', 'мазда 3'] },
      { canonical: 'Mazda 6', aliases: ['mazda 6', 'mazda6', 'мазда 6'] },
      { canonical: 'CX-3', aliases: ['cx-3', 'cx3'] },
      { canonical: 'CX-4', aliases: ['cx-4', 'cx4'] },
      { canonical: 'CX-5', aliases: ['cx-5', 'cx5'] },
      { canonical: 'CX-50', aliases: ['cx-50', 'cx50'] },
      { canonical: 'CX-60', aliases: ['cx-60', 'cx60'] },
      { canonical: 'CX-70', aliases: ['cx-70', 'cx70'] },
      { canonical: 'CX-90', aliases: ['cx-90', 'cx90'] },
      { canonical: 'MX-5', aliases: ['mx-5', 'mx5'] },
    ],
  },
  {
    canonical: 'Mitsubishi',
    aliases: ['mitsubishi', 'мицубиси', 'митсубиси'],
    models: [],
  },
  {
    canonical: 'Nissan',
    aliases: ['nissan', 'ниссан', 'нисан'],
    models: [
      { canonical: 'Sunny', aliases: ['sunny', 'санни'] },
      { canonical: 'Sentra', aliases: ['sentra', 'сентра'] },
      { canonical: 'Sylphy', aliases: ['sylphy', 'силфи'] },
      { canonical: 'Teana', aliases: ['teana', 'теана'] },
      { canonical: 'Altima', aliases: ['altima', 'альтима'] },
      { canonical: 'Maxima', aliases: ['maxima', 'максима'] },
      { canonical: 'Juke', aliases: ['juke', 'джук'] },
      { canonical: 'Qashqai', aliases: ['qashqai', 'кашкай'] },
      { canonical: 'X-Trail', aliases: ['x-trail', 'xtrail', 'икстрейл', 'икс трейл'] },
      { canonical: 'Murano', aliases: ['murano', 'мурано'] },
      { canonical: 'Pathfinder', aliases: ['pathfinder', 'патфайндер'] },
      { canonical: 'Patrol', aliases: ['patrol', 'патрол'] },
      { canonical: 'Leaf', aliases: ['leaf', 'лиф'] },
      { canonical: 'Ariya', aliases: ['ariya', 'ария'] },
      { canonical: 'Navara', aliases: ['navara', 'навара'] },
    ],
  },
  {
    canonical: 'Opel',
    aliases: ['opel', 'опель'],
    models: [
      { canonical: 'Astra', aliases: ['astra', 'астра'] },
      { canonical: 'Vectra', aliases: ['vectra', 'вектра'] },
      { canonical: 'Insignia', aliases: ['insignia', 'инсигния'] },
      { canonical: 'Corsa', aliases: ['corsa', 'корса'] },
      { canonical: 'Mokka', aliases: ['mokka', 'мокка'] },
      { canonical: 'Grandland', aliases: ['grandland', 'грандленд'] },
      { canonical: 'Crossland', aliases: ['crossland', 'кроссленд'] },
      { canonical: 'Zafira', aliases: ['zafira', 'зафира'] },
      { canonical: 'Combo', aliases: ['combo', 'комбо'] },
      { canonical: 'Vivaro', aliases: ['vivaro', 'виваро'] },
    ],
  },
  { canonical: 'Omoda', aliases: ['omoda', 'омода'], models: [] },
  {
    canonical: 'Land Rover',
    aliases: ['land rover', 'landrover', 'ленд ровер', 'range rover', 'range-rover', 'рендж ровер', 'рейндж ровер', 'лендровер', 'ленд-ровер', 'рейндж-ровер', 'рендж-ровер', 'рейнж ровер', 'ренж ровер'],
    models: [
      { canonical: 'Range Rover Sport', aliases: ['range rover sport', 'рендж ровер спорт', 'рейндж ровер спорт'] },
      { canonical: 'Range Rover Velar', aliases: ['range rover velar', 'velar', 'велар', 'рейндж ровер велар', 'рендж ровер велар'] },
      { canonical: 'Range Rover Evoque', aliases: ['range rover evoque', 'evoque', 'эвок'] },
      { canonical: 'Range Rover', aliases: ['range rover', 'рендж ровер', 'рейндж ровер'] },
      { canonical: 'Defender 90', aliases: ['defender 90', 'дефендер 90'] },
      { canonical: 'Defender 110', aliases: ['defender 110', 'дефендер 110'] },
      { canonical: 'Defender 130', aliases: ['defender 130', 'дефендер 130'] },
      { canonical: 'Discovery Sport', aliases: ['discovery sport', 'дискавери спорт'] },
      { canonical: 'Discovery', aliases: ['discovery', 'дискавери'] },
      { canonical: 'Freelander', aliases: ['freelander', 'фрилендер'] },
    ],
  },
  {
    canonical: 'Renault',
    aliases: ['renault', 'рено', 'reno'],
    models: [
      { canonical: 'Logan', aliases: ['logan', 'логан'] },
      { canonical: 'Sandero', aliases: ['sandero', 'сандеро'] },
      { canonical: 'Duster', aliases: ['duster', 'дастер'] },
      { canonical: 'Kaptur', aliases: ['kaptur', 'каптюр', 'каптур'] },
      { canonical: 'Arkana', aliases: ['arkana', 'аркана'] },
      { canonical: 'Megane', aliases: ['megane', 'меган'] },
      { canonical: 'Fluence', aliases: ['fluence', 'флюенс'] },
      { canonical: 'Laguna', aliases: ['laguna', 'лагуна'] },
      { canonical: 'Talisman', aliases: ['talisman', 'талисман'] },
      { canonical: 'Koleos', aliases: ['koleos', 'колеос'] },
      { canonical: 'Kangoo', aliases: ['kangoo', 'кангу'] },
      { canonical: 'Master', aliases: ['renault master', 'мастер'] },
    ],
  },
  {
    canonical: 'Skoda',
    aliases: ['skoda', 'шкода', 'škoda'],
    models: [
      { canonical: 'Fabia', aliases: ['fabia', 'фабия'] },
      { canonical: 'Rapid', aliases: ['rapid', 'рапид'] },
      { canonical: 'Octavia', aliases: ['octavia', 'октавия'] },
      { canonical: 'Superb', aliases: ['superb', 'суперб'] },
      { canonical: 'Kamiq', aliases: ['kamiq', 'камик'] },
      { canonical: 'Karoq', aliases: ['karoq', 'карок'] },
      { canonical: 'Kodiaq', aliases: ['kodiaq', 'кодиак'] },
      { canonical: 'Enyaq', aliases: ['enyaq', 'эньяк'] },
    ],
  },
  {
    canonical: 'Tesla',
    aliases: ['tesla', 'тесла'],
    models: [
      { canonical: 'Model 3', aliases: ['model 3', 'model3', 'модель 3'] },
      { canonical: 'Model S', aliases: ['model s', 'models', 'модель s'] },
      { canonical: 'Model X', aliases: ['model x', 'modelx', 'модель x'] },
      { canonical: 'Model Y', aliases: ['model y', 'modely', 'модель y'] },
      { canonical: 'Cybertruck', aliases: ['cybertruck', 'кибертрак'] },
      { canonical: 'Roadster', aliases: ['roadster', 'родстер'] },
    ],
  },
  {
    canonical: 'Volvo',
    aliases: ['volvo', 'вольво'],
    models: [
      { canonical: 'S60', aliases: ['s60'] },
      { canonical: 'S80', aliases: ['s80'] },
      { canonical: 'S90', aliases: ['s90'] },
      { canonical: 'V60', aliases: ['v60'] },
      { canonical: 'V90', aliases: ['v90'] },
      { canonical: 'XC40', aliases: ['xc40'] },
      { canonical: 'XC60', aliases: ['xc60'] },
      { canonical: 'XC90', aliases: ['xc90'] },
      { canonical: 'C40 Recharge', aliases: ['c40 recharge', 'c40'] },
      { canonical: 'EX30', aliases: ['ex30'] },
      { canonical: 'EX90', aliases: ['ex90'] },
    ],
  },
  {
    canonical: 'Voyah',
    aliases: ['voyah', 'воях'],
    models: [
      { canonical: 'Free', aliases: ['voyah free', 'фри'] },
      { canonical: 'Dream', aliases: ['voyah dream', 'дрим'] },
      { canonical: 'Passion', aliases: ['voyah passion', 'пэшн'] },
      { canonical: 'Zhiyin', aliases: ['zhiyin', 'чжиинь'] },
    ],
  },
  {
    canonical: 'Xiaomi',
    aliases: ['xiaomi', 'сяоми', 'ксиоми'],
    models: [
      { canonical: 'SU7 Pro', aliases: ['su7 pro', 'su7pro'] },
      { canonical: 'SU7 Max', aliases: ['su7 max', 'su7max'] },
      { canonical: 'SU7', aliases: ['su7'] },
      { canonical: 'YU7', aliases: ['yu7'] },
    ],
  },
  {
    canonical: 'Zeekr',
    aliases: ['zeekr', 'зикр'],
    models: [
      { canonical: '001', aliases: ['zeekr 001', 'зикр 001'] },
      { canonical: '007', aliases: ['zeekr 007', 'зикр 007'] },
      { canonical: '009', aliases: ['zeekr 009', 'зикр 009'] },
      { canonical: '7X', aliases: ['zeekr 7x', '7x'] },
      { canonical: 'X', aliases: ['zeekr x'] },
      { canonical: 'Mix', aliases: ['zeekr mix', 'микс'] },
    ],
  },
  {
    canonical: 'Lada',
    aliases: ['lada', 'лада', 'ваз', 'vaz'],
    models: [
      { canonical: '2106', aliases: ['2106', 'ваз 2106', 'шестерка'] },
      { canonical: '2107', aliases: ['2107', 'ваз 2107', 'семерка'] },
      { canonical: '21099', aliases: ['21099', 'ваз 21099'] },
      { canonical: 'Priora', aliases: ['priora', 'приора'] },
      { canonical: 'Granta', aliases: ['granta', 'гранта'] },
      { canonical: 'Vesta', aliases: ['vesta', 'веста'] },
    ],
  },
  {
    canonical: 'GAZ',
    aliases: ['gaz', 'газ'],
    models: [
      { canonical: '24 Volga', aliases: ['24 volga', 'газ 24', 'волга 24', 'волга'] },
      { canonical: '3110', aliases: ['3110', 'газ 3110'] },
      { canonical: '31105', aliases: ['31105', 'газ 31105'] },
      { canonical: 'Gazelle', aliases: ['gazelle', 'газель'] },
    ],
  },
  {
    canonical: 'ZAZ',
    aliases: ['zaz', 'заз'],
    models: [
      { canonical: '968M', aliases: ['968m', 'заз 968', 'запорожец'] },
      { canonical: 'Tavria', aliases: ['tavria', 'таврия'] },
      { canonical: 'Sens', aliases: ['zaz sens', 'сенс'] },
    ],
  },
  {
    canonical: 'IZh',
    aliases: ['izh', 'иж'],
    models: [
      { canonical: '2715', aliases: ['2715', 'иж 2715'] },
      { canonical: 'Oda 2126', aliases: ['oda 2126', '2126', 'ода', 'иж ода'] },
    ],
  },
  {
    canonical: 'Moskvich',
    aliases: ['moskvich', 'москвич'],
    models: [
      { canonical: '412', aliases: ['412', 'москвич 412'] },
      { canonical: '2140', aliases: ['2140', 'москвич 2140'] },
      { canonical: '2141', aliases: ['2141', 'москвич 2141'] },
      { canonical: 'Moskvich 3', aliases: ['moskvich 3', 'москвич 3'] },
    ],
  },
  {
    canonical: 'UAZ',
    aliases: ['uaz', 'уаз'],
    models: [
      { canonical: '469', aliases: ['469', 'уаз 469'] },
      { canonical: 'Hunter', aliases: ['hunter', 'хантер'] },
      { canonical: 'Patriot', aliases: ['patriot', 'патриот'] },
      { canonical: '2206', aliases: ['2206', 'уаз 2206', 'буханка'] },
    ],
  },
];

// ── Lookup tables (built once at module load) ───────────────────────────────

interface ModelEntry {
  canonical: string;
  brand: string; // canonical brand name
}

/** alias (lowercase) → brand canonical name */
const BRAND_BY_ALIAS = new Map<string, string>();
/** alias (lowercase) → { model canonical, owning brand canonical } */
const MODEL_BY_ALIAS = new Map<string, ModelEntry>();
/** model canonical (lowercase) → canonical, for canonicalization */
const MODEL_CANON_BY_LOWER = new Map<string, string>();

for (const brand of VEHICLE_CATALOG) {
  for (const alias of [brand.canonical.toLowerCase(), ...brand.aliases]) {
    if (!BRAND_BY_ALIAS.has(alias)) BRAND_BY_ALIAS.set(alias, brand.canonical);
  }
  for (const model of brand.models) {
    const all = [model.canonical.toLowerCase(), ...model.aliases];
    for (const alias of all) {
      // First brand wins for shared model names (e.g. "Nexia" under Chevrolet).
      if (!MODEL_BY_ALIAS.has(alias)) {
        MODEL_BY_ALIAS.set(alias, { canonical: model.canonical, brand: brand.canonical });
      }
    }
    MODEL_CANON_BY_LOWER.set(model.canonical.toLowerCase(), model.canonical);
  }
}

// Multi-word aliases (e.g. "nexia 3", "land cruiser") must be matched before
// their single-word prefixes, so sort all model aliases longest-first.
const MODEL_ALIASES_SORTED = [...MODEL_BY_ALIAS.keys()].sort(
  (a, b) => b.length - a.length,
);
const BRAND_ALIASES_SORTED = [...BRAND_BY_ALIAS.keys()].sort(
  (a, b) => b.length - a.length,
);

export interface CatalogMatch {
  /** Canonical brand name, or null if none detected. */
  brand: string | null;
  /** Canonical model names, de-duplicated, in first-seen order. */
  models: string[];
  /** The exact alias substrings that matched (for stripping from title). */
  matchedTokens: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A model alias surrounded by word boundaries. Cyrillic needs custom boundaries
// because \b doesn't treat cyrillic letters as word chars in JS regex.
function aliasRegex(alias: string): RegExp {
  const body = escapeRegExp(alias).replace(/\s+/g, '\\s+');
  // (^|non-letter) alias (non-letter|$) — letters include latin + cyrillic.
  return new RegExp(`(^|[^a-zA-Zа-яёА-ЯЁ0-9])(${body})(?=[^a-zA-Zа-яёА-ЯЁ0-9]|$)`, 'i');
}

/**
 * Detect brands and models in free text using the local dictionary only.
 * Returns canonical names plus the raw matched substrings so callers can
 * strip them out of the title/description.
 */
export function matchCatalog(text: string): CatalogMatch {
  // Work on a mutable lowercase copy; blank out each matched span with spaces
  // so a shorter alias (e.g. "nexia") can't re-match text already claimed by a
  // longer one (e.g. "nexia 3"). Aliases are pre-sorted longest-first.
  let lower = ` ${text.toLowerCase()} `;
  const matchedTokens: string[] = [];

  const consume = (m: RegExpExecArray): string => {
    const token = m[2];
    const start = m.index + m[1].length;
    lower = lower.slice(0, start) + ' '.repeat(token.length) + lower.slice(start + token.length);
    return token;
  };

  const models: string[] = [];
  const brandsFromModels = new Set<string>();
  for (const alias of MODEL_ALIASES_SORTED) {
    const re = aliasRegex(alias);
    const m = re.exec(lower);
    if (m) {
      const entry = MODEL_BY_ALIAS.get(alias)!;
      if (!models.includes(entry.canonical)) models.push(entry.canonical);
      brandsFromModels.add(entry.brand);
      matchedTokens.push(consume(m));
    }
  }

  let brand: string | null = null;
  for (const alias of BRAND_ALIASES_SORTED) {
    const re = aliasRegex(alias);
    const m = re.exec(lower);
    if (m) {
      brand = BRAND_BY_ALIAS.get(alias)!;
      matchedTokens.push(consume(m));
      break;
    }
  }

  // If no explicit brand but a model implies exactly one, use it.
  if (!brand && brandsFromModels.size === 1) {
    brand = [...brandsFromModels][0];
  }

  return { brand, models, matchedTokens };
}

/** Resolve a free-form brand string to its canonical name, or null. */
export function canonicalizeBrand(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return BRAND_BY_ALIAS.get(trimmed.toLowerCase()) ?? trimmed;
}

/** Resolve a free-form model string to its canonical name (keeps original if unknown). */
export function canonicalizeModel(value: string): string {
  const lower = value.trim().toLowerCase();
  const entry = MODEL_BY_ALIAS.get(lower);
  if (entry) return entry.canonical;
  return MODEL_CANON_BY_LOWER.get(lower) ?? value.trim();
}

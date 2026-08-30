/**
 * Uzbek (Latin script) seller-bot copy. Latin, not Cyrillic — it is the script
 * the Mator apps ship their `uz` locale in, so the bot and the apps read the
 * same way to the same seller.
 *
 * Emoji, placeholders and line structure mirror {@link ./ru} exactly: the
 * layout of a message is part of its design, and a translation that drops a
 * line break or a `{count}` slot silently changes the UI.
 */
import type { BotStrings } from './keys';

export const UZ: BotStrings = {
  'lang.prompt': '🌐 Выберите язык / Tilingizni tanlang / Choose your language',
  'lang.changed': '✅ Interfeys tili: O‘zbekcha.',

  'start.hint': '👋 Mahsulot qo‘shish uchun /start ni bosing',
  'start.rejected': '⛔ Arizangiz administrator tomonidan rad etildi.',
  'start.pending':
    '⏳ Ro‘yxatdan o‘tish arizangiz qabul qilindi va administrator tasdig‘ini kutmoqda.\n' +
    'Hisobingiz faollashtirilishi bilan mahsulot qo‘sha olasiz.',
  'start.notRegistered':
    '👋 Avval ro‘yxatdan o‘ting: /start buyrug‘ini yuboring',
  'start.awaitingApproval':
    '⏳ Arizangiz hali tasdiqlanmagan. Iltimos, kuting.',
  'start.accountRejected': '⛔ Hisobingiz administrator tomonidan rad etilgan.',
  'seller.approved':
    '✅ Arizangiz muvaffaqiyatli tasdiqlandi!\n\n' +
    'Endi Mator’da mahsulot joylashtirishingiz mumkin.\n\n' +
    'Menyuni ochish va mahsulot qo‘shishni boshlash uchun /start ni bosing.',
  'help.message':
    '📦 Mahsulot qanday qo‘shiladi\n\n' +
    '/start ni bosing — bot sizni bosqichma-bosqich olib boradi:\n\n' +
    '1️⃣ Suratlar — bitta surat yoki 10 tagacha albom\n' +
    '2️⃣ Avtomobil markasi (tugma)\n' +
    '3️⃣ Model (tugma)\n' +
    '4️⃣ Ehtiyot qism turkumi (tugma)\n' +
    '5️⃣ Ichki turkum (tugma) — agar tanlangan turkumda bo‘lsa\n' +
    '6️⃣ Mahsulot nomi (matn)\n' +
    '7️⃣ Tavsif — o‘tkazib yuborish mumkin\n' +
    '8️⃣ Raqam turi: OEM, GM yoki o‘tkazib yuborish\n' +
    '9️⃣ Detal raqami (OEM/GM tanlansa)\n' +
    '🔟 Narxi so‘mda\n\n' +
    '🛢 Ehtiyot qism emas, motor moyi sotyapsizmi? Marka tanlash bosqichida «Boshqa» → «Motor moylari» ni bosing:\n' +
    'bot marka, model va detal raqami o‘rniga qovushqoqlik, tur va hajmni so‘raydi.\n\n' +
    '⚡ Siz ma’lumot to‘ldirayotganingizda suratlar fonda qayta ishlanadi — kutish shart emas.\n' +
    '✅ Hammasi tayyor bo‘lgach, bot ko‘rib chiqish oynasini ko‘rsatadi — tekshiring va «Mahsulot qo‘shish» ni bosing.\n\n' +
    '💡 Marka va modelni faqat tugmalar orqali tanlang — qo‘lda yozish shart emas.\n' +
    '🔎 OEM yoki GM raqamini ko‘rsatsangiz, xaridorlar detalingizni qidiruvdan ancha oson topadi.\n\n' +
    '🌐 Tilni o‘zgartirish: /language',

  'images.processing': '📸 Surat qayta ishlanmoqda, iltimos kutib turing.',
  'photos.notAccepted':
    '⚠️ Suratni qabul qilib bo‘lmadi. Yana bir bor urinib ko‘ring.',
  'photos.received':
    '✅ Suratlar qabul qilindi ({count} ta). Ular qayta ishlanayotganda mahsulot ma’lumotlarini to‘ldiring.',
  'photos.finishing': '⏳ Suratlarni qayta ishlashni yakunlayapmiz…',
  'photos.sendNew':
    '🖼 Yangi suratlarni yuboring — mahsulotning qolgan ma’lumotlari saqlandi.',
  'photos.noneToRetry': 'Qayta ishlash uchun surat yo‘q.',
  'photos.retrying':
    '🔁 Suratlarni qayta ishlayapmiz. Tayyor bo‘lganda xabar beramiz.',
  'draft.imagesFailed':
    '⚠️ {count} ta suratni qayta ishlab bo‘lmadi. Ma’lumotlaringiz saqlandi — qayta urinib ko‘rish mumkin.',
  'draft.imagesPartiallyFailed':
    '⚠️ Suratlarning bir qismi qayta ishlanmadi. Qayta urinib ko‘rish mumkin.',
  'draft.resumePrompt':
    'Sizda tugallanmagan e’lon bor.\nDavom ettiramizmi yoki boshidan boshlaymizmi?',
  'draft.resumed': '▶️ Davom etamiz. Qolgan maydonlarni to‘ldiring.',
  'draft.expired':
    '⌛ Tugallanmagan e’lon endi mavjud emas. Boshidan boshlash uchun /start ni bosing.',
  'draft.addCancelled':
    '❌ Mahsulot qo‘shish bekor qilindi.\nBoshidan boshlash uchun /start ni bosing.',
  'draft.createCancelled':
    '❌ Mahsulot yaratish bekor qilindi.\nBoshidan boshlash uchun /start ni bosing.',
  'edit.noProduct':
    '⌛ Tahrirlash uchun mahsulot yo‘q (vaqt tugagan bo‘lishi mumkin). Boshidan boshlash uchun /start ni bosing.',
  'edit.notEditable':
    '⌛ Bu e’lonni endi o‘zgartirib bo‘lmaydi. Boshidan boshlash uchun /start ni bosing.',

  'preview.header': '📋 *Qo‘shishdan oldin mahsulotni tekshiring.*',
  'preview.title': 'Nomi',
  'preview.description': 'Tavsifi',
  'preview.price': 'Narxi',
  'preview.vehicle': 'Avtomobil',
  'preview.category': 'Turkum',
  'preview.viscosity': 'Qovushqoqlik',
  'preview.oilType': 'Moy turi',
  'preview.volume': 'Hajmi',
  'preview.weight': 'Og‘irligi',
  'preview.universalVehicle': 'Barcha avtomobillar (universal detal)',
  'confirm.nothingPending':
    '⌛ Tasdiqlash uchun mahsulot yo‘q (vaqt tugagan bo‘lishi mumkin). Boshidan boshlash uchun /start ni bosing.',
  'confirm.alreadyProcessed':
    '⌛ Bu e’lon allaqachon qayta ishlangan. Keyingi mahsulotni qo‘shish uchun /start ni bosing.',
  'confirm.success':
    '✅ Mahsulot muvaffaqiyatli qo‘shildi.\nKeyingi mahsulotni qo‘shish uchun /start ni bosing.',
  'confirm.failed': '⚠️ Mahsulot qo‘shishda xatolik yuz berdi.\n`{error}`',

  'btn.back': '⬅️ Orqaga',
  'btn.skip': '⏭ O‘tkazib yuborish',
  'btn.other': 'Boshqa',
  'btn.kind.motorOil': '🛢 Motor moyi',
  'btn.kind.antifreeze': '🧊 Antifriz',
  'btn.continue': '▶️ Davom etish',
  'btn.startOver': '🆕 Boshidan boshlash',
  'btn.retry': '🔁 Qayta urinish',
  'btn.cancel': '❌ Bekor qilish',
  'btn.addProduct': '✅ Mahsulot qo‘shish',
  'btn.cancelProduct': '❌ Bekor qilish',
  'btn.changePhotos': '🖼 Suratlarni o‘zgartirish',
  'packageForm.single': 'Dona',
  'packageForm.set': 'Komplekt / to‘plam',

  'step.photosFirst':
    '📸 Avval mahsulot suratlarini yuboring — bitta surat yoki 10 tagacha albom.\n' +
    'Biz ularni qayta ishlayotganda siz mahsulot ma’lumotlarini to‘ldirasiz.',
  'step.brand': '🚗 Avtomobil markasini tanlang:',
  'step.model': '🚗 Marka: {brand}.\nEndi modelni tanlang:',
  'step.category': '🗂 Ehtiyot qism turkumini tanlang:',
  'step.subcategory': '🗂 Ichki turkumni tanlang:',
  'step.otherKind': '🛒 Nima sotyapsiz?',
  'step.otherCategory': '🗂 Mahsulot turkumini tanlang:',
  'step.packageForm': '📦 Mahsulot qanday sotiladi?',
  'step.oilViscosity': '🛢 Moy qovushqoqligini tanlang:',
  'step.oilViscosityCustom': '🛢 Moy qovushqoqligini kiriting.\nMasalan: 0W-16',
  'step.oilType': '🛢 Moy turini tanlang:',
  'step.oilVolume': '🛢 Hajmini tanlang:',
  'step.oilVolumeCustom': '🛢 Hajmini litrda kiriting.\nMasalan: 3',
  'step.antifreezeWeight': '⚖️ Qadoq og‘irligini tanlang (kg):',
  'step.antifreezeWeightCustom':
    '⚖️ Og‘irligini kilogrammda kiriting.\nMasalan: 2.5 yoki 10',
  'step.title.sparePart':
    '✏️ Mahsulot nomini kiriting.\nMasalan: Old amortizator',
  'step.title.antifreeze':
    '✏️ Mahsulot nomini kiriting.\n' +
    'Masalan:\n' +
    '• Felix Carbox G12 qizil\n' +
    '• Coolstream A-110\n' +
    '• Antifriz G11 yashil',
  'step.title.motorOil':
    '✏️ Mahsulot nomini kiriting.\n' +
    'Masalan:\n' +
    '• Mobil 1 ESP 5W-30 4L\n' +
    '• Shell Helix Ultra 5W-40\n' +
    '• ZIC X9 5W-30',
  'step.description':
    '📝 Mahsulot tavsifini kiriting yoki «O‘tkazib yuborish» ni bosing.',
  'step.partNumberType':
    '🔢 Detal raqami turini ko‘rsating yoki «O‘tkazib yuborish» ni bosing.',
  'step.partNumber': '🔢 {type} detal raqamini kiriting.\nMasalan: 96535062',
  'step.price': '💰 Narxini so‘mda kiriting.\nMasalan: 250 000',
  'step.questionnaireDone': '⏳ Suratlarni qayta ishlashni yakunlayapmiz…',

  'invalid.viscosity':
    '❌ Qovushqoqlikni aniqlab bo‘lmadi. Uni 5W-30 ko‘rinishida kiriting (masalan: 0W-16 yoki 20W-50).',
  'invalid.volume':
    '❌ Hajmni aniqlab bo‘lmadi. Uni litrda kiriting, masalan: 3 yoki 0,5',
  'invalid.weight':
    '❌ Og‘irlikni aniqlab bo‘lmadi. Uni kilogrammda kiriting, masalan: 2,5 yoki 10',
  'invalid.titleIsCommand':
    '❌ Bu buyruqqa o‘xshaydi. Mahsulot nomini matn sifatida kiriting.',
  'invalid.titleTooShort':
    '❌ Nom juda qisqa — kamida {min} belgi. Nomni yana kiriting.',
  'invalid.titleTooLong':
    '❌ Nom juda uzun — ko‘pi bilan {max} belgi. Qisqaroq kiriting.',
  'invalid.descriptionIsCommand':
    '❌ Bu buyruqqa o‘xshaydi. Tavsifni matn sifatida kiriting yoki «O‘tkazib yuborish» ni bosing.',
  'invalid.descriptionEmpty':
    '❌ Tavsif bo‘sh bo‘lishi mumkin emas. Matn kiriting yoki «O‘tkazib yuborish» ni bosing.',
  'invalid.partNumber':
    '❌ Raqam formati noto‘g‘ri. 3–50 belgi kiriting: harflar, raqamlar, probel, «-», «.», «/». Masalan: 96535062 yoki 58101-2VA00',
  'invalid.price':
    '❌ Narxni aniqlab bo‘lmadi. So‘mda son kiriting, masalan: 250 000',
  'invalid.priceTooLarge':
    '❌ Narx juda katta. Qiymatni tekshirib, yana kiriting.',

  'stale.catalog':
    'Katalog yangilandi.\n' +
    'E’lon yaratishni davom ettirish uchun /start ni bosing.',
  'stale.category':
    'Bu turkum endi mavjud emas — katalog yangilandi.\n' +
    'Iltimos, yangilangan ro‘yxatdan turkum tanlang.',

  'oilType.SYNTHETIC': 'Sintetik',
  'oilType.SEMI_SYNTHETIC': 'Yarim sintetik',
  'oilType.MINERAL': 'Mineral',
};

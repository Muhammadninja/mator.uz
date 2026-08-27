/**
 * English seller-bot copy. Emoji, placeholders and line structure mirror
 * {@link ./ru} exactly — see the note there on why the layout is part of the
 * translation.
 */
import type { BotStrings } from './keys';

export const EN: BotStrings = {
  'lang.prompt': '🌐 Выберите язык / Tilingizni tanlang / Choose your language',
  'lang.changed': '✅ Interface language: English.',

  'start.hint': '👋 To add a product, press /start',
  'start.rejected': '⛔ Your application was rejected by an administrator.',
  'start.pending':
    '⏳ Your registration request has been received and is awaiting approval.\n' +
    'As soon as your account is activated you will be able to add products.',
  'start.notRegistered': '👋 Please register first: send /start',
  'start.awaitingApproval':
    '⏳ Your application has not been approved yet. Please wait.',
  'start.accountRejected': '⛔ Your account was rejected by an administrator.',
  'seller.approved':
    '✅ Your application has been approved!\n\n' +
    'You can now publish products on Mator.\n\n' +
    'Press /start to open the menu and begin adding products.',
  'help.message':
    '📦 How to add a product\n\n' +
    'Press /start — the bot walks you through the steps:\n\n' +
    '1️⃣ Photos — one photo or an album of up to 10\n' +
    '2️⃣ Car brand (button)\n' +
    '3️⃣ Model (button)\n' +
    '4️⃣ Part category (button)\n' +
    '5️⃣ Subcategory (button) — if the chosen category has one\n' +
    '6️⃣ Product title (text)\n' +
    '7️⃣ Description — can be skipped\n' +
    '8️⃣ Number type: OEM, GM or skip\n' +
    '9️⃣ Part number (if you chose OEM/GM)\n' +
    '🔟 Price in UZS\n\n' +
    '🛢 Selling motor oil rather than a spare part? At the brand step press "Other" → "Motor Oils":\n' +
    'the bot asks for viscosity, type and volume instead of brand, model and part number.\n\n' +
    '⚡ Photos are processed in the background while you fill in the details — no waiting.\n' +
    '✅ When everything is ready the bot shows a preview — check it and press "Add product".\n\n' +
    '💡 Pick the brand and model with the buttons only — no typing needed.\n' +
    '🔎 Adding an OEM or GM number makes your part far easier for buyers to find in search.\n\n' +
    '🌐 Change language: /language',

  'images.processing': '📸 Photos are being processed, please wait.',
  'photos.notAccepted': '⚠️ Could not accept the photo. Please try again.',
  'photos.received':
    '✅ Photos received ({count}). While we process them, fill in the product details.',
  'photos.finishing': '⏳ Finishing photo processing…',
  'photos.sendNew':
    '🖼 Send the new photos — the rest of the product details are kept.',
  'photos.noneToRetry': 'There are no photos to reprocess.',
  'photos.retrying':
    '🔁 Reprocessing the photos. We will let you know when they are ready.',
  'draft.imagesFailed':
    '⚠️ Could not process {count} photo(s). Your details are saved — you can retry processing.',
  'draft.imagesPartiallyFailed':
    '⚠️ Some photos were not processed. You can retry processing.',
  'draft.resumePrompt':
    'You have an unfinished listing.\nContinue it or start over?',
  'draft.resumed': '▶️ Continuing. Fill in the remaining fields.',
  'draft.expired':
    '⌛ That unfinished listing is no longer available. Press /start to begin again.',
  'draft.addCancelled':
    '❌ Adding the product was cancelled.\nPress /start to begin again.',
  'draft.createCancelled':
    '❌ Creating the product was cancelled.\nPress /start to begin again.',
  'edit.noProduct':
    '⌛ There is no product to edit (it may have expired). Press /start to begin again.',
  'edit.notEditable':
    '⌛ This listing can no longer be changed. Press /start to begin again.',

  'preview.header': '📋 *Check the product before adding it.*',
  'preview.title': 'Title',
  'preview.description': 'Description',
  'preview.price': 'Price',
  'preview.vehicle': 'Vehicle',
  'preview.category': 'Category',
  'preview.viscosity': 'Viscosity',
  'preview.oilType': 'Oil type',
  'preview.volume': 'Volume',
  'preview.universalVehicle': 'All vehicles (universal part)',
  'confirm.nothingPending':
    '⌛ There is no product to confirm (it may have expired). Press /start to begin again.',
  'confirm.alreadyProcessed':
    '⌛ This listing has already been processed. Press /start to add the next product.',
  'confirm.success':
    '✅ Product added successfully.\nPress /start to add the next product.',
  'confirm.failed':
    '⚠️ Something went wrong while adding the product.\n`{error}`',

  'btn.back': '⬅️ Back',
  'btn.skip': '⏭ Skip',
  'btn.other': 'Other',
  'btn.continue': '▶️ Continue',
  'btn.startOver': '🆕 Start over',
  'btn.retry': '🔁 Retry',
  'btn.cancel': '❌ Cancel',
  'btn.addProduct': '✅ Add product',
  'btn.cancelProduct': '❌ Cancel',
  'btn.changePhotos': '🖼 Change photos',
  'packageForm.single': 'Single item',
  'packageForm.set': 'Set / kit',

  'step.photosFirst':
    '📸 First send photos of the product — one photo or an album of up to 10.\n' +
    'While we process them, you fill in the product details.',
  'step.brand': '🚗 Choose the car brand:',
  'step.model': '🚗 Brand: {brand}.\nNow choose the model:',
  'step.category': '🗂 Choose the part category:',
  'step.subcategory': '🗂 Choose the subcategory:',
  'step.otherCategory': '🗂 Choose the product category:',
  'step.packageForm': '📦 How is the product sold?',
  'step.oilViscosity': '🛢 Choose the oil viscosity:',
  'step.oilViscosityCustom': '🛢 Enter the oil viscosity.\nExample: 0W-16',
  'step.oilType': '🛢 Choose the oil type:',
  'step.oilVolume': '🛢 Choose the volume:',
  'step.oilVolumeCustom': '🛢 Enter the volume in litres.\nExample: 3',
  'step.title.sparePart':
    '✏️ Enter the product title.\nExample: Front shock absorber',
  'step.title.motorOil':
    '✏️ Enter the product title.\n' +
    'Examples:\n' +
    '• Mobil 1 ESP 5W-30 4L\n' +
    '• Shell Helix Ultra 5W-40\n' +
    '• ZIC X9 5W-30',
  'step.description': '📝 Enter a product description or press "Skip".',
  'step.partNumberType': '🔢 Choose the part-number type or press "Skip".',
  'step.partNumber': '🔢 Enter the {type} part number.\nExample: 96535062',
  'step.price': '💰 Enter the price in UZS.\nExample: 250 000',
  'step.questionnaireDone': '⏳ Finishing photo processing…',

  'invalid.viscosity':
    '❌ Could not read the viscosity. Enter it in the 5W-30 format (for example: 0W-16 or 20W-50).',
  'invalid.volume':
    '❌ Could not read the volume. Enter it in litres, for example: 3 or 0.5',
  'invalid.titleIsCommand':
    '❌ That looks like a command. Enter the product title as text.',
  'invalid.titleTooShort':
    '❌ The title is too short — at least {min} characters. Enter it again.',
  'invalid.titleTooLong':
    '❌ The title is too long — at most {max} characters. Enter a shorter one.',
  'invalid.descriptionIsCommand':
    '❌ That looks like a command. Enter the description as text or press "Skip".',
  'invalid.descriptionEmpty':
    '❌ The description cannot be empty. Enter some text or press "Skip".',
  'invalid.partNumber':
    '❌ Invalid number format. Enter 3–50 characters: letters, digits, space, "-", ".", "/". For example: 96535062 or 58101-2VA00',
  'invalid.price':
    '❌ Could not read the price. Enter a number in UZS, for example: 250 000',
  'invalid.priceTooLarge':
    '❌ That price is too large. Check the value and enter it again.',

  'stale.catalog':
    'The catalog has been updated.\n' +
    'To carry on creating the listing, please press /start.',
  'stale.category':
    'That category is no longer available — the catalog has been updated.\n' +
    'Please choose a category from the updated list.',

  'oilType.SYNTHETIC': 'Synthetic',
  'oilType.SEMI_SYNTHETIC': 'Semi-synthetic',
  'oilType.MINERAL': 'Mineral',
};

/**
 * The complete set of seller-bot strings, as a TYPE.
 *
 * Every user-facing sentence the bot sends is named here once; the three
 * dictionaries (ru/uz/en) then implement this exact shape, so TypeScript — not
 * a reviewer's memory — is what guarantees a new message was translated into
 * all three languages before it can ship. Forgetting one is a compile error.
 *
 * Values are plain strings with `{placeholder}` slots filled by
 * {@link ../bot-i18n.t}. Keeping them data (rather than functions) is what lets
 * a translator read a dictionary file top to bottom without reading code.
 */
export interface BotStrings {
  // ── Language selection ────────────────────────────────────────────────────
  /** Sent when the seller must pick a language. Intentionally trilingual in
   *  every dictionary: at this point we do not yet know what they read. */
  'lang.prompt': string;
  /** Confirmation after a pick, in the language just chosen. */
  'lang.changed': string;

  // ── Registration / account status ─────────────────────────────────────────
  'start.hint': string;
  'start.rejected': string;
  'start.pending': string;
  'start.notRegistered': string;
  'start.awaitingApproval': string;
  'start.accountRejected': string;
  'seller.approved': string;
  'help.message': string;

  // ── Photos & drafts ───────────────────────────────────────────────────────
  'images.processing': string;
  'photos.notAccepted': string;
  /** `{count}` — how many photos arrived. */
  'photos.received': string;
  'photos.finishing': string;
  'photos.sendNew': string;
  'photos.noneToRetry': string;
  'photos.retrying': string;
  /** `{count}` — how many photos failed. */
  'draft.imagesFailed': string;
  'draft.imagesPartiallyFailed': string;
  'draft.resumePrompt': string;
  'draft.resumed': string;
  'draft.expired': string;
  'draft.addCancelled': string;
  'draft.createCancelled': string;
  'edit.noProduct': string;
  'edit.notEditable': string;

  // ── Preview & confirmation ────────────────────────────────────────────────
  'preview.header': string;
  'preview.title': string;
  'preview.description': string;
  'preview.price': string;
  'preview.vehicle': string;
  'preview.category': string;
  'preview.viscosity': string;
  'preview.oilType': string;
  'preview.volume': string;
  /** Vehicle line for a part that fits everything. */
  'preview.universalVehicle': string;
  'confirm.nothingPending': string;
  'confirm.alreadyProcessed': string;
  'confirm.success': string;
  /** `{error}` — the failure detail. */
  'confirm.failed': string;

  // ── Buttons ───────────────────────────────────────────────────────────────
  'btn.back': string;
  'btn.skip': string;
  'btn.other': string;
  'btn.continue': string;
  'btn.startOver': string;
  'btn.retry': string;
  'btn.cancel': string;
  'btn.addProduct': string;
  'btn.cancelProduct': string;
  'btn.changePhotos': string;
  'packageForm.single': string;
  'packageForm.set': string;

  // ── Wizard step prompts ───────────────────────────────────────────────────
  'step.photosFirst': string;
  'step.brand': string;
  /** `{brand}` — the brand already chosen. */
  'step.model': string;
  'step.category': string;
  'step.subcategory': string;
  'step.otherCategory': string;
  'step.packageForm': string;
  'step.oilViscosity': string;
  'step.oilViscosityCustom': string;
  'step.oilType': string;
  'step.oilVolume': string;
  'step.oilVolumeCustom': string;
  'step.title.sparePart': string;
  'step.title.motorOil': string;
  'step.description': string;
  'step.partNumberType': string;
  /** `{type}` — OEM or GM, as the seller labelled it. */
  'step.partNumber': string;
  'step.price': string;
  'step.questionnaireDone': string;

  // ── Input validation ──────────────────────────────────────────────────────
  'invalid.viscosity': string;
  'invalid.volume': string;
  'invalid.titleIsCommand': string;
  /** `{min}` — the minimum length. */
  'invalid.titleTooShort': string;
  /** `{max}` — the maximum length. */
  'invalid.titleTooLong': string;
  'invalid.descriptionIsCommand': string;
  'invalid.descriptionEmpty': string;
  'invalid.partNumber': string;
  'invalid.price': string;
  'invalid.priceTooLarge': string;

  // ── Stale-catalog notices ─────────────────────────────────────────────────
  'stale.catalog': string;
  'stale.category': string;

  // ── Oil types (option labels, also shown in the preview) ──────────────────
  'oilType.SYNTHETIC': string;
  'oilType.SEMI_SYNTHETIC': string;
  'oilType.MINERAL': string;
}

/** A string key, for callers that pass one around. */
export type BotStringKey = keyof BotStrings;

# Legal documents — pre-publication checklist

Status: **DRAFT v1.0, not approved.** Do not seed into `legal_documents` until
every blocking item below is closed. Once real text is published and users accept
it, that version is frozen — corrections become v2, never an edit
(see `src/prisma/seed-data/legal-documents.seed.ts`).

Source files (see `README.md` for the naming convention):
- `terms-of-use.v1.{ru,uz,en}.md`
- `privacy-policy.v1.{ru,uz,en}.md`
- `personal-data-consent.v1.{ru,uz,en}.md`

Clauses needing counsel's sign-off are marked in-place with
`[НА ЮРИДИЧЕСКУЮ ПРОВЕРКУ]`.

Each `ru` draft opens with a `[PLACEHOLDER: FINAL LEGAL TEXT REQUIRED]` banner,
and the loader (`legal-documents.loader.ts`) **refuses to seed** any file that
still carries a review marker or an unfilled `[ИНН]` / `[EMAIL]` / `[ТЕЛЕФОН]`
placeholder unless that banner is present. So the drafts cannot reach the
database and freeze by accident: closing the last item means deleting the review
markers, filling the details, and removing the banner — in that order.

## Scope

The documents describe the **current release only**:

```
Mobile App → Mator Backend/API → Database → integrated third-party services
```

Deliberately **out of scope** — do not add back without a separate, explicit
decision, and only once the feature actually ships:

- MyID / identity verification, PINFL, passport data, biometric match results
  (`myid_verifications` exists in the schema but is not part of the current
  release; a table is not processing)
- Reviews, ratings, comments, user-generated content
- Website / web version / browser / cookies (mobile app only)

---

## A. Blocking — legal review

| # | Item | Where |
|---|---|---|
| A1 | Minimum age (18) — wording and legal basis, incl. capacity rules and self-provided consent | Terms §3 |
| A2 | Refund / cancellation / exchange — confirm the statutory periods, the list of goods excluded from exchange, who bears return shipping, and the deadline for refunding money. §9 states the rights but names no number on purpose; a separate "Правила оформления, отмены, возврата и обмена Товаров" should carry them | Terms §9 |
| A3 | Limitation of liability — must not conflict with mandatory consumer-protection norms | Terms §15 |
| A4 | Legal bases — mapping each data category and purpose onto a specific basis | Privacy §4 |
| A5 | Data shared with Sellers — scope of the disclosure and its legal basis | Privacy §7 |
| A6 | Breach notification — statutory deadlines for notifying the authority and data subjects. **No deadline is stated on purpose**; insert only once confirmed | Privacy §12 |
| A7 | Retention periods per data category, fixed in an internal retention policy | Privacy §10 |
| A8 | Account-deletion retention — periods for retained order/accounting records and consent records | Privacy §15.7 |
| A9 | Cross-border processing under Art. 27-1 ZRU-547 **as amended from 27 March 2026**: only biometric, genetic and telecom-subscriber data must stay in Uzbekistan; everything else may leave on one of the statutory grounds (adequacy, standard contractual clauses, binding corporate rules, recognised international standards). §13 now says exactly that, so per processor confirm (a) where the data physically sits and (b) which ground applies. **No blanket "all data stored in Uzbekistan" claim is made** | Privacy §13, Consent §12 |
| A10 | Marketing consent — that a separate, default-off opt-in satisfies local requirements for advertising messages | Terms §20.2, Privacy §8, Consent §11 |
| A11 | Marketplace-operator status — §5.2 now states plainly that Mator **is** an operator of an electronic trading platform (was "may act as"). Confirm this matches the business model and that the §5.2.1 duties are the full set the e-commerce law imposes | Terms §5.2 |
| A12 | Moment the sale contract is concluded — §7 separates the two: **§7.3 the user's act** (confirming and paying the order in the app) **is the acceptance**, **§7.4 payment confirmation** is the moment the Platform records the Seller's receipt of that acceptance, at which the contract is *deemed concluded* (the e-commerce law ties conclusion to receipt of the acceptance, so §7 deliberately avoids an "accepted but not yet in force" construction). §7.4 covers both routes the code actually has: a provider webhook (`settlement.service`) for PAYME/CLICK, and an operator confirmation for `PaymentType.TERMINAL`/`CASH` — the latter has no webhook, so a cash order sits in `PENDING_PAYMENT` and is swept to `EXPIRED` after `ORDER_TTL_MIN` (30 min) unless a human moves it. Confirm the construction, and confirm the cash/terminal flow is what the business intends | Terms §7 |
| A13 | Seller definition — narrowed to legal entities, individual entrepreneurs and self-employed retail sellers, per the e-commerce law. Confirm it covers every category Mator actually onboards | Terms §1 |
| A14 | 30-day notice for changes to the trading-platform rules (§18.3), and which changes fall outside it | Terms §18 |
| A15 | Liability split — §15.2.1–15.2.2 now name what Mator answers for, given that Mator takes the buyer's money and initiates refunds while each order line is fiscalised under the dealer's own tax id. Confirm the split matches the contractual and payment reality | Terms §15 |
| A16 | State-register (Art. 20) — determine which, if any, Mator databases fall under mandatory registration now that Art. 20 is tied to the Art. 27-1 must-be-stored-locally categories, and complete the procedure if applicable. **The documents deliberately make no claim about registration**; this is a company obligation, not a wording item | — (company procedure) |
| A17 | **Seller-side documents do not exist.** Terms §5.2.1 promises "условия сотрудничества с Продавцами", §7.1 makes the Seller's listing the offer, and §15.2.2 splits liability by actual role — but there is no dealer agreement, no marketplace service agreement and no seller offer anywhere in the repo, and `LegalDocumentType` holds only the three buyer-facing documents. The dealer contract must mirror this allocation (Seller = party to the sale; Mator = platform operator + payment intermediary) or the buyer-facing text describes a split no contract creates | — (missing document set) |
| A18 | **Refund after delivery is not implementable.** §9.3–9.5 grant the statutory post-delivery rights (defective goods, exchange of non-defective goods), but the code cannot execute a refund then: `ALLOWED_TRANSITIONS` makes `DELIVERED` terminal with no path to `REFUNDED` (`orders.service.ts`), and Payme's `CancelTransaction` refuses outright once the order is `SHIPPED`/`DELIVERED` (`UNREFUNDABLE_ORDER_STATUSES` in `payme.service.ts`, error -31007). So a lawful return currently has no mechanism — refunds only work while the goods have not shipped. §9.7 now sets out the procedure — claim → grounds checked → goods returned → Mator initiates the refund — with §9.7.1 making the physical return a condition of *executing* the payment only where the law ties the remedy to returning the goods, never a limit on the statutory right itself; and §9.8 no longer promises the same payment method unconditionally. That is wording around the gap, not a fix: steps 3–4 of §9.7 have no implementation for a delivered order. Decide the mechanism (manual/off-platform refund vs. a post-delivery return flow) with counsel, then reconcile Terms §9, the dealer agreement and the code | Terms §9, `orders.service.ts`, `payme.service.ts` |
| A19 | Force majeure (§17) — new section. Confirm the §17.3 carve-out (ordinary technical faults, contractor failures and lack of funds are **not** force majeure) and that §17.5–17.6, which preserve the mandatory-liability floor of §15.4–15.5 and leave the Seller's own liability untouched, are correct for a marketplace operator that also takes payment | Terms §17 |
| A20 | VIN — now listed in Privacy §2.4, Consent §2.4 and the AI row of §6.1, because `ai-chat.service.ts:244` forwards a client-supplied VIN to Anthropic inside the message. Confirm whether a VIN counts as personal data here (it identifies a vehicle, and via registration a person), and whether sending it to an AI processor needs a distinct legal basis in §4 | Privacy §2.4/§6.1, Consent §2.4 |

## B. Blocking — company details

Verify against MATOR INNOVATIONS' current registration documents, then replace
in all three files:

- [ ] `[ИНН]`
- [ ] `[ЮРИДИЧЕСКИЙ АДРЕС]` / `[АДРЕС]`
- [ ] `[EMAIL]`
- [ ] `[PRIVACY EMAIL]`
- [ ] `[ТЕЛЕФОН]`
- [ ] `[ДД.ММ.2026]` — publication and effective dates

`mator.uz` is referenced nowhere in the documents: it currently serves the API
and infrastructure, not a user-facing interface. Add it only if it becomes one.

## C. Blocking — infrastructure verification

Privacy §6 lists processor *categories*. Two are now named in the text as well
— **Anthropic** (AI) and **Expo Push Service** (push), both as "включая …", so
the category still governs and an added vendor of the same kind needs no new
version. But dropping or replacing a *named* vendor does: §5, §6.1 and Consent
§5 all carry the name. A separate internal processor register must name the
actual vendors, their location, and the contract in place.

**FCM and APNs are deliberately NOT named**: `fcm.provider.ts` and
`apns.provider.ts` are stubs whose `send()` returns `ok: true` without a request
(`TODO` in both), so no data reaches Google or Apple today. Naming them would
describe a transfer that does not happen. Add them to §5/§6.1 in the same
"включая" list at the moment either goes live.

Verified against the codebase on 2026-09-01:

| Processor category | Data sent | Source |
|---|---|---|
| Server/network infrastructure | everything in the system | VPS, PostgreSQL, Redis |
| Image storage & delivery | buyer profile photo (`mator/avatars`); **also, not buyer personal data:** seller product photos incl. the FLUX-enhanced copy (`mator/products`), seller sourcing-offer photos (`mator/sourcing`), dealer logos uploaded by admins (`mator/dealers`) | `src/user/avatar.service.ts`, `src/queue/queue.processors.ts`, `src/telegram/telegram-offer.service.ts`, `src/admin/dealers/` → `src/cloudinary/` (folders in `src/common/image.constants.ts`) |
| AI systems (Anthropic) | query text, selected vehicle (make/model/year/engine), conversation, and the VIN when the client supplies one — `ai-chat.service.ts:244` appends `[known VIN: …]` to the message | `src/ai-chat/`, `src/ai-advisor/` |
| SMS | phone number, message text | `src/sms/providers/` (Eskiz, Play Mobile, Sayqal) |
| Payment organisation | order id, amount, line items, fiscal data | `src/orders/webhooks/payme*` |
| Push delivery (Expo only) | push token, notification title/body, `data` payload incl. deeplink | `src/notifications/push/providers/expo.provider.ts` (FCM/APNs are stubs) |

Still to confirm before publication:

- [ ] Hosting location of the VPS, PostgreSQL and Redis → feeds A9
- [ ] Whether Cloudinary / the AI providers / the SMS providers process data
      outside Uzbekistan → feeds A9
- [ ] Whether any analytics or error-tracking SDK is live in the mobile client
      (none found server-side; the RN app must be checked separately). If one
      is live, Privacy §2 and §6 need a row for it
- [ ] FCM/APNs: both providers are stubs (`TODO` in each `send()`). Expo is the
      only live push route. When either goes live, add it to Privacy §5/§6.1 and
      Consent §5, and confirm where that provider processes the token (feeds A9)
- [ ] Data-processing agreements in place with each processor above

**Not processors (verified, do not list):**
- FLUX / `api.bfl.ai` — image enhancement runs **only** in the Telegram
  seller-listing pipeline (`src/queue/queue.processors.ts` →
  `ImageEnhanceService`). It receives seller product photos, not buyer personal
  data, so it is absent from Privacy §6. Revisit if buyer-supplied images are
  ever routed through it.
- PhotoRoom — not integrated anywhere in the codebase.

## D. Blocking — product/UX

- [ ] **Split the consent checkboxes.** Registration must present:
      - `[x]` Terms + Privacy Policy + Personal Data Consent (required)
      - `[ ]` Marketing messages (separate, **unchecked by default**, optional)

      Backend already enforces the required three
      (`REQUIRED_LEGAL_DOCUMENT_TYPES` in `src/legal/legal.service.ts`), and the
      marketing opt-in already exists: `notification_preferences.marketing`,
      **default `false`**, mapped to `NotificationType.MARKETING` and updatable
      via the preferences endpoint.

      What is missing is the registration-screen wiring: the marketing checkbox
      must be presented separately from the three required documents and written
      to that column.

- [ ] **DEFERRED — pending counsel.** Pre-purchase disclosure of the Seller's
      identity in the app. Consumer-protection law requires the buyer to see, in
      the app and *before* concluding the contract, who the Seller is (name,
      address, tax id, complaint channel) alongside the goods, price, payment,
      warranty and return terms. Terms §5.2.1 and §7.2 promise this disclosure
      and §11 puts the accuracy obligation on the Seller, but the surface itself
      is frontend + backend work that does not exist yet.

      **Held deliberately**: the wording of what exactly is shown, and the split
      between what Mator publishes and what the Seller warrants, is to be settled
      with counsel first. Do not build the screen or add Seller fields to the
      product API ahead of that decision.

- [ ] Marketing opt-out reachable in the app's notification settings
      (Terms §20.2, Privacy §8.3, Consent §11.3)
- [ ] Confirm the contact channel published in Terms §21.1 / Privacy §18 is one
      that is actually monitored. The documents deliberately point at the
      operator's contact details rather than an in-app support flow — **there is
      no support-request endpoint in the backend.**

## E. Account deletion — verified

`src/user/account-deletion.service.ts` matches Privacy §15.5–15.7.

Deleted outright: addresses, vehicles, cart, bookings, notifications +
preferences, devices (push tokens), AI sessions + messages, auth identities,
email verification tokens, refresh tokens. Anonymised in place: `app_users`
(email, phone, names, avatar), `orders.contact_phone_e164` → NULL,
`orders.delivery_address_id` → NULL, `order_status_history.actor_name` → NULL
for CUSTOMER rows, `legal_acceptances.ip_address`/`user_agent` → NULL. Avatar is
deleted from Cloudinary post-commit, best-effort.

Remaining gaps:

- [ ] **Application logs are not swept on deletion.** Privacy §15.8 states this
      explicitly (logs follow the technical-log retention period, not the
      deletion event). Confirm log retention is actually bounded —
      `RetentionService` currently prunes only `refresh_tokens` and
      `email_verification_tokens`, not logs.
- [ ] Confirm no PII is written to logs at a level that outlives §9.2's period
- [ ] Confirm what Cloudinary retains after `destroy()` (backups / CDN cache)
- [ ] Confirm the AI providers' retention for submitted prompts
- [ ] Confirm the SMS providers' retention for delivered message logs
- [ ] Confirm Payme's own retention (governed by their terms, not ours)

Note: the deletion service also clears `myid_verifications` and `myid_sessions`.
That is correct defensive behaviour and needs no documentation while the feature
is not part of the release.

## F. Translations

- [ ] `uz` translation of all three documents
- [ ] `en` translation of all three documents
- [ ] Legal review confirms the translations carry the same meaning

The seed ships `ru`, `uz`, `en` per document (`LOCALES` in the seed file). The
service falls back ru → any locale, so a missing translation degrades rather
than breaks — but publishing consent text in a language the user cannot read is
not acceptable for the required set.

## G. Publication

1. Close A–F.
2. The approved text goes in `docs/legal/<document>.v1.<locale>.md` — see
   `README.md` in this directory. **Not** in the seed: the seed reads these
   files.
3. Set `LEGAL_V1_EFFECTIVE_AT` (in `legal-documents.seed.ts`) to the agreed
   effective date. Publication state is the one thing markdown does not own.
4. Run `npm run seed`. It overwrites in place **only while the stored content is
   still a placeholder**, so this is safe to re-run until real text lands — and
   refuses to touch it afterwards, warning instead if a source file has since
   diverged.
5. Verify `GET /v1/legal/documents` returns all three at version 1.
6. Confirm `MobileConfigService` serves the legal URLs (it currently serves NULL
   by design while the text is placeholder).

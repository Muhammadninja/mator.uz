# Mator Backend — Release Checklist

Status of the backend-owned release gaps, and what is still owed by someone
other than the backend before App Store submission.

Last updated: 2026-08-02.

---

## 1. Legal content — Privacy Policy & Terms (BLOCKER, not backend-owned)

Apple requires a Privacy Policy URL in App Store Connect for every app, and the
app's legal screen currently shows placeholder text.

### What the backend provides

`GET /v1/app/config` (public, unauthenticated) carries the two URLs alongside the
existing force-update gate:

```json
{
  "min_supported_version": "1.0.0",
  "latest_version": "1.0.0",
  "ios_store_url": null,
  "android_store_url": "https://play.google.com/store/apps/details?id=com.mator.myapp",
  "privacy_policy_url": "https://mator.uz/legal/privacy",
  "terms_url": "https://mator.uz/legal/terms"
}
```

Both are driven by environment variables, so setting them needs a **restart, not
a deploy**:

| Variable                 | Meaning                                    |
| ------------------------ | ------------------------------------------ |
| `APP_PRIVACY_POLICY_URL` | Stable public Privacy Policy URL           |
| `APP_TERMS_URL`          | Stable public Terms & Conditions URL       |

> These two belong in `.env` / `.env.example` next to the other `APP_*` keys.

### The decision: LINK, do not store

The backend **does not store, host, or render the legal text**. It serves the
URLs only. Reasons:

- Apple needs a URL reachable **outside** the app (App Store Connect and the
  reviewer open it in a browser); a string served from an authenticated API
  cannot satisfy that.
- Legal documents are versioned, translated (UZ/RU/EN) and updated on a cadence
  that has nothing to do with API releases.
- Hosting them as static pages means no schema, no migration, and no deploy to
  correct a typo in a legal document.

### What remains, and who owns it

| # | Item | Owner | Status |
|---|------|-------|--------|
| 1 | Author the final Privacy Policy text (UZ/RU/EN as required) | Product / legal | **Outstanding** |
| 2 | Author the final Terms & Conditions text | Product / legal | **Outstanding** |
| 3 | Publish both at stable public URLs (e.g. `https://mator.uz/legal/privacy`, `.../terms`) — must be reachable unauthenticated, no redirect chain to a login | Product / web | **Outstanding** |
| 4 | Set `APP_PRIVACY_POLICY_URL` and `APP_TERMS_URL`, restart | Ops | Blocked on 3 |
| 5 | Enter the Privacy Policy URL in App Store Connect | Product | Blocked on 3 |
| 6 | Replace the app's placeholder Terms screen with a link to `terms_url` from `/v1/app/config` and hide the link while the value is `null` | Frontend | Blocked on 3 |

**No legal text has been invented or committed to this repository.** The two
values are `null` until a real document exists; a null is the client's signal to
hide the link, and is deliberately not a placeholder that could be mistaken for
an approved policy.

The Privacy Policy must describe what account deletion actually does (see §2)
— orders are retained with buyer PII anonymized — since that is a factual claim
about data handling the backend now guarantees.

---

## 2. Account deletion — DONE (backend)

`DELETE /v1/me`, app-user bearer token, `204 No Content`.

- **Refused with `409 ACCOUNT_HAS_ACTIVE_ORDERS`** while the user has an order
  in progress (`PENDING_PAYMENT`, `PAID`, `PROCESSING`, `SHIPPED` — every status
  the order state machine can still move on from) or an open Payme transaction
  (state 1, inside the 12-hour window). Nothing is anonymized or revoked then;
  the user can delete once those orders are delivered, cancelled, refunded or
  expired. Not covered by the backend change: how the mobile app presents this
  409, and whether the Privacy Policy (§15) should mention the rule.
- Deletes: addresses, garage vehicles, bookings, cart, notifications +
  preferences, devices (push tokens), AI sessions, auth identities, MyID
  sessions/verifications, email verification tokens, refresh tokens.
- **Retains orders** (financial/legal records: they carry payments, feed dealer
  GMV/settlement, and are subject to accounting retention) with buyer PII
  detached — `contact_phone_e164` and `delivery_address_id` nulled, and the
  actor-name snapshot cleared on the buyer's own status-history entries.
- Anonymizes the surviving `app_users` row irreversibly and marks `deleted_at`.
  The row cannot be dropped because `orders.user_id` is `NOT NULL` with
  `ON DELETE RESTRICT`.
- Revokes every session through the existing `TokenService.revokeAllSessions`
  (refresh family dropped + `token_version` bumped). `JwtStrategy` rejects any
  token whose user carries `deleted_at`, so the old access token 401s and the old
  refresh token cannot rotate.
- Destroys the Cloudinary avatar using the **stored** `avatar_public_id`.

There is **no favourites/likes table** in this schema — the app keeps them
client-side — so there is nothing of that kind to delete server-side.

---

## 3. Avatar persistence — DONE (backend)

See the investigation summary in `src/user/avatar.service.ts`. The upload path
itself was verified healthy (same Cloudinary account/credentials as products, no
upload preset, moderation, retention policy or cleanup job touching
`mator/avatars/*`). Two durability guarantees were added:

- the Cloudinary `public_id` is now **persisted** (`app_users.avatar_public_id`),
  so an avatar can be named and deleted precisely rather than parsed out of a URL;
- the secure URL is **verified reachable (HEAD) before it is persisted** — an
  unverifiable asset yields `502` and is never written to the database.

Replacing an avatar destroys the *previous* asset only, after the new one is
safely persisted.

---

## 4. Curated ratings — DONE (backend)

`PATCH /v1/admin/products/:id/rating` (admin token + role gate). Values live on
the supply-side `Product`, project through `CatalogProjectionService` into
`CatalogPart`, and surface to buyers as `rating_avg` (`number | null`) and
`review_count` (`number`).

Ratings are **curated admin data**. No review subsystem exists or is implied.

> **Frontend follow-up:** `services/search-service.ts` still derives a fake
> rating from a hash (`3.8 + (hashCode(item.id) % 12) / 10`). Now that the API
> returns real values, that line should read `rating_avg` / `review_count`
> instead. No fake or hash-derived rating exists anywhere in the backend.

---

## 5. Remaining work before release

Backend-owned gaps from this workstream are closed. What is left:

1. **Payment integration** — out of scope here.
2. **AI-chat backend** (`chat` domain) — out of scope here.
3. **Real DB fill / seeding** — categories & subcategories, brands, products,
   dealers, sales.
4. **Privacy Policy / Terms legal content** — §1 above; not backend code, but a
   hard App Store blocker.

5. **Courier delivery pricing** — before courier delivery can work, in this order:
   1. Review and set `DELIVERY_COVERAGE_POLYGON`: the approved area is Tashkent City, without
      its detached Mirzo Ulug'bek settlement, and the New Tashkent project territory, and
      nothing else in Tashkent Region, ready to copy from
      `config/delivery-coverage/delivery-coverage.env.txt` (see DEPLOYMENT.md). It is a
      practical boundary, not a cadastral one, so review it before supplying it.
      Until it is set, courier delivery stays off and pickup works: there is no default.
      Set `UZMAPS_API_KEY` with it, since boot is refused with an area and no key. The key
      needs UzMaps' search and geocoding products too, unless `UZMAPS_SEARCH_API_KEY` is
      set. Watch `mator_uzmaps_quota_used` and `mator_uzmaps_requests_total`.
   2. Apply migrations `20261105000000_order_delivery_shipments` and
      `20261105000100_delivery_destination_and_landmark`, then deploy the code.
   3. Record a pickup location for every seller whose goods should be deliverable:
      `PATCH /v1/admin/dealers/:id` with `pickupLat` and `pickupLng`. Nothing else writes
      these, and until they are set a courier is refused for that seller's goods with
      `PICKUP_LOCATION_MISSING`. Buyers can still choose pickup.
   4. Set `MARKETPLACE_TIN` to the 9-digit ИНН of ООО «MATOR INNOVATIONS». Until then Payme
      refuses every order that has a delivery cost. `DELIVERY_VAT_PERCENT` is no longer
      read: delivery's rate is fixed at 0, because the company pays turnover tax and is not
      registered for VAT.
   5. Release the app build that sends `delivery_method: 'courier'` and places orders with
      `delivery_quote_id`. The backend must already be live, or that build's courier quote
      is refused. Builds already installed keep offering pickup only. It needs a native
      build with `GOOGLE_MAPS_ANDROID_API_KEY` set for its Android map: see the app's
      docs/API_CONTRACT.md.
      The quote now answers pickup and the courier together, an unpriceable courier as
      `available: false` with its reason (200, no longer 422/503). Ship the app update that
      reads it with this backend: app code from before it shows such a courier as "try
      again" instead of its reason, while pickup keeps working.
   6. Show `shippingAddress.location` and `landmark` from the admin order detail to whoever
      dispatches couriers: that is the exact destination, and the admin panel has no map
      or field for it yet.

6. **Service fee** — every order above 100 000 of parts now carries one. In this order:
   1. Apply migration `20261105000200_service_fee_refunds_and_line_seller` (two additive
      columns), run `prisma generate`, build, then deploy the code.
   2. Set `SERVICE_FEE_MXIK` and `SERVICE_FEE_PACKAGE_CODE` (see DEPLOYMENT.md), and
      `MARKETPLACE_TIN` if it is not set yet. Until all three are valid, Payme refuses every
      order that carries a fee; cash and terminal orders still work. `SERVICE_FEE_VAT_PERCENT`
      is no longer read: the fee carries Mator's own rate, 0, like delivery.
   3. Release the app build that shows the fee and sends `confirmed_total_uzs`. Builds already
      installed show no fee line: they are charged the right total, but their screen does not
      add the fee in, so release the new build right after the backend.
   4. Refunds recorded by hand now take `serviceFeeUzs`, the part of the refund that is the
      fee. A refund that reaches into the fee is refused until it says so. The admin panel's
      refund form states it from the build with the Финансы section (see 7.4).

7. **Refunds and the seller ledger (Phase 3)** — no commission: Mator takes none from sellers.
   In this order:
   1. `20261106000000_seller_payout_audit_enum_values` and
      `20261106000100_refunds_payouts_and_commission` are additive and are applied in
      production (2026-11-06, the latter with checksum `61ac7920…7080da`, the file as committed
      in e4dbd32: never edit it). Existing refunds read as unattributed goods. The latter also
      added four commission columns, which nothing reads any more.
   2. Deploy the code without commission: run `prisma generate`, build, restart. It works with
      those four columns still in place, since each is nullable or defaults to 0.
   3. Only then apply `20261106000200_drop_dealer_commission`, which drops the four columns.
      Code first: the Phase 3 code read them and fails without them. The migration first
      refuses, changing nothing, if a commission was ever recorded (a dealer rate other than 0,
      or a line or refund allocation with a commission amount); none was on 2026-11-06.
   4. Manual refunds now take `deliveryUzs`, `allocations` (per seller) and `fiscalReference`
      besides `serviceFeeUzs`; a partial refund of an order with several sellers is refused
      until it says whose goods it was for. Refunds in cash, on a terminal or by transfer need
      a return receipt from Mator's own fiscal process: the registry issues none, and each
      such refund raises `refund_receipt_unconfirmed`.
   5. Sellers are paid only for delivered, paid orders with no hold and no unconfirmed Payme
      refund. A payout entry records a transfer already made outside the system.
   6. Deploy the admin panel build with the Финансы section (mator-admin): the summary, each
      seller's balance and payouts, one order's money, and the fiscal issues. Its refund form
      takes the new fields.
   7. Finance alerts reach whatever channels the queue monitor's alerts are configured for.
   8. Click stays off: production's `PAYMENT_PROVIDERS` must not list `click` (the default is
      now `payme` alone), and `CLICK_SECRET_KEY` stays unset.

8. **VAT rates** — no migration, code only:
   1. Remove `SERVICE_FEE_VAT_PERCENT` from the environment: it is no longer read. The service
      fee carries Mator's own rate, 0, like delivery (`MARKETPLACE_VAT_RATE`).
   2. A dealer's rate is still any value from 0 to 100 that an operator states (0, 4, 6, 12…).
      Changing it never changes a price: catalog prices are цена с учётом НДС, and the rate
      only goes on the receipt as `vat_percent`.

Production deployment and production migrations are performed manually by the
project owner.

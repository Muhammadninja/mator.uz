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
  "android_store_url": "https://play.google.com/store/apps/details?id=com.fotih12.mator",
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

Production deployment and production migrations are performed manually by the
project owner.

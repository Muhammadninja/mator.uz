# Legal documents

**The `.md` files in this directory are the source of truth for legal text.**
`npm run seed` reads them into the `legal_documents` table; the API serves that
table. Nobody edits legal wording in TypeScript, and nobody edits it in the
database.

```
docs/legal/*.md  →  loader  →  seed  →  PostgreSQL  →  LegalService  →  API  →  app
```

The API never reads this directory. Runtime responses come from PostgreSQL, so a
served document does not depend on the filesystem — markdown is a seed-time
artefact only.

## File naming

```
<document>.v<version>.<locale>.md
```

| Document | Slug | Type |
|---|---|---|
| Terms of Use | `terms-of-use` | `TERMS_OF_USE` |
| Privacy Policy | `privacy-policy` | `PRIVACY_POLICY` |
| Personal Data Consent | `personal-data-consent` | `PERSONAL_DATA_CONSENT` |
| Refund & Returns Policy | `refund-policy` | `REFUND_POLICY` |

The first three are the consent set: `GET /v1/legal/documents` returns them and
registration requires accepting them (`REQUIRED_LEGAL_DOCUMENT_TYPES`). The
Refund & Returns Policy is informational — never accepted — and is read with
`GET /v1/legal/documents/REFUND_POLICY`, which serves the version in force of
any type.

Locales: `ru`, `uz`, `en`. Every document must exist in **every** locale at its
highest version — 12 files for v1. A missing translation fails the seed rather
than shipping, because a partial set would ask Uzbek users to consent to v1
while Russian users consent to v2.

Files that do not match the pattern (this README, the checklist) are ignored.

## Front matter

Every source file starts with:

```yaml
---
type: PRIVACY_POLICY
version: 1
locale: ru
title: "Политика конфиденциальности"
---
```

All four keys are required. Any other key is rejected — in particular
`effective_at` and `is_active`: the effective date comes from the text itself
(below), and which version is active is decided by the seed and the database.

## Effective date

The date users read is the date stored: `effective_at` is taken from the
document's own line

| Locale | Line |
|---|---|
| `en` | `**Effective Date:** 01.09.2026` |
| `ru` | `**Дата вступления в силу:** 01.09.2026` |
| `uz` | `**Kuchga kirish sanasi:** 01.09.2026` |

and stored as that calendar date at 00:00 UTC. A text whose line still reads
`__.__.____` (or has no such line) is a **draft and is not published**. The
seed refuses a malformed date, two different dates in one text, and locales of
one version that disagree (including one dated and one still blank).

The version appears in both the filename and the front matter, and they must
agree. The filename carries it so a directory listing shows which versions
exist; the front matter carries it because a filename is a convention a rename
can silently break. A disagreement is a hard error — guessing which one the
author meant is not something this loader should do.

## Updating text

**Publishing on production:** use `npm run seed:legal`, never `npm run seed`
(the full seed rewrites dealers, categories and other reference data).
`seed:legal` touches only `legal_documents`, is a dry run by default, and with
`-- --apply` writes its plan in one transaction:

```
npm run seed:legal              # prints the plan, writes nothing
npm run seed:legal -- --apply   # writes exactly that plan
```

Re-running it is safe: an up-to-date database plans no writes.

**Before a document is published** (the row still holds
`[PLACEHOLDER: FINAL LEGAL TEXT REQUIRED]`):

1. Edit the `.md`.
2. `npm run seed:legal -- --apply`.

The seed replaces placeholder rows in place. No code change, no version bump.

**After a document is published and users have accepted it:** the text is
frozen. Editing the `.md` does **not** change the database — the seed detects
the divergence, leaves the row alone, and prints a warning naming the file. This
is deliberate: an acceptance record that points at rewritten text proves nothing.

## Creating v2

1. Copy `privacy-policy.v1.ru.md` → `privacy-policy.v2.ru.md`.
2. Set `version: 2` in the front matter.
3. Do the same for **every** locale — `uz` and `en` too, or the seed fails.
4. Leave the v1 files in place. They are the text existing users accepted, and
   `GET /v1/legal/documents/:type/:version` still serves them.
5. Fill in its effective date in every locale, then `npm run seed:legal -- --apply`
   creates the v2 rows (inactive while v1 is in force).

Activating v2 (and deactivating v1) is a database operation, not a file edit.
Only one version per `(type, locale)` may be active — enforced by a partial
unique index.

## Translations

`uz` and `en` currently hold placeholders. To translate: replace the body, keep
the front matter, change nothing else. The file must exist even while
untranslated — the seed requires the complete set, and the placeholder marker is
what stops unapproved text from counting as published.

## What must never be edited directly in the database

- `content`, `title` — these come from the `.md`. A manual `UPDATE` would be
  silently reverted-or-not depending on placeholder state, and would leave no
  reviewable diff.
- Acceptance rows in `legal_acceptances` — they are consent evidence.

`isActive` **is** database-owned, and is the only field a release process
should change by hand. `effectiveAt` follows the text: the seed sets it on
creation and corrects a stored date that differs from the one the text states
(never on a row whose published text has diverged from its file).

## Ownership summary

| Field | Owner |
|---|---|
| `type`, `version`, `locale`, `title` | markdown front matter |
| `content` | markdown body |
| `effectiveAt` | the text's effective-date line |
| `isActive` | seed logic + database |

## Related code

- `src/prisma/seed-data/legal-documents.loader.ts` — reads and validates sources
- `src/prisma/seed-data/legal-seed-decision.ts` — the overwrite rules
- `src/prisma/seed-data/legal-documents.publish.ts` — plan + apply, the only
  writer of `legal_documents` (used by `seed.ts` and `seed-legal.ts`)
- `src/legal/` — the runtime API (reads the database, never this directory)
- `00-PRE-PUBLICATION-CHECKLIST.md` — what must close before v1 ships

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

Locales: `ru`, `uz`, `en`. Every document must exist in **every** locale at its
highest version — 9 files for v1. A missing translation fails the seed rather
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
`effective_at` and `is_active`, which are **publication state** owned by the
seed and the database, not by a source file (see below).

The version appears in both the filename and the front matter, and they must
agree. The filename carries it so a directory listing shows which versions
exist; the front matter carries it because a filename is a convention a rename
can silently break. A disagreement is a hard error — guessing which one the
author meant is not something this loader should do.

## Updating text

**Before a document is published** (the row still holds
`[PLACEHOLDER: FINAL LEGAL TEXT REQUIRED]`):

1. Edit the `.md`.
2. `npm run seed`.

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
5. `npm run seed` creates the v2 rows.

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

`effectiveAt` and `isActive` **are** database-owned, and are the only fields a
release process should change by hand.

## Ownership summary

| Field | Owner |
|---|---|
| `type`, `version`, `locale`, `title` | markdown front matter |
| `content` | markdown body |
| `effectiveAt` | seed (`LEGAL_V1_EFFECTIVE_AT`) |
| `isActive` | seed logic + database |

## Related code

- `src/prisma/seed-data/legal-documents.loader.ts` — reads and validates sources
- `src/prisma/seed-data/legal-seed-decision.ts` — the overwrite rules
- `src/prisma/seed.ts` → `seedLegalDocuments()` — writes to the database
- `src/legal/` — the runtime API (reads the database, never this directory)
- `00-PRE-PUBLICATION-CHECKLIST.md` — what must close before v1 ships

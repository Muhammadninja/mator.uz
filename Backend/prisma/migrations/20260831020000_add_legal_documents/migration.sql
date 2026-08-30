-- Legal documents and user consent records.
--
-- Purely ADDITIVE: one new enum and two new tables. No existing table is
-- altered, no column is dropped, renamed or retyped, and no data is backfilled.
-- Every existing row and every existing query keeps its exact meaning.
--
-- ── Two tables, two jobs ──
-- `legal_documents`   holds the TEXT of one version of one document per locale.
-- `legal_acceptances` holds the PROOF that one user accepted one version, once.
--
-- They are deliberately not merged. A document version is immutable content; an
-- acceptance is evidence about a person at a point in time. Publishing v2 must
-- never mutate v1, because an acceptance that points at rewritten text proves
-- nothing.

CREATE TYPE "LegalDocumentType" AS ENUM (
  'TERMS_OF_USE',
  'PRIVACY_POLICY',
  'PERSONAL_DATA_CONSENT'
);

CREATE TABLE "legal_documents" (
  -- No DB-side default: Prisma's @default(uuid()) generates the id in the client,
  -- exactly as every other UUID table in this schema does. Keeps the migration
  -- free of any dependency on pgcrypto / gen_random_uuid() being installed.
  "id"             UUID NOT NULL,
  "type"           "LegalDocumentType" NOT NULL,
  "version"        INTEGER NOT NULL,
  -- Lowercase wire language code ('ru' | 'uz' | 'en'), matching
  -- common/app-lang.util. Stored as text rather than the `Language` enum so
  -- adding a locale is a data row, not a schema migration.
  "locale"         VARCHAR(8) NOT NULL,
  "title"          VARCHAR(300) NOT NULL,
  "content"        TEXT NOT NULL,
  "content_format" VARCHAR(20) NOT NULL DEFAULT 'markdown',
  "is_active"      BOOLEAN NOT NULL DEFAULT false,
  "effective_at"   TIMESTAMPTZ(3) NOT NULL,
  "created_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "legal_documents_pkey" PRIMARY KEY ("id")
);

-- One row per (document, version, language). `version` is shared across
-- locales on purpose: TERMS_OF_USE v2 is the SAME instrument in ru and uz, so
-- accepting it in either language is accepting v2.
CREATE UNIQUE INDEX "legal_documents_type_version_locale_key"
  ON "legal_documents" ("type", "version", "locale");

-- The lookup every request makes: "the current document of this type in this
-- language".
CREATE INDEX "legal_documents_type_locale_is_active_idx"
  ON "legal_documents" ("type", "locale", "is_active");

-- THE core invariant, enforced by the database rather than by convention:
-- at most ONE active version may exist per (type, locale). Two simultaneously
-- active versions would make "which version is required?" ambiguous, and the
-- answer to that question is what every acceptance is validated against.
--
-- This is a PARTIAL unique index (`WHERE is_active`), which Prisma's schema
-- language cannot express — hence hand-written here. It is intentionally
-- absent from schema.prisma: adding it there is impossible, and `prisma migrate
-- diff` therefore does not consider it drift (it only sees indexes it can
-- model). LegalService publishes through this constraint inside a transaction,
-- so a concurrent double-publish fails loudly instead of silently corrupting
-- the required-version answer.
CREATE UNIQUE INDEX "legal_documents_one_active_per_type_locale"
  ON "legal_documents" ("type", "locale")
  WHERE "is_active";

CREATE TABLE "legal_acceptances" (
  "id"               UUID NOT NULL,
  "user_id"          UUID NOT NULL,
  "document_id"      UUID NOT NULL,
  -- Duplicates legal_documents.version deliberately: an acceptance must stay
  -- readable as "accepted v1" from the row alone, with no join and no
  -- dependence on the document row still saying what it said at the time.
  "document_version" INTEGER NOT NULL,
  "accepted_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Request provenance, captured server-side from the trusted proxy hop
  -- (`trust proxy` is set in main.ts) and never accepted from the request body.
  -- This is what makes the row evidence rather than a client assertion.
  -- Nullable: a proxy may withhold the address, a client may send no UA.
  "ip_address"       VARCHAR(45),
  "user_agent"       VARCHAR(500),
  -- The language the document was actually presented in.
  "locale"           VARCHAR(8),

  CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("id")
);

-- Deleting the user deletes their consent records along with the rest of their
-- personal data.
ALTER TABLE "legal_acceptances"
  ADD CONSTRAINT "legal_acceptances_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "app_users" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, not CASCADE: a document version somebody has accepted must not be
-- deletable, because deleting it would destroy the evidence these rows exist to
-- hold. Superseding a version is done by publishing a new one, never by
-- removing the old one.
ALTER TABLE "legal_acceptances"
  ADD CONSTRAINT "legal_acceptances_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "legal_documents" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- There is deliberately NO unique constraint on (user_id, document_id): a user
-- accepts v1, then later v2, and BOTH rows must survive — the consent history is
-- the audit trail. Re-submitting the same version is deduplicated in the service
-- layer (retry-safe) rather than forbidden by the schema.
CREATE INDEX "legal_acceptances_user_id_idx"
  ON "legal_acceptances" ("user_id");

CREATE INDEX "legal_acceptances_document_id_idx"
  ON "legal_acceptances" ("document_id");

CREATE INDEX "legal_acceptances_user_id_document_version_idx"
  ON "legal_acceptances" ("user_id", "document_version");

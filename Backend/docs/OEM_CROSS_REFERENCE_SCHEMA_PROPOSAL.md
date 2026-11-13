# OEM cross-reference: schema proposal (Wave 4)

Status: **proposal only, not implemented.** `prisma/schema.prisma` is unchanged, no migration exists, and
nothing writes these tables. The Wave 4 pipeline (`src/prisma/oem-xref/`) only validates a dataset and
prints a dry-run. This document describes the storage a later, separately approved import would need.

## Why the existing schema cannot hold it

| Existing place | What it is | Why not for cross-reference |
|---|---|---|
| `oem_compatibility` (`OemCompatibility`) | OEM number → vehicle make + model | It is **fitment**, not number-to-number. It has no second number, no relation type, no status, no source. Writing a cross-reference there would turn the claim into vehicle compatibility, which the brief forbids. No code in `src/` reads it today. |
| `catalog_parts.oem_numbers` / `gm_numbers` | the numbers one listing is sold under (search index) | One listing only. Adding a "related" number here would make buyer search return the listing for a number it was never sold under, with no record of why. |
| `products.source_part_number` | the source cell, verbatim | Provenance of the listing, not of a relation. |

The relation also needs things no column has: relation type, direction, review status, rejection reason,
and one or more sources with an exact locator.

## Proposed model (example)

```prisma
enum OemXrefStatus {
  CANDIDATE
  VERIFIED
  REJECTED
}

enum OemXrefRelation {
  SAME_PART             // symmetric
  SUPERSEDED_BY         // from = old number, to = new number, same manufacturer
  OFFICIAL_REPLACEMENT  // `to` approved instead of `from`; one way
  INTERCHANGEABLE       // symmetric
}

enum OemXrefEvidenceType {
  MANUFACTURER_CATALOG
  SUPERSESSION_BULLETIN
  LICENSED_CATALOG
}

model OemCrossReference {
  id                   String           @id @db.VarChar(64)          // dataset record id, e.g. xref-0001
  status               OemXrefStatus
  relation             OemXrefRelation?                              // required when VERIFIED (CHECK)
  fromPartId           String           @map("from_part_id") @db.VarChar(64)
  fromManufacturer     String           @map("from_manufacturer") @db.VarChar(120)
  fromManufacturerKey  String           @map("from_manufacturer_key") @db.VarChar(120)
  fromPartNumber       String           @map("from_part_number") @db.VarChar(64)   // as the source prints it
  fromNormalized       String           @map("from_normalized") @db.VarChar(64)    // normalizeOem, leading zeros kept
  toPartId             String           @map("to_part_id") @db.VarChar(64)
  toManufacturer       String           @map("to_manufacturer") @db.VarChar(120)
  toManufacturerKey    String           @map("to_manufacturer_key") @db.VarChar(120)
  toPartNumber         String           @map("to_part_number") @db.VarChar(64)
  toNormalized         String           @map("to_normalized") @db.VarChar(64)
  basis                String?          @db.VarChar(40)                // SAME_GM_NUMBER | REVIEWER_SUGGESTION
  rejectionReason      String?          @map("rejection_reason") @db.VarChar(40)   // required when REJECTED (CHECK)
  rejectionDetail      String?          @map("rejection_detail") @db.Text
  reviewedBy           String?          @map("reviewed_by") @db.VarChar(80)
  reviewedOn           DateTime?        @map("reviewed_on") @db.Date
  note                 String           @default("") @db.Text
  datasetName          String           @map("dataset_name") @db.VarChar(40)       // which dataset wrote it
  datasetFormatVersion Int              @map("dataset_format_version")
  createdAt            DateTime         @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt            DateTime         @updatedAt @map("updated_at") @db.Timestamptz(3)
  evidence             OemCrossReferenceEvidence[]

  // A symmetric relation is stored with (from, to) in a fixed order, so the
  // unique key also catches the reversed duplicate.
  @@unique([fromPartId, fromManufacturerKey, fromNormalized, toPartId, toManufacturerKey, toNormalized, relation])
  @@index([fromManufacturerKey, fromNormalized])
  @@index([toManufacturerKey, toNormalized])
  @@index([status])
  @@map("oem_cross_references")
}

model OemCrossReferenceEvidence {
  id               Int                 @id @default(autoincrement())
  crossReferenceId String              @map("cross_reference_id") @db.VarChar(64)
  type             OemXrefEvidenceType
  publisher        String              @db.VarChar(160)
  documentId       String              @map("document_id") @db.VarChar(200)
  url              String?             @db.Text
  locator          String              @db.VarChar(200)
  retrievedOn      DateTime            @map("retrieved_on") @db.Date
  licence          String?             @db.VarChar(200)                  // required for LICENSED_CATALOG (CHECK)
  citedFrom        String              @map("cited_from") @db.VarChar(64) // as printed in the source
  citedTo          String              @map("cited_to") @db.VarChar(64)
  asserts          String              @db.VarChar(40)                   // a relation or NO_RELATION
  statement        String              @db.Text
  crossReference   OemCrossReference   @relation(fields: [crossReferenceId], references: [id], onDelete: Cascade)

  @@index([crossReferenceId])
  @@map("oem_cross_reference_evidence")
}
```

CHECK constraints for the migration (Prisma cannot express them):
`status <> 'VERIFIED' OR relation IS NOT NULL`, `status <> 'REJECTED' OR rejection_reason IS NOT NULL`,
`relation <> 'SUPERSEDED_BY' OR from_manufacturer_key = to_manufacturer_key`, and for evidence
`type <> 'LICENSED_CATALOG' OR licence IS NOT NULL`. A VERIFIED row with no evidence row cannot be blocked by
a CHECK; the import refuses it (as the dry-run already does).

## Decisions needed before implementing

1. **Foreign keys to `catalog_parts`.** With FKs, `CatalogPart` gains two back-relation fields, which changes an
   existing model, and a delete must be `Restrict` or `Cascade`. Without FKs, the import checks the ids and the
   read-only report lists orphans. The proposal above leaves FKs out for that reason.
2. **Number-level or listing-level.** A supersession is a fact about two numbers. The proposal attaches it to
   listings because that is what the catalog can check. A pure number-level table, with listings resolved at
   read time, is the alternative.
3. **Who may read it.** Nothing buyer-facing reads these tables. Showing even a VERIFIED relation to buyers
   (for example "replaces GM 96475028") is a separate product decision. It must never feed the Wave 3 fitment
   resolver (`vehicle-fitment.ts`), `fitment_bindings`, `catalog_part_fits`, `is_universal` or a category.

## Import order (when approved)

Deploy the migration, then the code. Run `npm run oem-xref:dry-run` on a fresh read-only snapshot. A separate
`--apply` would write only the records the dry-run lists under section 8, in one transaction. It is
idempotent on `id` and never edits a catalog part.

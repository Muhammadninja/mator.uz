-- Additive, owner-scoped buyer favorites. No existing rows are rewritten.
CREATE TABLE "user_favorites" (
    "user_id" UUID NOT NULL,
    "part_id" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_favorites_pkey" PRIMARY KEY ("user_id", "part_id")
);

CREATE INDEX "user_favorites_user_id_created_at_part_id_idx"
ON "user_favorites"("user_id", "created_at", "part_id");

ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_part_id_fkey"
FOREIGN KEY ("part_id") REFERENCES "catalog_parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Durable owner-scoped receipts prevent a lost-response import retry from
-- restoring a favorite the user removed after the first application.
CREATE TABLE "favorite_imports" (
    "user_id" UUID NOT NULL,
    "import_id" VARCHAR(128) NOT NULL,
    "payload_hash" VARCHAR(64) NOT NULL,
    "accepted_ids" TEXT[] NOT NULL,
    "missing_ids" TEXT[] NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "favorite_imports_pkey" PRIMARY KEY ("user_id", "import_id")
);
ALTER TABLE "favorite_imports" ADD CONSTRAINT "favorite_imports_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

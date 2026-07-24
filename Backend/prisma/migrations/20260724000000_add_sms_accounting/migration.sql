-- Adds the SMS accounting + operator-pricing layer (analytics + future delivery
-- tracking). Purely ADDITIVE: three NEW tables, zero changes to any existing
-- table, so the live OTP / Sayqal send path is byte-for-byte untouched.
--
-- sms_messages rows are written at send time with status='pending'. Delivery
-- callbacks are NOT implemented yet; when they are, they simply UPDATE status →
-- 'delivered' | 'failed' and fill delivered_at (and optionally the provider ids /
-- parts) — no further schema change required.
--
-- operator_name / price_uzs on sms_messages are SNAPSHOTS taken at send time and
-- must never be recomputed from sms_operators, so historical SMS cost stays
-- immutable against later price edits. The FK to sms_operators is ON DELETE SET
-- NULL precisely so deleting an operator can never erase a historical record.

-- CreateTable
CREATE TABLE "sms_operators" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "display_name" VARCHAR(80) NOT NULL,
    "price_uzs" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sms_operators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_operator_prefixes" (
    "id" SERIAL NOT NULL,
    "operator_id" INTEGER NOT NULL,
    "prefix" VARCHAR(8) NOT NULL,

    CONSTRAINT "sms_operator_prefixes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_messages" (
    "id" SERIAL NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "provider_transaction_id" VARCHAR(120),
    "provider_sms_id" VARCHAR(120),
    "phone_e164" VARCHAR(20) NOT NULL,
    "operator_id" INTEGER,
    "operator_name" VARCHAR(40),
    "price_uzs" INTEGER,
    "template" VARCHAR(60),
    "parts" INTEGER,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "error_code" VARCHAR(40),
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ(3),

    CONSTRAINT "sms_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sms_operators_name_key" ON "sms_operators"("name");

-- CreateIndex
CREATE UNIQUE INDEX "sms_operator_prefixes_prefix_key" ON "sms_operator_prefixes"("prefix");

-- CreateIndex
CREATE INDEX "sms_operator_prefixes_operator_id_idx" ON "sms_operator_prefixes"("operator_id");

-- CreateIndex
CREATE INDEX "sms_messages_status_idx" ON "sms_messages"("status");

-- CreateIndex
CREATE INDEX "sms_messages_operator_id_idx" ON "sms_messages"("operator_id");

-- CreateIndex
CREATE INDEX "sms_messages_created_at_idx" ON "sms_messages"("created_at");

-- CreateIndex
CREATE INDEX "sms_messages_phone_e164_idx" ON "sms_messages"("phone_e164");

-- AddForeignKey
ALTER TABLE "sms_operator_prefixes" ADD CONSTRAINT "sms_operator_prefixes_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "sms_operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "sms_operators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Checkout idempotency: one order per (buyer, Idempotency-Key).
-- Additive only: a new table, nothing existing is altered. Apply BEFORE deploying the code
-- that reads the header; the previous code never touches this table.

-- CreateTable
CREATE TABLE "order_idempotency" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "order_id" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_idempotency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_idempotency_order_id_key" ON "order_idempotency"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_idempotency_user_id_idempotency_key_key" ON "order_idempotency"("user_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "order_idempotency" ADD CONSTRAINT "order_idempotency_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_idempotency" ADD CONSTRAINT "order_idempotency_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

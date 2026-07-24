-- Adds an append-only order status audit trail (admin order details "status
-- history"). Purely ADDITIVE: one NEW enum + one NEW table, zero changes to any
-- existing table, so the existing rows/columns are byte-for-byte untouched.
--
-- Every order status change writes exactly one row here, through the single
-- OrderStatusService chokepoint (creation, operator PATCH, payment PAID/CANCELLED
-- webhooks, and the expiry cron) — so history is the complete, authoritative FSM
-- record. actor_id / actor_name are SNAPSHOTS taken at write time — like the SMS
-- accounting operator_name snapshot — so entries stay immutable against later
-- profile edits or user deletion. SYSTEM (automated) transitions leave the actor
-- columns null. The FK to orders is ON DELETE CASCADE: history dies with its
-- order, never orphaned. Indexed by order_id — the only access path (details).

-- CreateEnum
CREATE TYPE "OrderActorType" AS ENUM ('SYSTEM', 'CUSTOMER', 'OPERATOR', 'ADMIN');

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" VARCHAR(64) NOT NULL,
    "order_id" VARCHAR(64) NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "note" VARCHAR(500),
    "actor_type" "OrderActorType" NOT NULL DEFAULT 'SYSTEM',
    "actor_id" UUID,
    "actor_name" VARCHAR(120),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_status_history_order_id_idx" ON "order_status_history"("order_id");

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

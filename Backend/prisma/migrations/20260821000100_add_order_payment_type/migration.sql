-- Records the payment method the customer chose at checkout (PAYME = online,
-- TERMINAL = card reader on delivery, CASH = cash on delivery). Purely ADDITIVE
-- and nullable: existing orders stay valid (payment_type = NULL) and no current
-- endpoint, index or constraint is altered. The Payme/Click webhook and order
-- reporting read this to know the intended method.

-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('PAYME', 'TERMINAL', 'CASH');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "payment_type" "PaymentType";

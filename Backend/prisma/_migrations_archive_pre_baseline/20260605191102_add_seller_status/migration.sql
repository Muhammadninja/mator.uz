-- CreateEnum
CREATE TYPE "SellerStatus" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED');

-- AlterTable
ALTER TABLE "sellers" ADD COLUMN     "status" "SellerStatus" NOT NULL DEFAULT 'PENDING';

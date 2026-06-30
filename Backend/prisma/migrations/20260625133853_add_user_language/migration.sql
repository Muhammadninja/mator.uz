-- CreateEnum
CREATE TYPE "Language" AS ENUM ('RU', 'UZ', 'EN');

-- AlterTable
ALTER TABLE "app_users" ADD COLUMN "language" "Language" NOT NULL DEFAULT 'UZ';
